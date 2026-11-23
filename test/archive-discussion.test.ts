import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveDiscussion, paseoArchiveHost, type ArchiveHost } from "../server/archive-discussion";
import { Outbox } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { uncommittedFiles } from "../server/worktree";

const WS = "wks_owner";
const EXPLAIN_WS = "wks_explain";
const OWNER = "owner";
const EXPLAINER = "explainer";

type Workspace = NonNullable<Awaited<ReturnType<ArchiveHost["workspace"]>>>;

describe("archiving an explainer's workspace", () => {
  let dir: string;
  let store: AskStore;
  let service: AsksService;
  let archived: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "asks-archive-"));
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
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const idle = (overrides: Partial<Workspace> = {}): Workspace => ({
    directory: "/worktrees/explain-a1",
    archiving: false,
    agents: [{ id: EXPLAINER, title: "Explain A1: Squash-only merges?", working: false }],
    terminals: 0,
    ...overrides,
  });
  const host = (overrides: Partial<ArchiveHost> = {}): ArchiveHost => ({
    workspace: async () => idle(),
    uncommittedFiles: async () => [],
    archive: async (workspaceId) => (archived.push(workspaceId), {}),
    ...overrides,
  });
  const run = (overrides?: Partial<ArchiveHost>, options?: { discardFiles?: string[] }) =>
    archiveDiscussion({ store, service, host: host(overrides) }, store.get(WS, "A1")!, options);
  const settle = () => service.callTool(EXPLAINER, "ask_resolve", { id: "A1", actionId: "a2" });

  it("archives a settled discussion's idle, clean workspace and ends the discussion", async () => {
    await settle();
    expect(await run()).toEqual({ archived: true });
    expect(archived).toEqual([EXPLAIN_WS]);
    expect(store.get(WS, "A1")!.discussionWorkspaceId).toBeUndefined();
  });

  it("lists uncommitted files first, and deletes them only once the human confirms", async () => {
    await settle();
    const notes = async () => ["EXPLAIN.md", "fig/a.png", "fig/b.png", "notes.md"];
    expect(await run({ uncommittedFiles: notes })).toEqual({
      archived: false,
      reason: "its worktree has uncommitted files (EXPLAIN.md, fig/a.png, fig/b.png and 1 more)",
      files: ["EXPLAIN.md", "fig/a.png", "fig/b.png", "notes.md"],
    });
    expect(archived).toEqual([]);
    expect(await run({ uncommittedFiles: notes }, { discardFiles: ["EXPLAIN.md", "fig/a.png", "fig/b.png", "notes.md"] })).toEqual({ archived: true });
    expect(archived).toEqual([EXPLAIN_WS]);
  });

  it("asks again when a file appeared since the human confirmed the list", async () => {
    await settle();
    const now = async () => ["EXPLAIN.md", "summary.md"];
    expect(await run({ uncommittedFiles: now }, { discardFiles: ["EXPLAIN.md"] })).toEqual({
      archived: false,
      reason: "its worktree has uncommitted files (EXPLAIN.md, summary.md)",
      files: ["EXPLAIN.md", "summary.md"],
    });
    expect(archived).toEqual([]);
  });

  it("never lets a confirmed file list skip another refusal", async () => {
    const all = { discardFiles: ["EXPLAIN.md"] };
    expect((await run({}, all)).archived).toBe(false);
    await settle();
    const busy = async () => idle({ agents: [{ id: EXPLAINER, title: null, working: true }] });
    const shared = async () => idle({ agents: [...idle().agents, { id: "other", title: null, working: false }] });
    for (const overrides of [{ workspace: busy }, { workspace: shared }, { uncommittedFiles: async () => null }]) {
      expect((await run(overrides, all)).archived).toBe(false);
    }
    expect(archived).toEqual([]);
  });

  it("refuses while the ask waits on the human or its owner works on it", async () => {
    expect(await run()).toEqual({ archived: false, reason: "A1 still waits on you; settle it first" });
    await store.update(WS, "A1", { status: "in_progress" });
    expect(await run()).toEqual({ archived: false, reason: "A1 is still being worked on" });
    expect(archived).toEqual([]);
  });

  it("refuses while the explainer's own asks are open", async () => {
    await settle();
    await service.callTool(EXPLAINER, "ask_create", { kind: "followup", title: "Send the summary to the lead?" });
    await service.callTool(EXPLAINER, "ask_create", { kind: "question", title: "Which region?" });
    expect(await run()).toEqual({ archived: false, reason: "A2, A3 there are still open" });
  });

  it("refuses while an agent there works, another agent uses it, a terminal is open, or it is being archived", async () => {
    await settle();
    const refusal = async (workspace: Workspace) => (await run({ workspace: async () => workspace })) as { reason: string };
    expect((await refusal(idle({ agents: [{ id: EXPLAINER, title: null, working: true }] }))).reason).toBe("an agent there is still working");
    expect((await refusal(idle({ agents: [...idle().agents, { id: "other", title: "Try option B", working: false }] }))).reason).toBe(
      "other agents use it too (Try option B); archive it from Paseo, which asks first",
    );
    expect((await refusal(idle({ terminals: 2 }))).reason).toBe("2 terminals are open there");
    expect((await refusal(idle({ archiving: true }))).reason).toBe("it is already being archived");
    expect(archived).toEqual([]);
  });

  it("refuses when it can't read the worktree", async () => {
    await settle();
    expect((await run({ uncommittedFiles: async () => null })).archived).toBe(false);
    expect((await run({ workspace: async () => idle({ directory: undefined }) })).archived).toBe(false);
    expect(archived).toEqual([]);
  });

  it("never archives the workspace the ask itself lives in", async () => {
    await settle();
    await store.update(WS, "A1", { discussionWorkspaceId: WS });
    expect(await run()).toEqual({ archived: false, reason: "A1 was discussed in its own workspace" });
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

describe("the daemon side", () => {
  type Agent = { id: string; title: string | null; workspaceId: string; status: string; archivedAt?: string | null };
  const api = (workspace: Record<string, unknown> | null, pages: Agent[][], terminals = 0) => {
    const calls: unknown[] = [];
    const fake = {
      workspaces: {
        ref: () => ({ refresh: async () => workspace, terminals: { list: async () => ({ entries: Array(terminals).fill({}) }) } }),
        archive: async () => ({ error: null }),
      },
      agents: {
        list: async (options: { page?: { cursor?: string } }) => {
          calls.push(options);
          const index = options.page?.cursor ? Number(options.page.cursor) : 0;
          const more = index + 1 < pages.length;
          return { entries: pages[index]!.map((agent) => ({ agent })), pageInfo: { hasMore: more, nextCursor: more ? String(index + 1) : null, prevCursor: null } };
        },
      },
    };
    return { fake: fake as unknown as Parameters<typeof paseoArchiveHost>[0], calls };
  };
  const explainer = (status: string): Agent => ({ id: EXPLAINER, title: "Explain A1", workspaceId: EXPLAIN_WS, status });

  it("reads every agent of the workspace across pages, background ones included, and only those", async () => {
    const { fake, calls } = api({ workspaceDirectory: "/w", archivingAt: null }, [
      [{ id: "elsewhere", title: null, workspaceId: WS, status: "running" }],
      [explainer("initializing"), { id: "gone", title: null, workspaceId: EXPLAIN_WS, status: "idle", archivedAt: "2026-11-01T00:00:00Z" }],
    ]);
    expect(await paseoArchiveHost(fake).workspace(EXPLAIN_WS)).toEqual({
      directory: "/w",
      archiving: false,
      agents: [{ id: EXPLAINER, title: "Explain A1", working: true }],
      terminals: 0,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ includeBackground: true, filter: { includeBackground: true } });
  });

  it("reads an idle explainer as not working, and counts terminals", async () => {
    const { fake } = api({ workspaceDirectory: "/w" }, [[explainer("idle")]], 1);
    expect(await paseoArchiveHost(fake).workspace(EXPLAIN_WS)).toMatchObject({ agents: [{ working: false }], terminals: 1 });
  });

  it("reads an archived workspace as gone, and one being archived as archiving", async () => {
    expect(await paseoArchiveHost(api(null, [[]]).fake).workspace(EXPLAIN_WS)).toBeNull();
    expect(await paseoArchiveHost(api({ archivingAt: "2026-11-23T00:00:00Z" }, [[]]).fake).workspace(EXPLAIN_WS)).toMatchObject({ archiving: true });
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
    writeFileSync(join(repo, "fig ą.png"), "figure");
    expect((await uncommittedFiles(repo))?.sort()).toEqual(["EXPLAIN.md", "fig ą.png"]);
    execFileSync("git", ["add", "EXPLAIN.md"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "notes"], { cwd: repo });
    execFileSync("git", ["mv", "EXPLAIN.md", "NOTES.md"], { cwd: repo });
    expect((await uncommittedFiles(repo))?.sort()).toEqual(["NOTES.md", "fig ą.png"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
