import { describe, expect, it } from "vitest";
import { askDetail, workspaceAsks, type Ask } from "../shared/asks";
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
  title: `Title ${id}`,
  kind: "question",
  actions: [],
  ...extra,
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
      },
      w2: { count: 0, entries: [] },
      w3: { count: 0, entries: [] },
    });
  });

  it("treats a snoozed workspace's asks as not waiting, like waitingCount", () => {
    const result = workspaceAsks([ask("A1", "w1", "open", "2026-11-11T10:00:00Z")], new Set(["w1"]));
    expect(result.get("w1")).toEqual({ count: 0, entries: [] });
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
    });
  });

  it("carries the count, newest id and entries", () => {
    const entries = [{ id: "A4", title: "Pick a name", detail: "Decision · 2 options" }];
    expect(summaryState({ count: 1, newestId: "A4", entries })).toMatchObject({
      label: "1 waiting on you",
      count: 1,
      needsYou: true,
      key: "A4",
      entries,
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
