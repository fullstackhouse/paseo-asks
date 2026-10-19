import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { actOnAsk, listAsks, OPEN_STATUSES } from "./shared/asks";
import { AgentDirectory } from "./server/agents";
import { installBridge } from "./server/bridge";
import { listen } from "./server/listener";
import { Outbox, type Courier } from "./server/outbox";
import { dataDir } from "./server/paths";
import { AsksService, INSTRUCTIONS, TOOLS } from "./server/service";
import { AskStore } from "./server/store";

const FLUSH_EVERY_MS = 20_000;

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
  const mcp = installBridge(dir);
  // The daemon session behind `paseo` lives as long as this subprocess; any hook or handler hands it over.
  let paseo: PaseoApi | null = null;
  const capture = (api: PaseoApi) => {
    paseo ??= api;
  };
  const requirePaseo = () => {
    if (!paseo) throw new Error("No daemon session yet");
    return paseo;
  };

  const agents = new AgentDirectory(dir, async (agentId) => {
    const handle = requirePaseo().agents.ref(agentId);
    await handle.refresh();
    return handle.workspaceId;
  });
  const store = new AskStore(dir);
  const courier: Courier = {
    async state(agentId) {
      const handle = requirePaseo().agents.ref(agentId);
      const found = await handle.refresh();
      if (!found || handle.archivedAt) return "gone";
      return handle.status === "running" || handle.status === "initializing" ? "running" : "idle";
    },
    async send(agentId, text, messageId) {
      await requirePaseo().agents.ref(agentId).send(text, { messageId, activeTurnBehavior: "steer" });
    },
  };
  const outbox = new Outbox(dir, courier, async (deliveries) => {
    for (const { workspaceId, askId } of deliveries) {
      const ask = store.get(workspaceId, askId);
      if (ask && OPEN_STATUSES.includes(ask.status)) await store.update(workspaceId, askId, { orphaned: true });
    }
  });
  const service = new AsksService(store, outbox, (agentId) => agents.workspaceOf(agentId));

  server.before("agent.create", ({ request }, { paseo: api }) => {
    capture(api);
    return { ...request, config: { ...request.config, mcpServers: { ...request.config.mcpServers, asks: mcp } } };
  });
  server.before("agent.session_open", ({ request }, { paseo: api }) => {
    capture(api);
    if (request.workspaceId) agents.remember(request.agentId, request.workspaceId);
  });
  server.on("agent.created", ({ agent }, { paseo: api }) => {
    capture(api);
    if (agent.workspaceId) agents.remember(agent.id, agent.workspaceId);
  });
  server.on("agent.turn_ended", ({ agent }, { paseo: api }) => {
    capture(api);
    void outbox.flush(agent.id);
  });
  server.on("agent.archived", ({ agent }, { paseo: api }) => {
    capture(api);
    void outbox.flush(agent.id);
  });

  server.handle(listAsks, ({ workspaceId, includeClosed }, { paseo: api }) => {
    capture(api);
    const asks = store.list(workspaceId).filter((ask) => includeClosed || OPEN_STATUSES.includes(ask.status));
    return { asks: asks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  });
  server.handle(actOnAsk, (input, { paseo: api }) => {
    capture(api);
    return service.act(input);
  });

  const listening = listen(dir, {
    "/instructions": async () => ({ instructions: INSTRUCTIONS }),
    "/tools": async () => ({ tools: TOOLS }),
    "/call": async ({ agentId, name, arguments: args }) => service.callTool(agentId ?? null, name, args),
    // The same disposal the UI does, for scripts and terminal use.
    "/act": async (input) => service.act(actOnAsk.input.parse(input)),
  });
  const timer = setInterval(() => {
    if (paseo && outbox.pending().length) void outbox.flush();
  }, FLUSH_EVERY_MS);

  return async () => {
    clearInterval(timer);
    (await listening).close();
  };
}
