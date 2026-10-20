import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { actOnAsk, discussAsk, listAsks, OPEN_STATUSES, refreshAsks } from "./shared/asks";
import { AgentDirectory, pickCaller } from "./server/agents";
import { installBridge } from "./server/bridge";
import { discuss } from "./server/discuss";
import { findGh, ghFetcher } from "./server/github";
import { LastOutputs } from "./server/last-output";
import { listen } from "./server/listener";
import { CLASSIFIER_PROMPT, NUDGE, paseoClassifier, shouldNudge } from "./server/nudge";
import { Outbox, type Courier } from "./server/outbox";
import { dataDir } from "./server/paths";
import { isAsksPermission } from "./server/permissions";
import { AsksService, INSTRUCTIONS, TOOLS } from "./server/service";
import { AskStore } from "./server/store";
import { PrWatcher } from "./server/watcher";

const FLUSH_EVERY_MS = 20_000;
const PR_EVERY_MS = 120_000;

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
  const callerIn = async (cwd: string) => {
    const { entries } = await requirePaseo().agents.list();
    return pickCaller(entries.map((entry) => entry.agent), cwd);
  };
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
      const ask = askId ? store.get(workspaceId, askId) : undefined;
      if (ask && OPEN_STATUSES.includes(ask.status)) await store.update(workspaceId, ask.id, { orphaned: true });
    }
  });
  const service = new AsksService(store, outbox, (agentId) => agents.workspaceOf(agentId));
  const lastOutputs = new LastOutputs(dir);
  const gh = findGh();
  if (!gh) console.error("[asks] gh not found; PR asks will show no live status");
  const watcher = gh ? new PrWatcher(store, service, ghFetcher(gh)) : null;
  // Short-lived classifier agents the plugin starts itself; its hooks leave them alone.
  const helpers = new Set<string>();
  const classifierFor = paseoClassifier(requirePaseo, helpers);

  server.before("agent.create", ({ request }, { paseo: api }) => {
    capture(api);
    if (request.config.systemPrompt === CLASSIFIER_PROMPT) return request;
    return { ...request, config: { ...request.config, mcpServers: { ...request.config.mcpServers, asks: mcp } } };
  });
  server.before("agent.session_open", ({ request }, { paseo: api }) => {
    capture(api);
    if (request.workspaceId && !helpers.has(request.agentId)) agents.remember(request.agentId, request.workspaceId);
  });
  server.on("agent.created", ({ agent }, { paseo: api }) => {
    capture(api);
    if (agent.workspaceId && !helpers.has(agent.id)) agents.remember(agent.id, agent.workspaceId);
  });
  server.on("agent.turn_ended", ({ agent, outcome, timeline }, { paseo: api }) => {
    capture(api);
    if (helpers.has(agent.id)) return;
    lastOutputs.record(agent.id, timeline);
    void outbox.flush(agent.id);
    // Agents sometimes ask in chat and skip ask_create; one reminder per such turn. Side chats talk to the human directly.
    const sideChat = store.list(agent.workspaceId ?? undefined).some((ask) => ask.discussionAgentId === agent.id);
    if (outcome.kind !== "completed" || !agent.workspaceId || sideChat) return;
    const workspaceId = agent.workspaceId;
    void shouldNudge(timeline, classifierFor(agent.id)).then(async (nudge) => {
      // The classifier takes a few seconds; a reminder after the human has moved on would be stale.
      if (!nudge || (await courier.state(agent.id)) !== "idle") return;
      service.message(agent.id, workspaceId, NUDGE);
      await outbox.flush(agent.id);
    }).catch(() => {});
  });
  // Plan mode (the side chat's read-only mode) and Codex prompt even for preapproved MCP tools. The asks
  // tools only touch asks, so answer those prompts here instead of interrupting the human.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo: api }) => {
    capture(api);
    // A classifier only needs to answer; never let it put a prompt in front of the human.
    if (helpers.has(agent.id)) {
      await api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "deny", message: "Answer without tools." } });
      return;
    }
    if (!isAsksPermission(request)) return;
    await api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });
  server.on("agent.archived", ({ agent }, { paseo: api }) => {
    capture(api);
    void outbox.flush(agent.id);
  });

  server.handle(listAsks, async ({ workspaceId, includeClosed }, { paseo: api }) => {
    capture(api);
    const asks = store.list(workspaceId).filter((ask) => includeClosed || OPEN_STATUSES.includes(ask.status));
    asks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (workspaceId) return { asks };
    // The global screen has no workspace context, so client state hooks can't resolve names there.
    const { entries } = await api.workspaces.list({ page: { limit: 200 } }).catch(() => ({ entries: [] }));
    return { asks, workspaceNames: Object.fromEntries(entries.map((w) => [w.id, w.name])) };
  });
  server.handle(actOnAsk, (input, { paseo: api }) => {
    capture(api);
    return service.act(input);
  });
  server.handle(refreshAsks, ({ agentId }, { paseo: api }) => {
    capture(api);
    return service.refresh(agentId);
  });
  const startDiscussion = (api: PaseoApi, workspaceId: string, id: string) => {
    const ask = store.get(workspaceId, id);
    if (!ask) throw new Error(`No ask ${id} in this workspace`);
    return discuss({ paseo: api, store, mcp, lastOutput: (agentId) => lastOutputs.get(agentId) }, ask);
  };
  server.handle(discussAsk, ({ workspaceId, id }, { paseo: api }) => {
    capture(api);
    return startDiscussion(api, workspaceId, id);
  });

  const listening = listen(dir, {
    "/instructions": async () => ({ instructions: INSTRUCTIONS }),
    "/tools": async () => ({ tools: TOOLS }),
    "/call": async ({ agentId, cwd, name, arguments: args }) => {
      const result = await service.callTool(agentId ?? (cwd ? await callerIn(cwd) : null), name, args);
      if (!result.isError && (name === "ask_create" || name === "ask_update")) void watcher?.refresh();
      return result;
    },
    // The same disposal the UI does, for scripts and terminal use.
    "/act": async (input) => service.act(actOnAsk.input.parse(input)),
    "/refresh": async (input) => service.refresh(refreshAsks.input.parse(input).agentId),
    "/discuss": async (input) => {
      const { workspaceId, id } = discussAsk.input.parse(input);
      return startDiscussion(requirePaseo(), workspaceId, id);
    },
  });
  const timer = setInterval(() => {
    if (paseo && outbox.pending().length) void outbox.flush();
  }, FLUSH_EVERY_MS);

  const prTimer = setInterval(() => void watcher?.refresh(), PR_EVERY_MS);
  void watcher?.refresh();

  return async () => {
    clearInterval(timer);
    clearInterval(prTimer);
    (await listening).close();
  };
}
