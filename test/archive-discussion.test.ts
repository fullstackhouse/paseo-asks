import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { archiveDiscussion, type ArchiveHost } from "../server/archive-discussion";
import { Outbox } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { uncommittedFiles } from "../server/worktree";

const WS = "wks_owner";
const EXPLAIN_WS = "wks_explain";
const OWNER = "owner";
const EXPLAINER = "explainer";

describe("archiving an explainer's workspace", () => {
  let store: AskStore;
  let service: AsksService;
  let archived: string[];

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "asks-archive-"));
    store = new AskStore(dir);
    archived = [];
    const workspaces: Record<string, string> = { [OWNER]: WS, [EXPLAINER]: EXPLAIN_WS };
    service = new AsksService(store, new Outbox(dir, { state: async () => "idle", send: async () => {} }), async (agentId) => workspaces[agentId] ?? null);
    await service.callTool(OWNER, "ask_create", {
      kind: "decision",
      title: "Squash-only merges?",
      actions: [
        { label: "keep", kind: "resolve" },
        { label: "squash-only", kind: "resolve" },
      ],
    });
    await store.update(WS, "A1", { discussionAgentId: EXPLAINER, discussionWorkspaceId: EXPLAIN_WS });
    await store.reserveAfter(EXPLAIN_WS, "A1");
  });

  const host = (overrides: Partial<ArchiveHost> = {}): ArchiveHost => ({
    workspace: async () => ({ directory: "/worktrees/explain-a1", working: false, terminals: 0 }),
    uncommittedFiles: async () => [],
    archive: async (workspaceId) => (archived.push(workspaceId), {}),
    ...overrides,
  });
  const run = (overrides?: Partial<ArchiveHost>) => archiveDiscussion({ store, service, host: host(overrides) }, store.get(WS, "A1")!);
  const settle = () => service.callTool(EXPLAINER, "ask_resolve", { id: "A1", actionId: "a2" });

  it("archives a settled discussion's idle, clean workspace and ends the discussion", async () => {
    await settle();
    expect(await run()).toEqual({ archived: true });
    expect(archived).toEqual([EXPLAIN_WS]);
    expect(store.get(WS, "A1")!.discussionWorkspaceId).toBeUndefined();
  });

  it("refuses while the ask still waits on the human", async () => {
    expect(await run()).toEqual({ archived: false, reason: "A1 still waits on you; settle it first" });
    expect(archived).toEqual([]);
  });

  it("refuses while the explainer's own asks wait on the human", async () => {
    await settle();
    await service.callTool(EXPLAINER, "ask_create", { kind: "followup", title: "Send the summary to the lead?" });
    await service.callTool(EXPLAINER, "ask_create", { kind: "question", title: "Which region?" });
    expect(await run()).toEqual({ archived: false, reason: "A2, A3 there still wait on you" });
  });

  it("refuses while an agent there works or a terminal is open", async () => {
    await settle();
    expect(await run({ workspace: async () => ({ directory: "/w", working: true, terminals: 0 }) })).toEqual({
      archived: false,
      reason: "an agent there is still working",
    });
    expect(await run({ workspace: async () => ({ directory: "/w", working: false, terminals: 2 }) })).toEqual({
      archived: false,
      reason: "2 terminals are open there",
    });
    expect(archived).toEqual([]);
  });

  it("refuses when the worktree has uncommitted files, naming them, or can't be read", async () => {
    await settle();
    const dirty = await run({ uncommittedFiles: async () => ["EXPLAIN.md", "fig/a.png", "fig/b.png", "notes.md"] });
    expect(dirty).toEqual({
      archived: false,
      reason: "its worktree has uncommitted files (EXPLAIN.md, fig/a.png, fig/b.png and 1 more); archive it from Paseo's sidebar to confirm losing them",
    });
    expect((await run({ uncommittedFiles: async () => null })).archived).toBe(false);
    expect((await run({ workspace: async () => ({ working: false, terminals: 0 }) })).archived).toBe(false);
    expect(archived).toEqual([]);
  });

  it("ends the discussion of a workspace that is already gone", async () => {
    await settle();
    expect(await run({ workspace: async () => null })).toEqual({ archived: true });
    expect(archived).toEqual([]);
    expect(store.get(WS, "A1")!.discussionAgentId).toBeUndefined();
  });

  it("passes on the daemon's refusal and keeps the link", async () => {
    await settle();
    expect(await run({ archive: async () => ({ error: "Workspace is busy" }) })).toEqual({ archived: false, reason: "Workspace is busy" });
    expect(store.get(WS, "A1")!.discussionWorkspaceId).toBe(EXPLAIN_WS);
  });
});

it("lists uncommitted and untracked files whatever git's settings, and null outside a repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "asks-worktree-"));
  try {
    expect(await uncommittedFiles(repo)).toBeNull();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: repo });
    expect(await uncommittedFiles(repo)).toEqual([]);
    writeFileSync(join(repo, "EXPLAIN.md"), "notes");
    expect(await uncommittedFiles(repo)).toEqual(["EXPLAIN.md"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
