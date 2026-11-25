import { describe, expect, it } from "vitest";
import { askDetail, waitingOnOf, workspaceAsks, type Ask, type PrState } from "../shared/asks";
import { createWorkspaceSummaries, summaryState } from "../client/summary";

const ask = (
  id: string,
  workspaceId: string,
  status: Ask["status"],
  createdAt: string,
  extra: Partial<Ask> = {},
): Parameters<typeof workspaceAsks>[0][number] => ({
  id,
  workspaceId,
  status,
  createdAt,
  updatedAt: createdAt,
  ownerAgentId: "agent-1",
  title: `Title ${id}`,
  kind: "question",
  actions: [],
  ...extra,
});

const pr = (patch: Partial<PrState> = {}): PrState => ({
  number: 30,
  url: "https://github.com/o/r/pull/30",
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  checks: "passing",
  mergeable: "MERGEABLE",
  fetchedAt: "2026-11-09T00:00:00Z",
  ...patch,
});

describe("askDetail", () => {
  it("names the kind and counts a decision's options", () => {
    const resolve = (id: string) => ({ id, label: id, kind: "resolve" as const });
    expect(askDetail({ kind: "decision", actions: [resolve("a"), resolve("b")] })).toBe("Decision · 2 options");
    expect(askDetail({ kind: "decision", actions: [resolve("a")] })).toBe("Decision · 1 option");
    expect(askDetail({ kind: "followup", actions: [{ id: "s", label: "Do it", kind: "send" }] })).toBe("Follow-up");
  });

  it("names a PR by number and flags an archived owner", () => {
    const pr = {
      number: 30,
      url: "https://github.com/o/r/pull/30",
      state: "OPEN" as const,
      isDraft: false,
      reviewDecision: null,
      checks: "passing" as const,
      mergeable: "MERGEABLE",
      fetchedAt: "2026-11-09T00:00:00Z",
    };
    expect(askDetail({ kind: "pr", actions: [], pr })).toBe("PR #30");
    expect(askDetail({ kind: "pr", actions: [], orphaned: true })).toBe("PR · agent archived");
  });
});

describe("workspaceAsks", () => {
  it("lists waiting asks oldest first, keeps the newest id, and reports workspaces with only closed or in-progress asks as 0", () => {
    const result = workspaceAsks(
      [
        ask("A1", "w1", "open", "2026-11-11T10:00:00Z"),
        ask("A3", "w1", "open", "2026-11-11T12:00:00Z", { kind: "action" }),
        ask("A2", "w1", "in_progress", "2026-11-11T11:00:00Z"),
        ask("A1", "w2", "done", "2026-11-11T09:00:00Z"),
        ask("A2", "w3", "in_progress", "2026-11-11T09:00:00Z"),
      ],
      new Set(),
    );
    expect(Object.fromEntries(result)).toEqual({
      w1: {
        count: 2,
        newestId: "A3",
        entries: [
          { id: "A1", title: "Title A1", detail: "Question" },
          { id: "A3", title: "Title A3", detail: "Action" },
        ],
        inProgress: [{ id: "A2", title: "Title A2", agentId: "agent-1", watched: false, waitingOnReview: false, updatedAt: Date.parse("2026-11-11T11:00:00Z") }],
      },
      w2: { count: 0, entries: [], inProgress: [] },
      w3: {
        count: 0,
        entries: [],
        inProgress: [{ id: "A2", title: "Title A2", agentId: "agent-1", watched: false, waitingOnReview: false, updatedAt: Date.parse("2026-11-11T09:00:00Z") }],
      },
    });
  });

  it("treats a snoozed workspace's asks as not waiting, like waitingCount", () => {
    const result = workspaceAsks([ask("A1", "w1", "open", "2026-11-11T10:00:00Z")], new Set(["w1"]));
    expect(result.get("w1")).toEqual({ count: 0, entries: [], inProgress: [] });
  });

  it("still lists a snoozed workspace's asks in progress, least recently changed first", () => {
    const result = workspaceAsks(
      [
        ask("A1", "w1", "in_progress", "2026-11-11T08:00:00Z", { updatedAt: "2026-11-11T12:00:00Z", waitingOn: "next release" }),
        ask("A2", "w1", "in_progress", "2026-11-11T09:00:00Z", {
          updatedAt: "2026-11-11T10:00:00Z",
          ownerAgentId: "agent-2",
          subscribe: true,
          pr: pr({ checks: "pending" }),
        }),
        ask("A3", "w1", "open", "2026-11-11T09:30:00Z"),
      ],
      new Set(["w1"]),
    );
    expect(result.get("w1")).toEqual({
      count: 0,
      entries: [],
      inProgress: [
        { id: "A2", title: "Title A2", waitingOn: "CI running", tone: "success", agentId: "agent-2", watched: true, waitingOnReview: false, updatedAt: Date.parse("2026-11-11T10:00:00Z") },
        { id: "A1", title: "Title A1", waitingOn: "next release", tone: "muted", agentId: "agent-1", watched: false, waitingOnReview: false, updatedAt: Date.parse("2026-11-11T12:00:00Z") },
      ],
    });
  });

  it("lists an ask in progress only in its own workspace, not the one it is explained in", () => {
    const result = workspaceAsks([ask("A1", "w1", "in_progress", "2026-11-11T08:00:00Z", { discussionWorkspaceId: "w2" })], new Set());
    expect(result.get("w1")?.inProgress.map((entry) => entry.id)).toEqual(["A1"]);
    expect(result.get("w2")?.inProgress).toEqual([]);
  });

  it("watches only a subscribed ask with a live owner and an open PR", () => {
    const watched = (extra: Partial<Ask>) =>
      workspaceAsks([ask("A1", "w1", "in_progress", "2026-11-11T08:00:00Z", extra)], new Set()).get("w1")!.inProgress[0].watched;
    expect(watched({ subscribe: true, pr: pr() })).toBe(true);
    expect(watched({ pr: pr() })).toBe(false);
    expect(watched({ subscribe: true, pr: pr({ state: "MERGED" }) })).toBe(false);
    expect(watched({ subscribe: true, orphaned: true, pr: pr() })).toBe(false);
    expect(watched({ subscribe: true })).toBe(false);
  });

  it("flags a watched ask whose PR waits on a requested review, not on checks", () => {
    const waitingOnReview = (extra: Partial<Ask>) =>
      workspaceAsks([ask("A1", "w1", "in_progress", "2026-11-11T08:00:00Z", extra)], new Set()).get("w1")!.inProgress[0].waitingOnReview;
    expect(waitingOnReview({ subscribe: true, pr: pr({ reviewDecision: "REVIEW_REQUIRED" }) })).toBe(true);
    expect(waitingOnReview({ subscribe: true, pr: pr({ reviewDecision: "REVIEW_REQUIRED", checks: "pending" }) })).toBe(false);
    expect(waitingOnReview({ pr: pr({ reviewDecision: "REVIEW_REQUIRED" }) })).toBe(false);
    expect(waitingOnReview({ subscribe: true, pr: pr({ reviewDecision: "APPROVED" }) })).toBe(false);
    expect(waitingOnReview({ waitingOn: "next release" })).toBe(false);
  });
});

