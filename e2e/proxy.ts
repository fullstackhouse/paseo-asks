import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

/**
 * Stands in for api.anthropic.com. `record` forwards every request (to OpenRouter,
 * adding the credentials itself) and keeps the response; `replay` answers from the cassette and
 * never touches the network. Either way the sandbox only ever holds a dummy key.
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
  /** Every request answered so far, in canonical form, e.g. to wait for a particular call. */
  answered: Canonical[];
  close(): Promise<void>;
};

/** Where record mode sends requests, and how it authenticates. */
export type Upstream = { url: string; headers: Record<string, string>; model?: (model: string) => string };

export function upstreamFromEnv(env: NodeJS.ProcessEnv): Upstream {
  if (!env.OPENROUTER_API_KEY) throw new Error("Recording needs OPENROUTER_API_KEY, in the environment or e2e/.env");
  return {
    url: "https://openrouter.ai/api",
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    // Claude Code asks for Anthropic ids (claude-haiku-5-5); OpenRouter routes by its own names.
    model: (model) => `~anthropic/claude-${model.match(/haiku|sonnet|opus/)?.[0] ?? "haiku"}-latest`,
  };
}

// Request headers the proxy replaces: the sandbox's dummy key must not reach the upstream.
const AUTH_HEADERS = new Set(["authorization", "x-api-key"]);
// Response headers that must not be copied: the body is re-sent decoded and whole.
const HOP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

/** Recorded responses hold the sandbox path as this placeholder; replay puts the current sandbox path back. */
const ROOT = "__E2E_ROOT__";

/** `root` is the sandbox directory: scrubbed from match keys, and swapped for ROOT in recorded responses. */
export async function startProxy(options: { mode: Mode; cassette: string; root: string; upstream?: Upstream }): Promise<Proxy> {
  const { mode, cassette } = options;
  const recorded: Entry[] = mode === "replay" && existsSync(cassette) ? JSON.parse(readFileSync(cassette, "utf8")).entries : [];
  const served = new Map<string, number>();
  const kept: Entry[] = [];
  const misses: Proxy["misses"] = [];
  const answered: Canonical[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `e2e proxy: ${req.url}` } }));
    }
    const parsed = JSON.parse(raw.toString("utf8"));
    const request = canonical(parsed, options.root);
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
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `e2e cassette miss ${key}; re-record with npm run e2e:record` } }));
      }
      res.writeHead(take.status, { "content-type": take.contentType });
      // A replayed tool call must point into this run's sandbox, not the recording's.
      res.end(take.body.split(ROOT).join(options.root));
      answered.push(request);
      return;
    }

    const target = options.upstream!;
    const headers = {
      ...(Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => name !== "host" && !HOP_HEADERS.has(name) && !AUTH_HEADERS.has(name)),
      ) as Record<string, string>),
      ...target.headers,
    };
    const body = target.model ? JSON.stringify({ ...parsed, model: target.model(parsed.model) }) : raw;
    const upstream = await fetch(target.url + req.url, { method: req.method, headers, body });
    const answer = await upstream.text();
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP_HEADERS.has(name)) out[name] = value;
    });
    res.writeHead(upstream.status, out);
    res.end(answer);
    answered.push(request);
    const stored = contentType.includes("event-stream") ? coalesce(answer) : answer;
    kept.push({ key, request, status: upstream.status, contentType, body: stored.split(options.root).join(ROOT) });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error("[e2e proxy]", error);
      if (res.headersSent) return void res.end();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    misses,
    answered,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (mode !== "record") return;
      mkdirSync(dirname(cassette), { recursive: true });
      writeFileSync(cassette, JSON.stringify({ entries: kept }, null, 2) + "\n");
    },
  };
}

/**
 * Merges each content block's streamed deltas into one, so values split across chunks (a path in a
 * tool call's input) can be found and swapped, and cassettes stay readable.
 */
export function coalesce(sse: string): string {
  const events = sse.split(/\n\n+/).filter((event) => event.trim());
  const out: string[] = [];
  const pending = new Map<number, { index: number; delta: Record<string, string> }>();
  const field: Record<string, string> = { text_delta: "text", input_json_delta: "partial_json", thinking_delta: "thinking" };
  const emit = (index: number) => {
    const merged = pending.get(index);
    if (!merged) return;
    pending.delete(index);
    out.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", ...merged })}`);
  };
  for (const event of events) {
    const data = /^data: (.*)$/m.exec(event)?.[1];
    // OpenRouter ends the stream with `data: [DONE]`; only JSON objects can be deltas.
    const parsed = data?.startsWith("{") ? JSON.parse(data) : null;
    const key = parsed?.type === "content_block_delta" ? field[parsed.delta?.type] : undefined;
    if (key) {
      const merged = pending.get(parsed.index) ?? { index: parsed.index, delta: { type: parsed.delta.type, [key]: "" } };
      merged.delta[key] += parsed.delta[key];
      pending.set(parsed.index, merged);
      continue;
    }
    if (parsed?.type === "content_block_stop") emit(parsed.index);
    out.push(event);
  }
  for (const index of [...pending.keys()]) emit(index);
  return out.join("\n\n") + "\n\n";
}

/**
 * What identifies a request: the model, which system prompt (by its opening, since the rest
 * describes the machine), and the conversation. Tool definitions, metadata, the per-session
 * billing line, and `system`-role context messages (environment, token counters) are left out.
 */
export type Canonical = { model: string; system: string; messages: { role: string; content: unknown }[] };

export function canonical(body: any, root: string): Canonical {
  const blocks = typeof body.system === "string" ? [{ text: body.system }] : (body.system ?? []);
  const system = blocks.map((block: any) => block.text ?? "").join("\n").replace(/^x-anthropic-billing-header:[^\n]*\n?/m, "");
  return {
    model: body.model,
    system: scrubText(system, root).slice(0, 120),
    messages: (body.messages ?? []).filter((message: any) => message.role !== "system").map((message: any) => ({
      role: message.role,
      content: typeof message.content === "string" ? scrubText(message.content, root) : message.content.map((block: any) => scrubBlock(block, root)).filter(Boolean),
    })),
  };
}

function scrubBlock(block: any, root: string): unknown {
  switch (block.type) {
    case "text": {
      const text = scrubText(block.text, root);
      return text ? { type: "text", text } : null;
    }
    case "tool_use":
      return { type: "tool_use", name: block.name, input: scrubValue(block.input, root) };
    case "tool_result":
      return { type: "tool_result", content: scrubValue(block.content, root) };
    // Thinking text and signatures come back verbatim from the cassette, but are noise for matching.
    case "thinking":
    case "redacted_thinking":
      return null;
    default:
      return scrubValue(block, root);
  }
}

function scrubValue(value: unknown, root: string): unknown {
  if (typeof value === "string") return scrubText(value, root);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => name !== "cache_control" && name !== "id" && name !== "tool_use_id")
        .map(([name, item]) => [name, scrubValue(item, root)]),
    );
  }
  return value;
}

function scrubText(text: string, root: string): string {
  let out = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  out = out.split(root).join("<root>");
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\bwks_[0-9a-f]+/g, "<workspace>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .trim();
}
