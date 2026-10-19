import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@getpaseo/protocol/agent-types";

// Agents talk MCP over stdio to this script. It inherits PASEO_AGENT_ID from the agent process,
// which is how a tool call knows who made it, and forwards to the plugin's localhost listener.
const BRIDGE_SOURCE = String.raw`
import { readFileSync } from "node:fs";
const dir = process.env.PASEO_ASKS_DIR;
const agentId = process.env.PASEO_AGENT_ID ?? null;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
async function call(path, body) {
  const { port, token } = JSON.parse(readFileSync(dir + "/server.json", "utf8"));
  const res = await fetch("http://127.0.0.1:" + port + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}
async function handle(m) {
  if (m.id === undefined) return;
  try {
    if (m.method === "initialize") {
      const { instructions } = await call("/instructions", {}).catch(() => ({ instructions: undefined }));
      return send({ jsonrpc: "2.0", id: m.id, result: {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "asks", version: "0.1.0" },
        instructions,
      } });
    }
    if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: await call("/tools", {}) });
    if (m.method === "tools/call") {
      const r = await call("/call", { agentId, name: m.params.name, arguments: m.params.arguments ?? {} });
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: r.text }], isError: Boolean(r.isError) } });
    }
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
  } catch (e) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;

export function installBridge(dir: string): McpServerConfig {
  const path = join(dir, "bridge.mjs");
  writeFileSync(path, BRIDGE_SOURCE);
  return {
    type: "stdio",
    command: process.execPath,
    args: [path],
    env: { ELECTRON_RUN_AS_NODE: "1", PASEO_ASKS_DIR: dir },
    alwaysLoad: true,
  };
}
