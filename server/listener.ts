import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type Route = (body: any) => Promise<unknown>;

export async function listen(dir: string, routes: Record<string, Route>): Promise<Server> {
  const token = randomBytes(24).toString("hex");
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
    const route = routes[req.url ?? ""];
    if (!route) return reply(404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      reply(200, await route(raw ? JSON.parse(raw) : {}));
    } catch (error) {
      reply(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener has no port");
  writeFileSync(join(dir, "server.json"), JSON.stringify({ port: address.port, token, pid: process.pid }), { mode: 0o600 });
  return server;
}