describe("waitingOnOf", () => {
  it("reads a PR ask's wait from its PR: checks running, review requested, merged", () => {
    expect(waitingOnOf({ pr: pr({ checks: "pending", reviewDecision: "REVIEW_REQUIRED" }) })).toEqual({
      text: "CI running",
      tone: "success",
      line: "Waits on CI for #30",
    });
    expect(waitingOnOf({ pr: pr({ reviewDecision: "REVIEW_REQUIRED" }) })).toEqual({
      text: "review requested",
      tone: "muted",
      line: "Waits on a review of #30",
    });
    expect(waitingOnOf({ pr: pr({ state: "MERGED" }) })).toEqual({
      text: "merged · waiting on the agent",
      tone: "muted",
      line: "PR #30 merged · waiting on the agent",
    });
  });

  it("says nothing when neither the agent nor the PR does", () => {
    expect(waitingOnOf({})).toBeUndefined();
    expect(waitingOnOf({ pr: pr({ reviewDecision: "APPROVED" }) })).toBeUndefined();
    expect(waitingOnOf({ pr: pr({ state: "CLOSED", checks: "pending" }) })).toBeUndefined();
  });

  it("lets the agent's own waitingOn win over the PR", () => {
    expect(waitingOnOf({ waitingOn: "the staging reset", pr: pr({ checks: "pending" }) })).toEqual({
      text: "the staging reset",
      tone: "muted",
      line: "Waits on the staging reset",
    });
  });
});

describe("summaryState", () => {
  it("reports nothing waiting as 0 with no entries", () => {
    expect(summaryState(undefined)).toEqual({
      label: "Nothing waiting",
      count: 0,
      needsYou: false,
      key: undefined,
      panelId: "asks",
      entries: [],
      inProgress: [],
    });
  });

  it("carries the count, newest id, entries and asks in progress", () => {
    const entries = [{ id: "A4", title: "Pick a name", detail: "Decision · 2 options" }];
    const inProgress = [{ id: "A2", title: "PR #30", waitingOn: "CI running", tone: "success" as const, agentId: "a1", watched: true, updatedAt: 1 }];
    expect(summaryState({ count: 1, newestId: "A4", entries, inProgress })).toMatchObject({
      label: "1 waiting on you",
      count: 1,
      needsYou: true,
      key: "A4",
      entries,
      inProgress,
    });
  });
});

describe("createWorkspaceSummaries", () => {
  it("registers each workspace's item with the Overview entry renderer", () => {
    const added: Array<Record<string, unknown>> = [];
    const client = {
      addWorkspaceSummaryItem: (contribution: Record<string, unknown>) => {
        added.push(contribution);
        return { update: () => undefined, remove: () => undefined };
      },
    };
    const EntryComponent = () => null;
    const summaries = createWorkspaceSummaries(client as never, EntryComponent);
    summaries.set("w1", undefined);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: "asks", workspaceId: "w1", EntryComponent, count: 0 });
  });
});
