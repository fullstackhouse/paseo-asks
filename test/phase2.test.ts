import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { PrState } from "../shared/asks";
import { isMergeAction, prPreviewOf, prUrlOf, visibleActions } from "../shared/asks";
import { seedPrompt } from "../server/discuss";
import { RateLimited } from "../server/gh";
import { describePrChange, summarizeChecks } from "../server/github";
import { latestReply } from "../server/last-output";
import { Outbox, type Courier } from "../server/outbox";
import { AsksService, instructions } from "../server/service";
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

  it("previews only bare PR links; comment and file links open on GitHub", () => {
    expect(prPreviewOf("https://github.com/o/r/pull/30")).toBe("https://github.com/o/r/pull/30");
    expect(prPreviewOf("https://github.com/o/r/pull/30/")).toBe("https://github.com/o/r/pull/30");
    expect(prPreviewOf("https://github.com/o/r/pull/30#issuecomment-1")).toBeUndefined();
    expect(prPreviewOf("https://github.com/o/r/pull/30/files")).toBeUndefined();
    expect(prPreviewOf("https://github.com/o/r/pull/301")).toBe("https://github.com/o/r/pull/301");
    expect(prPreviewOf("https://github.com/o/r/issues/30")).toBeUndefined();
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

  it("tells the agent to read an approval's comments before offering Merge", () => {
    expect(describePrChange(pr(), pr({ reviewDecision: "APPROVED" }))).toBe(
      "PR #30 review: approved (read the review body and comments before offering Merge)",
    );
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

  it("keeps the last deployments when a lookup fails, and tells the owner when a preview becomes ready", async () => {
    await prAsk(true);
    const preview = { label: "pr-30.example.dev", url: "https://pr-30.example.dev" };
    let next = pr({ deployments: [{ ...preview, state: "deploying", link: "https://ci.example.com/1" }] });
    const watcher = new PrWatcher(store, service, async () => next);
    await watcher.refresh();

    next = pr();
    await watcher.refresh();
    expect(store.get(WS, "A1")?.pr?.deployments).toEqual([{ ...preview, state: "deploying", link: "https://ci.example.com/1" }]);

    next = pr({ deployments: [{ ...preview, state: "ready", link: preview.url }] });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Merge PR #30) PR #30 preview ready: https://pr-30.example.dev."]);
  });

  it("does not report a relinked ask's new PR as a change of the old one", async () => {
    // The ask first tracks a merged spec PR, then the agent relinks it to the implementation PR.
    await service.callTool(OWNER, "ask_create", {
      kind: "followup",
      title: "Implement the spec",
      links: [{ label: "Spec PR", url: "https://github.com/o/r/pull/29" }],
      subscribe: true,
    });
    let next = pr({ number: 29, url: "https://github.com/o/r/pull/29", state: "MERGED" });
    const watcher = new PrWatcher(store, service, async () => next);
    await watcher.refresh();

    await service.callTool(OWNER, "ask_update", { id: "A1", links: [{ label: "PR", url: "https://github.com/o/r/pull/30" }] });
    next = pr();
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(store.get(WS, "A1")?.pr).toMatchObject({ number: 30, state: "OPEN" });

    next = pr({ checks: "passing" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Implement the spec) PR #30 checks passing."]);
  });

  it("stops polling a PR ask once its PR is merged", async () => {
    await prAsk(true);
    const fetched: string[] = [];
    const watcher = new PrWatcher(store, service, async (url) => {
      fetched.push(url);
      return pr({ state: "MERGED" });
    });
    await watcher.refresh();
    await watcher.refresh();
    expect(fetched).toEqual(["https://github.com/o/r/pull/30"]);
    expect(store.get(WS, "A1")?.pr?.state).toBe("MERGED");
  });

  it("keeps an orphaned ask's open PR fresh for the human without telling anyone", async () => {
    await prAsk(true);
    await store.update(WS, "A1", { orphaned: true });
    let next = pr();
    const watcher = new PrWatcher(store, service, async () => next);
    await watcher.refresh();
    next = pr({ checks: "passing" });
    await watcher.refresh();
    await outbox.flush();
    expect(store.get(WS, "A1")?.pr?.checks).toBe("passing");
    expect(sent).toEqual([]);
  });

  it("reads a PR linked by several asks once per pass, and updates every one of them", async () => {
    await prAsk(true);
    await prAsk(true);
    const fetched: string[] = [];
    const watcher = new PrWatcher(store, service, async (url) => {
      fetched.push(url);
      return pr({ checks: "passing" });
    });
    await watcher.refresh();
    expect(fetched).toEqual(["https://github.com/o/r/pull/30"]);
    expect([store.get(WS, "A1")?.pr?.checks, store.get(WS, "A2")?.pr?.checks]).toEqual(["passing", "passing"]);
  });

  it("refreshes only the ask it is given", async () => {
    await prAsk(true);
    await service.callTool(OWNER, "ask_create", {
      kind: "pr",
      title: "Merge PR #31",
      links: [{ label: "PR", url: "https://github.com/o/r/pull/31" }],
    });
    const fetched: string[] = [];
    const watcher = new PrWatcher(store, service, async (url) => {
      fetched.push(url);
      return pr({ url });
    });
    await watcher.refresh({ workspaceId: WS, id: "A2" });
    expect(fetched).toEqual(["https://github.com/o/r/pull/31"]);
  });

  it("names the ask a tool call created, so the caller can refresh just that one", async () => {
    expect((await prAsk(true)).ask).toEqual({ workspaceId: WS, id: "A1" });
  });

  it("ends a pass at a spent rate limit instead of trying the remaining PRs", async () => {
    await prAsk(true);
    await service.callTool(OWNER, "ask_create", {
      kind: "pr",
      title: "Merge PR #31",
      links: [{ label: "PR", url: "https://github.com/o/r/pull/31" }],
    });
    const fetched: string[] = [];
    const watcher = new PrWatcher(store, service, async (url) => {
      fetched.push(url);
      throw new RateLimited(0);
    });
    await watcher.refresh();
    expect(fetched).toEqual(["https://github.com/o/r/pull/30"]);
  });

  it("polls only the PR asks of workspaces that are not archived", async () => {
    await prAsk(true);
    await store.create({
      workspaceId: "wks_archived",
      ownerAgentId: OWNER,
      kind: "pr",
      title: "Merge PR #31",
      links: [{ label: "PR", url: "https://github.com/o/r/pull/31" }],
      subscribe: true,
      actions: [],
    });
    const fetched: string[] = [];
    const watcher = new PrWatcher(
      store,
      service,
      async (url) => {
        fetched.push(url);
        return pr({ url });
      },
      async () => true,
      async () => new Set([WS]),
    );
    await watcher.refresh();
    expect(fetched).toEqual(["https://github.com/o/r/pull/30"]);
  });

  it("polls every PR ask when the daemon cannot list workspaces", async () => {
    await prAsk(true);
    const fetched: string[] = [];
    const watcher = new PrWatcher(
      store,
      service,
      async (url) => {
        fetched.push(url);
        return pr();
      },
      async () => true,
      async () => {
        throw new Error("daemon unavailable");
      },
    );
    await watcher.refresh();
    expect(fetched).toEqual(["https://github.com/o/r/pull/30"]);
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

  it("leaves the review out of a change when asked to", () => {
    const before = pr({ checks: "pending" });
    const after = pr({ checks: "failing", reviewDecision: "CHANGES_REQUESTED" });
    expect(describePrChange(before, after, { review: false })).toBe("PR #30 checks failing");
    expect(describePrChange(pr(), pr({ reviewDecision: "CHANGES_REQUESTED" }), { review: false })).toBeNull();
  });

  it("holds requested changes as an ask instead of telling the owner, once per open ask", async () => {
    await prAsk(true);
    let next = pr();
    const watcher = new PrWatcher(store, service, async () => next, async () => false);
    await watcher.refresh();

    next = pr({ reviewDecision: "CHANGES_REQUESTED" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual([]);
    const raised = store.list(WS).filter((ask) => ask.id !== "A1");
    expect(raised).toMatchObject([
      {
        ownerAgentId: OWNER,
        kind: "followup",
        status: "open",
        title: "Address review comments on PR #30",
        links: [{ url: "https://github.com/o/r/pull/30" }],
        actions: [{ kind: "send", label: "Address review comments" }],
      },
    ]);

    next = pr({ reviewDecision: "REVIEW_REQUIRED" });
    await watcher.refresh();
    next = pr({ reviewDecision: "CHANGES_REQUESTED" });
    await watcher.refresh();
    expect(store.list(WS)).toHaveLength(2);

    await service.act({ workspaceId: WS, id: raised[0]!.id, verb: "action", actionId: raised[0]!.actions[0]!.id });
    await outbox.flush();
    expect(sent.at(-1)).toContain(
      "Address the review comments on PR #30 (https://github.com/o/r/pull/30), or report what you won't change, and push; then ask_update A1 with a send action that re-requests the review, not a Merge action",
    );
  });

  it("raises a fresh review ask when the open one belongs to a gone owner", async () => {
    await store.create({
      workspaceId: WS,
      ownerAgentId: "gone",
      kind: "followup",
      title: "Address review comments on PR #30",
      links: [{ label: "PR #30", url: "https://github.com/o/r/pull/30" }],
      actions: [],
      heldReview: true,
    });
    await store.update(WS, "A1", { orphaned: true });
    await prAsk(true);
    let next = pr();
    const watcher = new PrWatcher(store, service, async () => next, async () => false);
    await watcher.refresh();
    next = pr({ reviewDecision: "CHANGES_REQUESTED" });
    await watcher.refresh();
    expect(store.list(WS).filter((ask) => ask.title.startsWith("Address")).map((ask) => ask.ownerAgentId)).toEqual(["gone", OWNER]);
  });

  it("raises nothing for an ask the human closed while gh was running", async () => {
    await prAsk(true);
    let next = pr();
    let closeDuringFetch = false;
    const watcher = new PrWatcher(
      store,
      service,
      async () => {
        if (closeDuringFetch) await store.update(WS, "A1", { status: "dropped" });
        return next;
      },
      async () => false,
    );
    await watcher.refresh();
    next = pr({ checks: "failing", reviewDecision: "CHANGES_REQUESTED" });
    closeDuringFetch = true;
    await watcher.refresh();
    await outbox.flush();
    expect(store.list(WS)).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("raises a review ask for a PR that already has changes requested when its ask is first seen", async () => {
    await prAsk(true);
    const watcher = new PrWatcher(store, service, async () => pr({ reviewDecision: "CHANGES_REQUESTED" }), async () => false);
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(store.list(WS).map((ask) => ask.title)).toEqual(["Merge PR #30", "Address review comments on PR #30"]);
  });

  it("tells agents to leave requested changes to the human only while reviews are held", () => {
    const told = instructions();
    const held = instructions({ actOnReviewChanges: false });
    expect(told).toContain('"CHANGES_REQUESTED": no Merge action. Address the comments');
    expect(held).not.toContain("Address the comments");
    expect(held).toContain("Don't start or offer it yourself");
    expect(held.replace(/\n  - "CHANGES_REQUESTED".*\n/, "\n")).toBe(told.replace(/\n  - "CHANGES_REQUESTED".*\n/, "\n"));
  });

  it("tells agents to read every review and comment before a Merge action, approvals included", () => {
    for (const rules of [instructions(), instructions({ actOnReviewChanges: false })]) {
      expect(rules).toContain("Before any Merge action, read every human review and comment, approvals included (not bot status ones)");
      expect(rules).toContain("gh api --paginate repos/OWNER/REPO/pulls/N/comments");
      expect(rules).toContain("Resolved threads (reviewThreads { isResolved }, gh api graphql) don't count");
      expect(rules).toContain("then offer Merge (not a re-review unless asked), naming what changed");
    }
    expect(instructions({ actOnReviewChanges: false })).toContain("An approved PR's comments raise none");
  });

  // Claude Code cuts MCP server instructions at 4096 characters and appends "… [truncated]". An agent that lost the
  // REVIEW_REQUIRED rule to that cut offered Merge on a PR still waiting for its review.
  it("fits the instructions in the 4096 characters Claude Code keeps, with the no-Merge review rules in them", () => {
    for (const rules of [instructions(), instructions({ actOnReviewChanges: false })]) {
      expect(rules.length).toBeLessThanOrEqual(4096);
      expect(rules).toContain('"REVIEW_REQUIRED": no Merge action; the human picks a reviewer.');
      expect(rules).toContain('"CHANGES_REQUESTED": no Merge action.');
    }
  });

  it("raises a review ask when the setting is turned off after changes were requested", async () => {
    await prAsk(true);
    let held = false;
    const watcher = new PrWatcher(store, service, async () => pr({ reviewDecision: "CHANGES_REQUESTED" }), async () => !held);
    await watcher.refresh();
    expect(store.list(WS)).toHaveLength(1);

    held = true;
    await watcher.refresh();
    expect(store.list(WS).map((ask) => ask.title)).toEqual(["Merge PR #30", "Address review comments on PR #30"]);
  });

  it("does not bring a closed review ask back on every poll, only for a new round of changes", async () => {
    await prAsk(true);
    let next = pr({ reviewDecision: "CHANGES_REQUESTED" });
    const watcher = new PrWatcher(store, service, async () => next, async () => false);
    await watcher.refresh();
    await service.act({ workspaceId: WS, id: "A2", verb: "drop" });
    await watcher.refresh();
    await watcher.refresh();
    expect(store.list(WS).filter((ask) => ask.heldReview).map((ask) => ask.status)).toEqual(["dropped"]);

    next = pr({ reviewDecision: "REVIEW_REQUIRED" });
    await watcher.refresh();
    next = pr({ reviewDecision: "CHANGES_REQUESTED" });
    await watcher.refresh();
    expect(store.list(WS).filter((ask) => ask.heldReview).map((ask) => ask.status)).toEqual(["dropped", "open"]);
  });

  it("does not poll the PR again for a held review's own ask", async () => {
    await prAsk(true);
    const fetched: string[] = [];
    const watcher = new PrWatcher(
      store,
      service,
      async (url) => {
        fetched.push(url);
        return pr({ reviewDecision: "CHANGES_REQUESTED" });
      },
      async () => false,
    );
    await watcher.refresh();
    expect(store.list(WS)).toHaveLength(2);
    fetched.length = 0;
    await watcher.refresh();
    expect(fetched).toEqual(["https://github.com/o/r/pull/30"]);
  });

  it("still tells the owner about checks and merges while holding reviews", async () => {
    await prAsk(true);
    let next = pr();
    const watcher = new PrWatcher(store, service, async () => next, async () => false);
    await watcher.refresh();
    next = pr({ checks: "failing", reviewDecision: "CHANGES_REQUESTED" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Merge PR #30) PR #30 checks failing."]);
  });

  it("tells the owner about requested changes by default", async () => {
    await prAsk(true);
    let next = pr();
    const watcher = new PrWatcher(store, service, async () => next);
    await watcher.refresh();
    next = pr({ reviewDecision: "CHANGES_REQUESTED" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Merge PR #30) PR #30 review: changes requested."]);
    expect(store.list(WS)).toHaveLength(1);
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
    expect(prompt).toContain("Start with a short brief");
  });

  it("opens a side chat with the note the human typed instead of a brief", async () => {
    await service.callTool(OWNER, "ask_create", { kind: "question", title: "Squash-only?" });
    const prompt = seedPrompt(store.get(WS, "A1")!, undefined, "Why not rebase?");
    expect(prompt).toContain("The human opened this chat with:\n\nWhy not rebase?");
    expect(prompt).not.toContain("Start with a short brief");
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

  describe("no Merge action while the PR needs a review", () => {
    const PR_URL = "https://github.com/o/r/pull/30";
    let decision: string | null;
    let lookups: string[];
    const gated = (actOnReviewChanges = true) => {
      const dir = mkdtempSync(join(tmpdir(), "asks-"));
      store = new AskStore(dir);
      outbox = new Outbox(dir, { state: async () => "idle", send: async (_agent, text) => void sent.push(text) });
      const reviewOf = async (url: string) => {
        lookups.push(url);
        return { number: 30, state: "OPEN" as const, reviewDecision: decision };
      };
      service = new AsksService(store, outbox, async () => WS, undefined, undefined, reviewOf, async () => actOnReviewChanges);
    };
    const merge = { label: "Merge (squash)", kind: "send" as const, prompt: "Merge PR #30 with squash" };
    const createWith = (actions: object[]) =>
      service.callTool(OWNER, "ask_create", { kind: "pr", title: "PR #30", links: [{ label: "PR", url: PR_URL }], actions, subscribe: true });

    beforeEach(() => {
      decision = "REVIEW_REQUIRED";
      lookups = [];
      gated();
    });

    it("refuses a Merge action and names reviewer choices instead, saving nothing", async () => {
      const result = await createWith([merge]);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('PR #30 is REVIEW_REQUIRED on GitHub, so this ask cannot offer "Merge (squash)". Nothing was saved.');
      expect(result.text).toContain("one send action per candidate reviewer");
      expect(store.list(WS)).toEqual([]);
      expect(lookups).toEqual([PR_URL]);
    });

    it("refuses a conditional Merge too, and one whose prompt alone says merge", async () => {
      expect((await createWith([{ ...merge, label: "Merge (squash) when green" }])).isError).toBe(true);
      expect((await createWith([{ label: "Ship it", kind: "send", prompt: "Merge PR #30 once checks pass" }])).isError).toBe(true);
    });

    it("lets review requests and an explicit --admin merge through", async () => {
      const result = await createWith([
        { label: "Request review from alice", kind: "send", prompt: "Request review on PR #30 from alice, then merge once approved" },
        { label: "Merge with --admin", kind: "send", prompt: "Merge PR #30 with gh pr merge --squash --admin" },
      ]);
      expect(result.isError).toBeFalsy();
    });

    it("tells the agent to address requested changes, or to wait for the human when reviews are held", async () => {
      decision = "CHANGES_REQUESTED";
      expect((await createWith([merge])).text).toContain("Address the comments, or report what you will not change, and push.");
      gated(false);
      expect((await createWith([merge])).text).toContain('wait for the "Address review comments on PR #30" ask');
    });

    it("allows Merge on an approved PR, or when the decision can't be read", async () => {
      decision = "APPROVED";
      expect((await createWith([merge])).isError).toBeFalsy();
      decision = null;
      expect((await createWith([merge])).isError).toBeFalsy();
      service = new AsksService(store, outbox, async () => WS, undefined, undefined, async () => {
        throw new Error("gh: not logged in");
      });
      expect((await createWith([merge])).isError).toBeFalsy();
    });

    it("reads the PR only when a Merge action meets a PR link", async () => {
      await createWith([{ label: "Request review from alice", kind: "send", prompt: "Request review on PR #30 from alice" }]);
      await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Merge the docs", actions: [merge] });
      expect(lookups).toEqual([]);
    });

    it("refuses an update that adds Merge, or links a PR under an existing one", async () => {
      await createWith([{ label: "Request review from alice", kind: "send", prompt: "Request review on PR #30 from alice" }]);
      const added = await service.callTool(OWNER, "ask_update", { id: "A1", actions: [merge] });
      expect(added.isError).toBe(true);
      expect(store.get(WS, "A1")!.actions.map((action) => action.label)).toEqual(["Request review from alice"]);

      await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Merge when ready", actions: [merge] });
      expect((await service.callTool(OWNER, "ask_update", { id: "A2", links: [{ label: "PR", url: PR_URL }] })).isError).toBe(true);
      expect((await service.callTool(OWNER, "ask_update", { id: "A2", body: "Still waiting" })).isError).toBeFalsy();
    });

    it("hides an existing Merge button once the PR needs a review, and refuses a stale click", async () => {
      decision = "APPROVED";
      await createWith([merge, { label: "Request review from bob", kind: "send", prompt: "Request review on PR #30 from bob" }]);
      await store.update(WS, "A1", { pr: pr({ reviewDecision: "REVIEW_REQUIRED" }) });
      const ask = store.get(WS, "A1")!;
      expect(visibleActions(ask).map((action) => action.label)).toEqual(["Request review from bob"]);
      await expect(service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: ask.actions[0]!.id })).rejects.toThrow(
        'PR #30 still needs a review, so "Merge (squash)" is not offered until it is approved',
      );
      expect(store.get(WS, "A1")!.status).toBe("open");

      await store.update(WS, "A1", { pr: pr({ reviewDecision: "APPROVED" }) });
      expect(visibleActions(store.get(WS, "A1")!)).toHaveLength(2);
    });

    const REOFFER =
      "Its Merge action is hidden while the PR is review required: ask_update A1 with what the human does now (reviewer choices, or a re-request once you have addressed the changes).";

    it("tells the owner to re-offer when a new required review hides its Merge button", async () => {
      decision = "APPROVED";
      await createWith([merge]);
      let next = pr({ reviewDecision: "APPROVED" });
      const watcher = new PrWatcher(store, service, async () => next);
      await watcher.refresh();
      next = pr({ reviewDecision: "REVIEW_REQUIRED" });
      await watcher.refresh();
      await watcher.refresh();
      await outbox.flush();
      expect(sent).toEqual([`[asks] A1 (PR #30) PR #30 review: review required. ${REOFFER}`]);
    });

    it("tells the owner once when the first snapshot already hides Merge, subscribed or not", async () => {
      // An ask from before the check, or one that got through a failed gh read.
      await store.create({ workspaceId: WS, ownerAgentId: OWNER, kind: "pr", title: "PR #30", links: [{ label: "PR", url: PR_URL }], actions: [merge] });
      const watcher = new PrWatcher(store, service, async () => pr({ reviewDecision: "REVIEW_REQUIRED" }));
      await watcher.refresh();
      await watcher.refresh();
      await outbox.flush();
      expect(sent).toEqual([`[asks] A1 (PR #30) PR #30: ${REOFFER}`]);
    });

    it("tells the owner again after it re-offers Merge and a review hides it again", async () => {
      await store.create({ workspaceId: WS, ownerAgentId: OWNER, kind: "pr", title: "PR #30", links: [{ label: "PR", url: PR_URL }], actions: [merge] });
      let next = pr({ reviewDecision: "REVIEW_REQUIRED" });
      const watcher = new PrWatcher(store, service, async () => next);
      await watcher.refresh();
      decision = "APPROVED";
      next = pr({ reviewDecision: "APPROVED" });
      await watcher.refresh();
      expect(store.get(WS, "A1")!.mergeHiddenNotice).toBeUndefined();
      next = pr({ reviewDecision: "REVIEW_REQUIRED" });
      await watcher.refresh();
      await outbox.flush();
      expect(sent.filter((text) => text.includes("Merge action is hidden"))).toHaveLength(2);
    });

    it("forgets the notice when the owner offers new actions", async () => {
      await store.create({ workspaceId: WS, ownerAgentId: OWNER, kind: "pr", title: "PR #30", links: [{ label: "PR", url: PR_URL }], actions: [merge] });
      await new PrWatcher(store, service, async () => pr({ reviewDecision: "REVIEW_REQUIRED" })).refresh();
      expect(store.get(WS, "A1")!.mergeHiddenNotice).toBe("REVIEW_REQUIRED");
      await service.callTool(OWNER, "ask_update", { id: "A1", actions: [{ label: "Request review from alice", kind: "send", prompt: "Request review on PR #30 from alice" }] });
      expect(store.get(WS, "A1")!.mergeHiddenNotice).toBeUndefined();
    });

    it("leaves held requested changes to the Address ask", async () => {
      await store.create({ workspaceId: WS, ownerAgentId: OWNER, kind: "pr", title: "PR #30", links: [{ label: "PR", url: PR_URL }], actions: [merge] });
      const watcher = new PrWatcher(store, service, async () => pr({ reviewDecision: "CHANGES_REQUESTED" }), async () => false);
      await watcher.refresh();
      await outbox.flush();
      expect(sent).toEqual([]);
    });

    it("recognises merge actions by label or prompt", () => {
      expect(isMergeAction({ kind: "send", label: "Merge (squash)" })).toBe(true);
      expect(isMergeAction({ kind: "send", label: "Ship", prompt: "merge PR #30" })).toBe(true);
      expect(isMergeAction({ kind: "resolve", label: "Merge" })).toBe(false);
      expect(isMergeAction({ kind: "send", label: "Merge with --admin" })).toBe(false);
      expect(isMergeAction({ kind: "send", label: "Request review from alice", prompt: "then merge" })).toBe(false);
      expect(isMergeAction({ kind: "send", label: "Fix merge conflicts", prompt: "Resolve the merge conflict on PR #30" })).toBe(false);
      expect(isMergeAction({ kind: "send", label: "Start once #12 is merged" })).toBe(false);
      expect(isMergeAction({ kind: "send", label: "QA, then merge when green" })).toBe(true);
      expect(isMergeAction({ kind: "send", label: "Merge both when green" })).toBe(true);
      expect(isMergeAction({ kind: "send", label: "Rebase", prompt: "Rebase and merge PR #30" })).toBe(true);
      expect(isMergeAction({ kind: "send", label: "Land it", prompt: "Run gh pr merge 30 --squash" })).toBe(true);
      expect(isMergeAction({ kind: "send", label: "Start phase 2 (after merge #12)" })).toBe(false);
      expect(isMergeAction({ kind: "send", label: "Start the migration", prompt: "Wait for PR #12 to merge, then start the migration" })).toBe(false);
      expect(isMergeAction({ kind: "send", label: "Close it", prompt: "Close PR #30, don't merge it" })).toBe(false);
    });
  });
});
