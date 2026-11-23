import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { discuss, Discussions, type DiscussDeps } from "../server/discuss";
import { Outbox, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { discussionTitle, showsIn, waitingByWorkspace, workspaceAsks } from "../shared/asks";

const WS = "wks_owner";
const EXPLAIN_WS = "wks_explain";
const OWNER = "owner";
const EXPLAINER = "explainer";

interface Created {
  workspace?: Record<string, unknown>;
  agents: { workspaceId: string; options: Record<string, any> }[];
  archived: string[];
  sent: { agentId: string; text: string }[];
  workspaces?: number;
}

/** Just the PaseoApi surface `discuss` uses. */
function fakePaseo(
  created: Created,
  {
    workspaceFails = false,
    agentFails = false,
    alive = new Set<string>(),
    refreshFails = false,
    readOnly = true,
    workspaceReady = Promise.resolve(),
  } = {},
): DiscussDeps["paseo"] {
  const owner = {
    id: OWNER,
    provider: "claude",
    model: "claude-opus-5-5",
    cwd: "/repos/app/.paseo/worktrees/feature",
    currentModeId: "bypassPermissions",
    availableModes: [{ id: "default" }, ...(readOnly ? [{ id: "plan" }] : []), { id: "bypassPermissions" }],
  };
  const agentHandle = (id: string) => ({
    id,
    archivedAt: null,
    refresh: async () => {
      if (refreshFails && id !== OWNER) throw new Error("daemon unreachable");
      return id === OWNER || alive.has(id) ? { agent: owner } : null;
    },
    current: () => (id === OWNER ? owner : null),
    send: async (text: string) => void created.sent.push({ agentId: id, text }),
  });
  const workspace = (id: string) => ({
    id,
    agents: {
      create: async (options: Record<string, unknown>) => {
        if (agentFails) throw new Error("provider unavailable");
        created.agents.push({ workspaceId: id, options });
        return { id: id === WS ? "side-chat" : EXPLAINER };
      },
    },
    archive: async () => void created.archived.push(id),
  });
  return {
    agents: { ref: agentHandle },
    workspaces: {
      ref: workspace,
      create: async (options: Record<string, unknown>) => {
        await workspaceReady;
        if (workspaceFails) throw new Error("not a git repository");
        created.workspaces = (created.workspaces ?? 0) + 1;
        created.workspace = options;
        return workspace(EXPLAIN_WS);
      },
    },
  } as unknown as DiscussDeps["paseo"];
}

describe("Discuss", () => {
  let store: AskStore;
  let service: AsksService;
  let outbox: Outbox;
  let toOwner: string[];
  let created: Created;
  let workspaces: Record<string, string>;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "asks-discuss-"));
    store = new AskStore(dir);
    toOwner = [];
    created = { agents: [], archived: [], sent: [] };
    workspaces = { [OWNER]: WS, [EXPLAINER]: EXPLAIN_WS, bystander: EXPLAIN_WS };
    const courier: Courier = { state: async () => "idle", send: async (_agent, text) => void toOwner.push(text) };
    outbox = new Outbox(dir, courier);
    service = new AsksService(store, outbox, async (agentId) => workspaces[agentId] ?? null);
  });

  const decision = async () => {
    await service.callTool(OWNER, "ask_create", {
      kind: "decision",
      title: "Squash-only merges?",
      body: "The release tool reads commit subjects.",
      actions: [
        { label: "keep", kind: "resolve" },
        { label: "squash-only", kind: "resolve", recommended: true },
      ],
    });
    return store.get(WS, "A1")!;
  };
  const deps = (paseo: DiscussDeps["paseo"]): DiscussDeps => ({
    paseo,
    store,
    mcp: { type: "stdio", command: "node", args: ["bridge.mjs"] } as DiscussDeps["mcp"],
    lastOutput: () => "Both PRs are green.",
  });

  it("opens an explainer in a worktree workspace of the owner's repo, seeded with the ask", async () => {
    const ask = await decision();
    const result = await discuss(deps(fakePaseo(created)), ask);

    expect(result).toEqual({ agentId: EXPLAINER, workspaceId: EXPLAIN_WS, created: true });
    expect(created.workspace).toMatchObject({
      source: { kind: "worktree", cwd: "/repos/app/.paseo/worktrees/feature", action: "branch-off" },
      title: "Explain A1: Squash-only merges?",
    });
    expect(created.workspace).not.toHaveProperty("background");
    const [agent] = created.agents;
    expect(agent!.workspaceId).toBe(EXPLAIN_WS);
    expect(agent!.options.config).toMatchObject({ provider: "claude/claude-opus-5-5", modeId: "bypassPermissions" });
    expect(agent!.options.config.mcpServers.asks).toBeDefined();
    const prompt: string = agent!.options.prompt;
    expect(prompt).toContain("/explain");
    expect(prompt).toContain("A1 with its buttons in this chat's Asks too");
    expect(prompt).toContain("call ask_create as usual");
    expect(prompt).not.toContain("Do not create asks");
    expect(prompt).toContain("never change it");
    expect(prompt).toContain("/repos/app/.paseo/worktrees/feature");
    expect(prompt).toContain('call ask_resolve with id "A1"');
    expect(prompt).toContain("- actionId a2: squash-only (the main agent recommends this)");
    expect(prompt).toContain("The release tool reads commit subjects.");
    expect(prompt).toContain("Both PRs are green.");
    expect(store.get(WS, "A1")).toMatchObject({ discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
  });

  it("opens with the human's note instead of the explain run when they typed one", async () => {
    const ask = await decision();
    await discuss(deps(fakePaseo(created)), ask, "Why not rebase?");
    const prompt: string = created.agents[0]!.options.prompt;
    expect(prompt).toContain("The human opened this chat with:\n\nWhy not rebase?");
    expect(prompt).not.toContain("/explain");
  });

  it("reopens the live explainer instead of starting another, passing on the note", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    const result = await discuss(deps(fakePaseo(created, { alive: new Set([EXPLAINER]) })), store.get(WS, "A1")!, "And the changelog?");

    expect(result).toEqual({ agentId: EXPLAINER, workspaceId: EXPLAIN_WS, created: false });
    expect(created.workspace).toBeUndefined();
    expect(created.sent).toEqual([{ agentId: EXPLAINER, text: "And the changelog?" }]);
  });

  it("falls back to a read-only side chat in the ask's workspace when no workspace can be made", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: "gone", discussionWorkspaceId: "wks_old" });
    const result = await discuss(deps(fakePaseo(created, { workspaceFails: true })), store.get(WS, "A1")!);

    expect(result).toEqual({ agentId: "side-chat", workspaceId: WS, created: true });
    const [agent] = created.agents;
    expect(agent!.workspaceId).toBe(WS);
    expect(agent!.options).toMatchObject({ parent: OWNER, config: { modeId: "plan" } });
    expect(agent!.options.prompt).toContain("Do not edit files");
    expect(store.get(WS, "A1")!.discussionWorkspaceId).toBeUndefined();
  });

  it("archives the new workspace when its agent fails to start", async () => {
    const ask = await decision();
    await expect(discuss(deps(fakePaseo(created, { agentFails: true })), ask)).rejects.toThrow("provider unavailable");
    expect(created.archived).toEqual([EXPLAIN_WS]);
    expect(store.get(WS, "A1")!.discussionAgentId).toBeUndefined();
  });

  it("lets the linked explainer resolve the ask from its own workspace, and the owner hears it", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });

    const listed = await service.callTool(EXPLAINER, "ask_list", {});
    expect(listed.text).toContain("A1 [open] decision: Squash-only merges?");

    const result = await service.callTool(EXPLAINER, "ask_resolve", { id: "A1", actionId: "a2", note: "Squash; subjects feed the changelog." });
    expect(result.isError).toBeFalsy();
    await outbox.flush();
    expect(store.get(WS, "A1")).toMatchObject({ status: "done", outcome: { actionId: "a2", by: "agent" } });
    expect(toOwner).toEqual([
      "[asks] A1 (Squash-only merges?) resolved in a side chat: squash-only. Summary: Squash; subjects feed the changelog.",
    ]);
  });

  it("lets the linked explainer update the ask from its own workspace", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    const result = await service.callTool(EXPLAINER, "ask_update", { id: "A1", status: "dropped" });
    expect(result.isError).toBeFalsy();
    expect(store.get(WS, "A1")!.status).toBe("dropped");
    await outbox.flush();
    expect(toOwner).toEqual(["[asks] A1 (Squash-only merges?) marked dropped in a side chat."]);
  });

  it("tells the explainer when the human answers with a button, and keeps it from settling the ask again", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a2" });
    await outbox.flush();
    // Both agents' messages land in one list here: the owner's answer and the explainer's notice.
    expect(toOwner).toHaveLength(2);
    expect(toOwner).toEqual(
      expect.arrayContaining([
        "[asks] A1 (Squash-only merges?) resolved: squash-only.",
        '[asks] The human answered A1 (Squash-only merges?) with its buttons: they chose "squash-only". The main agent has been told. Do not resolve or update A1. Reply in one line.',
      ]),
    );

    const again = await service.callTool(EXPLAINER, "ask_resolve", { id: "A1", actionId: "a1" });
    expect(again).toMatchObject({ isError: true, text: expect.stringContaining("A1 no longer waits on the human (done: squash-only)") });
    expect(await service.callTool(EXPLAINER, "ask_update", { id: "A1", status: "dropped" })).toMatchObject({ isError: true });
    expect(store.get(WS, "A1")).toMatchObject({ status: "done", outcome: { by: "human", label: "squash-only" } });
    await outbox.flush();
    expect(toOwner).toHaveLength(2);
  });

  it("tells the explainer when the human hands the work to the owner, and lets the owner reopen a closed ask", async () => {
    await service.callTool(OWNER, "ask_create", {
      kind: "pr",
      title: "Merge PR #30",
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #30" }],
    });
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await outbox.flush();
    expect(toOwner).toContainEqual(expect.stringContaining('they chose "Merge". The main agent has been told. Do not resolve or update A1.'));
    // The owner is merging: a settle from the explainer would end its PR updates.
    expect(await service.callTool(EXPLAINER, "ask_resolve", { id: "A1" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("A1 no longer waits on the human (in progress: Merge)"),
    });
    expect(store.get(WS, "A1")!.status).toBe("in_progress");
    // Any other agent of the owner's workspace keeps working the ask as before.
    workspaces.sibling = WS;
    expect((await service.callTool("sibling", "ask_update", { id: "A1", body: "Merging after CI." })).isError).toBeFalsy();
    await service.callTool(OWNER, "ask_resolve", { id: "A1" });
    expect((await service.callTool(OWNER, "ask_update", { id: "A1", status: "open" })).isError).toBeFalsy();
  });

  it("keeps every other agent in the explainer's workspace away from the ask", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    const result = await service.callTool("bystander", "ask_resolve", { id: "A1" });
    expect(result).toMatchObject({ isError: true, text: "No ask A1 in this workspace" });
    expect(store.get(WS, "A1")!.status).toBe("open");
  });

  it("lets the explainer raise asks of its own, in its own workspace", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    const result = await service.callTool(EXPLAINER, "ask_create", {
      kind: "followup",
      title: "Send the summary to the lead?",
      actions: [{ label: "Send it", kind: "send", prompt: "Send the summary to the lead" }],
    });
    expect(result.isError).toBeFalsy();
    expect(store.list(EXPLAIN_WS)).toEqual([expect.objectContaining({ ownerAgentId: EXPLAINER, title: "Send the summary to the lead?" })]);
  });

  it("numbers the explainer's own asks after the one it discusses", async () => {
    const ask = await decision();
    await discuss(deps(fakePaseo(created)), ask);
    const result = await service.callTool(EXPLAINER, "ask_create", { kind: "question", title: "Which region?" });
    expect(result.text).toMatch(/^A2 \[open\]/);
    expect(store.get(EXPLAIN_WS, "A2")).toMatchObject({ ownerAgentId: EXPLAINER });
    expect(store.get(WS, "A1")!.status).toBe("open");
  });

  it("shows the linked ask in the explainer's workspace too, and counts it waiting there", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    const asks = store.list();
    expect(asks.filter((ask) => showsIn(ask, EXPLAIN_WS)).map((ask) => ask.id)).toEqual(["A1"]);
    expect(asks.filter((ask) => showsIn(ask, WS)).map((ask) => ask.id)).toEqual(["A1"]);
    expect(asks.filter((ask) => showsIn(ask, "wks_other"))).toEqual([]);
    expect(waitingByWorkspace(asks).get(EXPLAIN_WS)).toEqual({ count: 1, newestId: "A1" });
    expect(workspaceAsks(asks, new Set()).get(EXPLAIN_WS)).toMatchObject({ count: 1, entries: [{ id: "A1" }] });
    expect(workspaceAsks(asks, new Set([EXPLAIN_WS])).get(EXPLAIN_WS)).toMatchObject({ count: 0 });
  });

  it("counts the open ask an explainer explains as recorded for the nudge, for that explainer only", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    expect([...service.openAskIds(EXPLAINER, EXPLAIN_WS)]).toEqual(["A1"]);
    expect([...service.openAskIds("bystander", EXPLAIN_WS)]).toEqual([]);
    expect([...service.openAskIds(OWNER, WS)]).toEqual(["A1"]);
    await service.callTool(EXPLAINER, "ask_resolve", { id: "A1", actionId: "a2" });
    // Once settled, naming it no longer counts: the explainer is nudged like any agent.
    expect([...service.openAskIds(EXPLAINER, EXPLAIN_WS)]).toEqual([]);
  });

  it("starts one explainer for two quick presses, passing the second press's note to it", async () => {
    const ask = await decision();
    let ready!: () => void;
    const paseo = fakePaseo(created, { workspaceReady: new Promise<void>((resolve) => (ready = resolve)) });
    const discussions = new Discussions();
    const first = discussions.start(deps(paseo), ask);
    const second = discussions.start(deps(paseo), ask, "And the changelog?");
    ready();
    expect(await first).toEqual({ agentId: EXPLAINER, workspaceId: EXPLAIN_WS, created: true });
    expect(await second).toEqual({ agentId: EXPLAINER, workspaceId: EXPLAIN_WS, created: false });
    expect(created.workspaces).toBe(1);
    expect(created.sent).toEqual([{ agentId: EXPLAINER, text: "And the changelog?" }]);
  });

  it("does not start a second explainer when the first can't be looked up", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    await expect(discuss(deps(fakePaseo(created, { refreshFails: true })), store.get(WS, "A1")!)).rejects.toThrow("daemon unreachable");
    expect(created.workspaces).toBeUndefined();
  });

  it("logs the fallback in one line, and names the workspace error when the side chat can't open either", async () => {
    const ask = await decision();
    const logged: string[] = [];
    const paseo = fakePaseo(created, { workspaceFails: true, readOnly: false });
    await expect(discuss({ ...deps(paseo), log: (line) => logged.push(line) }, ask)).rejects.toThrow(
      "Could not open a workspace for A1 (not a git repository), and claude offers no read-only mode",
    );
    expect(logged).toEqual([`[asks] ${WS}/A1 is discussed in a side chat: no workspace of its own (not a git repository)`]);
  });

  it("tells only the explainer, not the read-only side chat, to raise asks of its own", async () => {
    const ask = await decision();
    await discuss(deps(fakePaseo(created)), ask);
    await discuss(deps(fakePaseo(created, { workspaceFails: true })), { ...ask, discussionAgentId: undefined });
    const [explainer, sideChat] = created.agents.map((agent) => agent.options.prompt as string);
    expect(explainer).toContain("call ask_create as usual");
    expect(sideChat).not.toContain("ask_create");
  });

  it("drops the link when the explainer is archived", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    await service.endDiscussion(EXPLAINER);
    expect(store.get(WS, "A1")!.discussionAgentId).toBeUndefined();
    expect(store.get(WS, "A1")!.discussionWorkspaceId).toBeUndefined();
    expect(store.list().filter((ask) => showsIn(ask, EXPLAIN_WS))).toEqual([]);
  });

  it("ends the old discussion when the owner reopens a settled ask, so later clicks don't reach it", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    await service.callTool(EXPLAINER, "ask_resolve", { id: "A1", actionId: "a2" });
    await service.callTool(OWNER, "ask_update", { id: "A1", status: "open" });
    expect(store.get(WS, "A1")!.discussionAgentId).toBeUndefined();
    await outbox.flush();
    toOwner.length = 0;
    await service.act({ workspaceId: WS, id: "A1", verb: "done" });
    await outbox.flush();
    expect(toOwner).toEqual(["[asks] A1 (Squash-only merges?) marked done by the human."]);
  });

  it("tells the explainer of an orphaned ask that nobody else heard the answer", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS, orphaned: true });
    await service.act({ workspaceId: WS, id: "A1", verb: "drop" });
    await outbox.flush();
    expect(toOwner).toEqual([
      "[asks] The human answered A1 (Squash-only merges?) with its buttons: they dropped it. Nobody else was told: the agent that raised it is gone. Do not resolve or update A1. Reply in one line.",
    ]);
  });

  it("keeps a click made during an explainer's update instead of overwriting it", async () => {
    await decision();
    let release!: () => void;
    const pathCheck = new Promise<void>((resolve) => (release = resolve));
    // The file-path check runs git and takes a while; the human clicks during it.
    service = new AsksService(store, outbox, async (agentId) => workspaces[agentId] ?? null, undefined, async (_, body) => {
      await pathCheck;
      return { body, notes: [] };
    });
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    const update = service.callTool(EXPLAINER, "ask_update", { id: "A1", body: "Rewritten.", status: "dropped" });
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a2" });
    release();
    expect(await update).toMatchObject({ isError: true, text: expect.stringContaining("A1 no longer waits on the human (done: squash-only)") });
    expect(store.get(WS, "A1")).toMatchObject({ status: "done", outcome: { by: "human" } });
  });

  it("quiets the explained ask in the explainer's summary when its own workspace is snoozed", async () => {
    await decision();
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    expect(workspaceAsks(store.list(), new Set([WS])).get(EXPLAIN_WS)).toMatchObject({ count: 0, entries: [] });
  });

  it("lists a workspace created after the first list", async () => {
    expect(store.list()).toEqual([]);
    await decision();
    expect(store.list().map((ask) => ask.id)).toEqual(["A1"]);
  });

  it("titles the workspace within 60 characters", () => {
    expect(discussionTitle({ id: "A30", title: "x".repeat(100) })).toHaveLength(60);
    expect(discussionTitle({ id: "A30", title: "Short" })).toBe("Explain A30: Short");
  });
});
