import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrState } from "../shared/asks";
import { prPreviewOf, prUrlOf } from "../shared/asks";
import { seedPrompt } from "../server/discuss";
import { Gh, RateLimited } from "../server/gh";
import { DEPLOYMENTS_RECHECK_MS, describePrChange, hostFetcher, PrReadFailed, PrReadsPaused, PrReadsUnavailable, prStateOf, type FetchPrs } from "../server/github";
import { latestReply } from "../server/last-output";
import { Outbox, type Courier } from "../server/outbox";
import { AsksService, instructions } from "../server/service";
import { ASK_FREQUENCIES, INSTRUCTIONS_LIMIT } from "../shared/instructions";
import { AskStore } from "../server/store";
import { PrWatcher } from "../server/watcher";

/** A one-URL fetch as the watcher's batch fetcher: errors that end the whole pass still throw. */
const each =
  (fetch: (url: string) => Promise<PrState>): FetchPrs =>
  async (urls) => {
    const results = new Map<string, PrState | Error>();
    for (const url of urls) {
      try {
        results.set(url, await fetch(url));
      } catch (error) {
        if (error instanceof RateLimited || error instanceof PrReadsPaused || error instanceof PrReadsUnavailable) throw error;
        results.set(url, error as Error);
      }
    }
    return results;
  };

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

  it("maps the host's PR read to the stored snapshot", () => {
    const read = {
      url: "https://github.com/o/r/pull/30",
      ok: true as const,
      number: 30,
      title: "Fix",
      state: "merged" as const,
      isDraft: false,
      mergeable: "conflicting" as const,
      reviewDecision: "changes_requested" as const,
      checksState: "failing" as const,
      checks: [],
      headSha: "abc",
    };
    expect(prStateOf(read, new Date("2026-01-01T00:00:00Z"))).toEqual({
      number: 30,
      url: "https://github.com/o/r/pull/30",
      state: "MERGED",
      isDraft: false,
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "CONFLICTING",
      checks: "failing",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(prStateOf({ ...read, state: "open", mergeable: undefined, reviewDecision: null, checksState: "none" })).toMatchObject({
      state: "OPEN",
      mergeable: "UNKNOWN",
      reviewDecision: null,
      checks: "none",
    });
  });

  it("fails a PR the host can't read, without gh", async () => {
    const fetch = hostFetcher(async (urls) => urls.map((url) => ({ url, ok: false as const, error: "unknown forge" })), null);
    const result = (await fetch(["https://example.com/o/r/pull/1"], new Map())).get("https://example.com/o/r/pull/1");
    expect(result).toBeInstanceOf(PrReadFailed);
  });

  describe("one pass's GitHub calls", () => {
    const URL_A = "https://github.com/o/r/pull/1";
    const URL_B = "https://github.com/o/r/pull/2";
    const NOW = Date.parse("2026-11-27T10:00:00Z");
    const open = (url: string, overrides: Record<string, unknown> = {}) => ({
      url,
      ok: true as const,
      number: Number(url.split("/").pop()),
      title: "Fix",
      state: "open" as const,
      isDraft: false,
      mergeable: "mergeable" as const,
      reviewDecision: null,
      checksState: "passing" as const,
      checks: [],
      headSha: "sha1",
      ...overrides,
    });
    const reader = (reads: Record<string, Record<string, unknown>> = {}) => {
      const calls: string[][] = [];
      const read = async (urls: string[]) => {
        calls.push(urls);
        return urls.map((url) => open(url, reads[url]));
      };
      return { calls, read };
    };
    const ghCounting = () => {
      const calls: string[][] = [];
      const gh = new Gh(async (args) => {
        calls.push(args);
        return JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { deployments: { nodes: [] } } }] } } } } });
      });
      return { calls, gh };
    };
    const looked = (overrides: Partial<PrState> = {}): PrState => pr({ headSha: "sha1", deployments: [], deploymentsAt: new Date(NOW - 60_000).toISOString(), ...overrides });

    it("reads every PR of a pass in one host read", async () => {
      const host = reader();
      const fetch = hostFetcher(host.read, null, () => NOW);
      const results = await fetch([URL_A, URL_B], new Map());
      expect(host.calls).toEqual([[URL_A, URL_B]]);
      expect([...results.keys()]).toEqual([URL_A, URL_B]);
    });

    it("keeps settled deployments of an unchanged head commit without asking gh", async () => {
      const { calls, gh } = ghCounting();
      const fetch = hostFetcher(reader().read, gh, () => NOW);
      const before = looked({ deployments: [{ label: "x.dev", state: "ready", url: "https://x.dev" }] });
      const result = (await fetch([URL_A], new Map([[URL_A, before]]))).get(URL_A) as PrState;
      expect(calls).toEqual([]);
      expect(result.deployments).toEqual(before.deployments);
      expect(result.deploymentsAt).toBe(before.deploymentsAt);
    });

    it("looks deployments up again when something says they may have changed", async () => {
      const cases: [string, Record<string, unknown>, Partial<PrState>][] = [
        ["a new head commit", { headSha: "sha2" }, {}],
        ["checks still running", { checksState: "pending" }, {}],
        ["a deployment still running", {}, { deployments: [{ label: "x.dev", state: "deploying" }] }],
        ["a lookup older than the recheck interval", {}, { deploymentsAt: new Date(NOW - DEPLOYMENTS_RECHECK_MS).toISOString() }],
        ["a snapshot from before head commits were kept", {}, { headSha: undefined, deploymentsAt: undefined }],
      ];
      for (const [, read, snapshot] of cases) {
        const { calls, gh } = ghCounting();
        const fetch = hostFetcher(reader({ [URL_A]: read }).read, gh, () => NOW);
        const result = (await fetch([URL_A], new Map([[URL_A, looked(snapshot)]]))).get(URL_A) as PrState;
        expect(calls).toHaveLength(1);
        expect(result.deploymentsAt).toBe(new Date(NOW).toISOString());
      }
    });

    it("never asks gh about a merged PR's deployments", async () => {
      const { calls, gh } = ghCounting();
      const fetch = hostFetcher(reader({ [URL_A]: { state: "merged" } }).read, gh, () => NOW);
      await fetch([URL_A], new Map());
      expect(calls).toEqual([]);
    });

    it("drops another commit's deployments when it can't look up the new ones", async () => {
      const fetch = hostFetcher(reader({ [URL_A]: { headSha: "sha2" } }).read, null, () => NOW);
      const before = looked({ deployments: [{ label: "x.dev", state: "ready", url: "https://x.dev" }] });
      const result = (await fetch([URL_A], new Map([[URL_A, before]]))).get(URL_A) as PrState;
      expect(result.deployments).toBeUndefined();
      expect(result.headSha).toBe("sha2");
    });

    it("fetches each PR once per pass however many asks link it", async () => {
      await prAsk(true);
      await service.callTool(OWNER, "ask_create", { kind: "followup", title: "Also on PR #30", links: [{ label: "PR", url: "https://github.com/o/r/pull/30" }] });
      const calls: (readonly string[])[] = [];
      const watcher = new PrWatcher(store, service, async (urls) => {
        calls.push(urls);
        return new Map(urls.map((url) => [url, pr()]));
      });
      await watcher.refresh();
      expect(calls).toEqual([["https://github.com/o/r/pull/30"]]);
    });
  });

  it("reports a host pause as paused, not as a failed PR", async () => {
    const fetch = hostFetcher(
      async (urls) => urls.map((url) => ({ url, ok: false as const, error: "Paused", reason: "paused" as const, retryAt: 5_000 })),
      null,
    );
    await expect(fetch(["https://github.com/o/r/pull/1"], new Map())).rejects.toMatchObject({ retryAt: 5_000 });
    await expect(fetch(["https://github.com/o/r/pull/1"], new Map())).rejects.toThrow(PrReadsPaused);
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
    const watcher = new PrWatcher(store, service, each(async () => next));
    await watcher.refresh();
    await outbox.flush();
    expect(store.get(WS, "A1")?.pr?.checks).toBe("pending");
    expect(sent).toEqual([]);

    next = pr({ state: "MERGED" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Merge PR #30) PR #30 merged."]);
  });

  it("keeps the last snapshot while the host can't read PRs", async () => {
    await prAsk(true);
    let available = true;
    const watcher = new PrWatcher(store, service, each(async () => {
      if (!available) throw new PrReadsUnavailable("Host lacks changeRequests.read");
      return pr();
    }));
    await watcher.refresh();
    available = false;
    await watcher.refresh();
    await outbox.flush();
    expect(store.get(WS, "A1")?.pr?.checks).toBe("pending");
    expect(sent).toEqual([]);
  });

  it("keeps the last snapshot while the host pauses reads, logging the pause once", async () => {
    await prAsk(true);
    let paused = false;
    let reads = 0;
    const watcher = new PrWatcher(store, service, each(async () => {
      reads++;
      if (paused) throw new PrReadsPaused(5_000);
      return pr();
    }));
    await watcher.refresh();
    paused = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await watcher.refresh();
      await watcher.refresh();
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
    await outbox.flush();
    expect(reads).toBe(3);
    expect(store.get(WS, "A1")?.pr?.checks).toBe("pending");
    expect(sent).toEqual([]);
  });

  it("keeps the last deployments when a lookup fails, and tells the owner when a preview becomes ready", async () => {
    await prAsk(true);
    const preview = { label: "pr-30.example.dev", url: "https://pr-30.example.dev" };
    let next = pr({ deployments: [{ ...preview, state: "deploying", link: "https://ci.example.com/1" }] });
    const watcher = new PrWatcher(store, service, each(async () => next));
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
    const watcher = new PrWatcher(store, service, each(async () => next));
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
    const watcher = new PrWatcher(store, service, each(async (url) => {
      fetched.push(url);
      return pr({ state: "MERGED" });
    }));
    await watcher.refresh();
    await watcher.refresh();
    expect(fetched).toEqual(["https://github.com/o/r/pull/30"]);
    expect(store.get(WS, "A1")?.pr?.state).toBe("MERGED");
  });

  it("keeps an orphaned ask's open PR fresh for the human without telling anyone", async () => {
    await prAsk(true);
    await store.update(WS, "A1", { orphaned: true });
    let next = pr();
    const watcher = new PrWatcher(store, service, each(async () => next));
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
    const watcher = new PrWatcher(store, service, each(async (url) => {
      fetched.push(url);
      return pr({ checks: "passing" });
    }));
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
    const watcher = new PrWatcher(store, service, each(async (url) => {
      fetched.push(url);
      return pr({ url });
    }));
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
    const watcher = new PrWatcher(store, service, each(async (url) => {
      fetched.push(url);
      throw new RateLimited(0);
    }));
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
      each(async (url) => {
        fetched.push(url);
        return pr({ url });
      }),
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
      each(async (url) => {
        fetched.push(url);
        return pr();
      }),
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
    const watcher = new PrWatcher(store, service, each(async () => next));
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
    const watcher = new PrWatcher(store, service, each(async () => next), async () => false);
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
    const watcher = new PrWatcher(store, service, each(async () => next), async () => false);
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
      each(async () => {
        if (closeDuringFetch) await store.update(WS, "A1", { status: "dropped" });
        return next;
      }),
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
    const watcher = new PrWatcher(store, service, each(async () => pr({ reviewDecision: "CHANGES_REQUESTED" })), async () => false);
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
    expect(held).toContain("Paseo raises an ask whose button sends it to you; don't start or offer it");
    expect(held.replace(/\n  - "CHANGES_REQUESTED".*\n/, "\n")).toBe(told.replace(/\n  - "CHANGES_REQUESTED".*\n/, "\n"));
  });

  it("tells agents not to ask about what the human settled", () => {
    for (const rules of [instructions(), instructions({ actOnReviewChanges: false })]) {
      expect(rules).toContain(`none for what's settled ("PR after I test")`);
    }
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
  it("fits every frequency and review variant in the 4096 characters Claude Code keeps, with the no-Merge review rules in them", () => {
    const variants = ASK_FREQUENCIES.flatMap((frequency) => [
      instructions({ frequency }),
      instructions({ frequency, actOnReviewChanges: false }),
    ]);
    for (const rules of variants) {
      expect(rules.length).toBeLessThanOrEqual(INSTRUCTIONS_LIMIT);
      expect(rules).toContain('"REVIEW_REQUIRED": no Merge action; the human picks a reviewer.');
      expect(rules).toContain('"CHANGES_REQUESTED": no Merge action.');
    }
  });

  it("raises a review ask when the setting is turned off after changes were requested", async () => {
    await prAsk(true);
    let held = false;
    const watcher = new PrWatcher(store, service, each(async () => pr({ reviewDecision: "CHANGES_REQUESTED" })), async () => !held);
    await watcher.refresh();
    expect(store.list(WS)).toHaveLength(1);

    held = true;
    await watcher.refresh();
    expect(store.list(WS).map((ask) => ask.title)).toEqual(["Merge PR #30", "Address review comments on PR #30"]);
  });

  it("does not bring a closed review ask back on every poll, only for a new round of changes", async () => {
    await prAsk(true);
    let next = pr({ reviewDecision: "CHANGES_REQUESTED" });
    const watcher = new PrWatcher(store, service, each(async () => next), async () => false);
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
      each(async (url) => {
        fetched.push(url);
        return pr({ reviewDecision: "CHANGES_REQUESTED" });
      }),
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
    const watcher = new PrWatcher(store, service, each(async () => next), async () => false);
    await watcher.refresh();
    next = pr({ checks: "failing", reviewDecision: "CHANGES_REQUESTED" });
    await watcher.refresh();
    await outbox.flush();
    expect(sent).toEqual(["[asks] A1 (Merge PR #30) PR #30 checks failing."]);
  });

  it("tells the owner about requested changes by default", async () => {
    await prAsk(true);
    let next = pr();
    const watcher = new PrWatcher(store, service, each(async () => next));
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
});
