import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { PrState } from "../shared/asks";
import { prUrlOf } from "../shared/asks";
import { seedPrompt } from "../server/discuss";
import { describePrChange, summarizeChecks } from "../server/github";
import { latestReply } from "../server/last-output";
import { Outbox, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { PrWatcher } from "../server/watcher";

const WS = "wks_1";
const OWNER = "owner";
const SIDE = "side-chat";

const pr = (overrides: Partial<PrState> = {}): PrState => ({
  number: 30,
  url: "https://github.com/o/r/pull/30",
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  checks: "pending",
  mergeable: "MERGEABLE",
  fetchedAt: "2026-10-19T00:00:00Z",
  ...overrides,
});

describe("phase 2", () => {
  let store: AskStore;
  let sent: string[];
  let service: AsksService;
  let outbox: Outbox;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "asks-"));
    store = new AskStore(dir);
    sent = [];
    const courier: Courier = { state: async () => "idle", send: async (_agent, text) => void sent.push(text) };
    outbox = new Outbox(dir, courier);
    service = new AsksService(store, outbox, async () => WS);
  });

  const prAsk = (subscribe: boolean) =>
    service.callTool(OWNER, "ask_create", {
      kind: "pr",
      title: "Merge PR #30",
      links: [{ label: "PR", url: "https://github.com/o/r/pull/30/files" }],
      subscribe,
    });

  it("a side chat resolving the owner's ask tells the owner, with the choice and summary", async () => {
    await service.callTool(OWNER, "ask_create", {
      kind: "decision",
      title: "Squash-only?",
      actions: [
        { label: "keep", kind: "resolve" },
        { label: "squash-only", kind: "resolve" },
      ],
    });
    await service.callTool(SIDE, "ask_resolve", { id: "A1", actionId: "a2", note: "squash-only; update AGENTS.md" });
    await outbox.flush();
    expect(store.get(WS, "A1")).toMatchObject({ status: "done", outcome: { by: "agent", label: "squash-only" } });
    expect(sent).toEqual(["[asks] A1 (Squash-only?) resolved in a side chat: squash-only. Summary: squash-only; update AGENTS.md"]);
  });

  it("a side chat dropping the owner's ask tells the owner", async () => {
    await prAsk(false);
    await service.callTool(SIDE, "ask_update", { id: "A1", status: "dropped" });
    await service.callTool(OWNER, "ask_update", { id: "A1", status: "open" });
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Merge PR #30) marked dropped in a side chat."]);
  });

  it("finds the PR url in links, trimming sub-pages", () => {
    expect(prUrlOf({ links: [{ label: "x", url: "https://github.com/o/r/pull/30/files" }] })).toBe("https://github.com/o/r/pull/30");
    expect(prUrlOf({ links: [{ label: "x", url: "https://github.com/o/r/issues/30" }] })).toBeUndefined();
  });

  it("summarizes check rollups", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("passing");
    expect(summarizeChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pending");
    expect(summarizeChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failing");
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("passing");
  });

  it("describes only the PR changes an agent would act on", () => {
    expect(describePrChange(pr(), pr({ fetchedAt: "later" }))).toBeNull();
    expect(describePrChange(pr(), pr({ checks: "failing" }))).toBe("PR #30 checks failing");
    expect(describePrChange(pr({ checks: "passing" }), pr({ checks: "pending" }))).toBeNull();
    expect(describePrChange(pr(), pr({ state: "MERGED", reviewDecision: "APPROVED" }))).toBe("PR #30 merged, review: approved");
  });

  it("refreshes PR state quietly, and tells a subscribed owner about a change", async () => {
    await prAsk(true);
    let next = pr();
    const watcher = new PrWatcher(store, service, async () => next);
    await watcher.refresh();
    await outbox.flush();
    expect(store.get(WS, "A1")?.pr?.checks).toBe("pending");
    expect(sent).toEqual([]);

    next = pr({ state: "MERGED" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Merge PR #30) PR #30 merged."]);
  });

  it("does not tell an owner who did not subscribe, and does not bump the ask's age", async () => {
    await prAsk(false);
    const before = store.get(WS, "A1")!.updatedAt;
    let next = pr();
    const watcher = new PrWatcher(store, service, async () => next);
    await watcher.refresh();
    next = pr({ checks: "failing" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(store.get(WS, "A1")).toMatchObject({ updatedAt: before, pr: { checks: "failing" } });
  });

  it("seeds a side chat with the ask, its option ids, and the owner's latest reply", async () => {
    await service.callTool(OWNER, "ask_create", {
      kind: "decision",
      title: "Squash-only?",
      body: "The release tool reads commit subjects.",
      actions: [
        { label: "keep", kind: "resolve" },
        { label: "squash-only", kind: "resolve", recommended: true },
      ],
    });
    const prompt = seedPrompt(store.get(WS, "A1")!, "Both PRs are green.");
    expect(prompt).toContain('call ask_resolve with id "A1"');
    expect(prompt).toContain("- actionId a2: squash-only (the main agent recommends this)");
    expect(prompt).toContain("The release tool reads commit subjects.");
    expect(prompt).toContain("Both PRs are green.");
    expect(prompt).toContain("Do not edit files");
  });

  it("takes the latest reply after the last user message, joining streamed parts", () => {
    expect(
      latestReply([
        { type: "user_message", text: "first" },
        { type: "assistant_message", text: "old" },
        { type: "user_message", text: "second" },
        { type: "assistant_message", text: "Hello, " },
        { type: "reasoning", text: "hmm" },
        { type: "assistant_message", text: "world." },
      ]),
    ).toBe("Hello, world.");
  });
});
