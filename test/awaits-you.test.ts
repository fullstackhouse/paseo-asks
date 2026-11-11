import { describe, expect, it } from "vitest";
import { awaitsYou, waitingByWorkspace, waitingCount, type PrState, type Ask } from "../shared/asks";

import { askQueue } from "../client/queue";

const pr = (state: PrState["state"]): PrState => ({
  number: 1,
  url: "https://github.com/o/r/pull/1",
  state,
  isDraft: false,
  reviewDecision: null,
  checks: "passing",
  mergeable: "MERGEABLE",
  fetchedAt: "2026-11-09T00:00:00Z",
});

describe("awaitsYou", () => {
  it("counts open asks", () => {
    expect(awaitsYou({ status: "open" })).toBe(true);
  });

  it("skips asks the agent is working on or that are closed", () => {
    for (const status of ["in_progress", "done", "dropped"] as const)
      expect(awaitsYou({ status })).toBe(false);
  });
});

describe("waitingCount", () => {
  const asks = [
    { status: "open", workspaceId: "w1" },
    { status: "open", workspaceId: "w2" },
    { status: "open", workspaceId: "w2", pr: pr("MERGED") },
    { status: "in_progress", workspaceId: "w1" },
  ] as const;

  it("counts asks waiting on you", () => {
    expect(waitingCount(asks, new Set())).toBe(3);
  });

  it("leaves out asks in snoozed workspaces", () => {
    expect(waitingCount(asks, new Set(["w2"]))).toBe(1);
    expect(waitingCount(asks, new Set(["w1", "w2"]))).toBe(0);
  });
});

describe("main ask queue", () => {
  const snoozed = new Set(["later"]);
  const ask = (id: string, fields: Partial<Ask> = {}): Ask => ({
    id,
    workspaceId: "workspace",
    ownerAgentId: "agent",
    title: id,
    kind: "decision",
    status: "open",
    actions: [],
    links: [],
    createdAt: "2026-11-09T00:00:00Z",
    updatedAt: "2026-11-09T00:00:00Z",
    ...fields,
  });

  it("uses the sidebar attention rules and keeps snoozed asks accessible", () => {
    const asks = [
      ask("decision"),
      ask("pr", { pr: pr("OPEN") }),
      ask("working", { status: "in_progress" }),
      ask("merged", { pr: pr("MERGED") }),
      ask("closed", { pr: pr("CLOSED") }),
      ask("later", { workspaceId: "later" }),
      ask("working-later", { workspaceId: "later", status: "in_progress" }),
      ask("merged-working", { status: "in_progress", pr: pr("MERGED") }),
      ask("done", { status: "done" }),
      ask("dropped", { status: "dropped" }),
    ];
    const queue = askQueue(asks, snoozed);
    expect(queue.needs_you.map((item) => item.id)).toEqual(["decision", "pr", "merged", "closed"]);
    expect(queue.needs_you).toHaveLength(waitingCount(asks, snoozed));
    expect(queue.in_progress.map((item) => item.id)).toEqual(["working", "merged-working"]);
    expect(queue.other.map((item) => item.id)).toEqual(["later", "working-later"]);
  });

  it("orders each view by newest update without changing the input", () => {
    const asks = [ask("older"), ask("newer", { updatedAt: "2026-11-09T01:00:00Z" })];
    expect(askQueue(asks, snoozed).needs_you.map((item) => item.id)).toEqual(["newer", "older"]);
    expect(asks.map((item) => item.id)).toEqual(["older", "newer"]);
  });

  it("moves an ask back to Needs you when its workspace wakes", () => {
    const asks = [ask("later", { workspaceId: "later" })];
    expect(askQueue(asks, snoozed).needs_you).toHaveLength(0);
    expect(askQueue(asks, new Set()).needs_you).toHaveLength(1);
  });
});

describe("waitingByWorkspace", () => {
  const ask = (id: string, workspaceId: string, status: Ask["status"], createdAt: string) => ({
    id,
    workspaceId,
    status,
    createdAt,
  });

  it("counts open asks per workspace and keeps the newest id", () => {
    const result = waitingByWorkspace([
      ask("a1", "w1", "open", "2026-11-11T10:00:00Z"),
      ask("a2", "w1", "open", "2026-11-11T11:00:00Z"),
      ask("a3", "w1", "done", "2026-11-11T12:00:00Z"),
      ask("b1", "w2", "in_progress", "2026-11-11T09:00:00Z"),
    ]);
    expect([...result]).toEqual([["w1", { count: 2, newestId: "a2" }]]);
  });
});
