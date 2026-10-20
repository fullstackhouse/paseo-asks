import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

/**
 * Stands in for api.anthropic.com. `record` forwards every request and keeps the response;
 * `replay` answers from the cassette and never touches the network.
 *
 * Requests are matched by a key over what the model saw, with the parts that change between
 * machines and runs taken out (paths, ids, dates, the environment block in the system prompt).
 */
export type Mode = "record" | "replay";

type Entry = { key: string; request: unknown; status: number; contentType: string; body: string };

export type Proxy = {
  url: string;
  /** Requests replay could not answer, with what was asked, to diff against the cassette. */
  misses: { key: string; request: unknown }[];
  close(): Promise<void>;
};

const UPSTREAM = "https://api.anthropic.com";
// Response headers that must not be copied: the body is re-sent decoded and whole.
const HOP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

export async function startProxy(options: { mode: Mode; cassette: string; scrub: string[] }): Promise<Proxy> {
  const { mode, cassette } = options;
  const recorded: Entry[] = mode === "replay" && existsSync(cassette) ? JSON.parse(readFileSync(cassette, "utf8")).entries : [];
  const served = new Map<string, number>();
  const kept: Entry[] = [];
  const misses: Proxy["misses"] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `e2e proxy: ${req.url}` } }));
    }
    const request = canonical(JSON.parse(raw.toString("utf8")), options.scrub);
    const key = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16);

    if (mode === "replay") {
      // The same request can come twice (a retry, a repeated step); serve the takes in order.
      const takes = recorded.filter((entry) => entry.key === key);
      const take = takes[Math.min(served.get(key) ?? 0, takes.length - 1)];
      served.set(key, (served.get(key) ?? 0) + 1);
      if (!take) {
        misses.push({ key, request });
        // 400, not 5xx: Claude Code retries server errors with backoff, which would only slow the failure.
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `e2e cassette miss ${key}; re-record with npm run record` } }));
      }
      res.writeHead(take.status, { "content-type": take.contentType });
      return res.end(take.body);
    }

    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => name !== "host" && !HOP_HEADERS.has(name)),
    ) as Record<string, string>;
    const upstream = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: raw });
    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    kept.push({ key, request, status: upstream.status, contentType, body });
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP_HEADERS.has(name)) out[name] = value;
    });
    res.writeHead(upstream.status, out);
    res.end(body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    misses,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (mode !== "record") return;
      mkdirSync(dirname(cassette), { recursive: true });
      writeFileSync(cassette, JSON.stringify({ entries: kept }, null, 2) + "\n");
    },
  };
}

/**
 * What identifies a request: the model, which system prompt (by its opening, since the rest
 * describes the machine), and the conversation. Tool definitions and metadata are left out.
 */
export function canonical(body: any, scrub: string[]): unknown {
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((block: any) => block.text ?? "").join("\n");
  return {
    model: body.model,
    system: scrubText(system, scrub).slice(0, 120),
    messages: (body.messages ?? []).map((message: any) => ({
      role: message.role,
      content: typeof message.content === "string" ? scrubText(message.content, scrub) : message.content.map((block: any) => scrubBlock(block, scrub)).filter(Boolean),
    })),
  };
}

function scrubBlock(block: any, scrub: string[]): unknown {
  switch (block.type) {
    case "text": {
      const text = scrubText(block.text, scrub);
      return text ? { type: "text", text } : null;
    }
    case "tool_use":
      return { type: "tool_use", name: block.name, input: scrubValue(block.input, scrub) };
    case "tool_result":
      return { type: "tool_result", content: scrubValue(block.content, scrub) };
    // Thinking text and signatures come back verbatim from the cassette, but are noise for matching.
    case "thinking":
    case "redacted_thinking":
      return null;
    default:
      return scrubValue(block, scrub);
  }
}

function scrubValue(value: unknown, scrub: string[]): unknown {
  if (typeof value === "string") return scrubText(value, scrub);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, scrub));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => name !== "cache_control" && name !== "id" && name !== "tool_use_id")
        .map(([name, item]) => [name, scrubValue(item, scrub)]),
    );
  }
  return value;
}

function scrubText(text: string, scrub: string[]): string {
  let out = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  for (const path of scrub) out = out.split(path).join("<root>");
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\bwks_[0-9a-f]+/g, "<workspace>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .trim();
}
