import { describe, expect, it } from "vitest";
import { awaitsYou, waitingCount, type PrState } from "../shared/asks";

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
  it("counts open asks with no PR or an open PR", () => {
    expect(awaitsYou({ status: "open" })).toBe(true);
    expect(awaitsYou({ status: "open", pr: pr("OPEN") })).toBe(true);
  });

  it("skips asks the agent is working on or that are closed", () => {
    for (const status of ["in_progress", "done", "dropped"] as const) expect(awaitsYou({ status })).toBe(false);
  });

  it("skips open asks about a PR that is already merged or closed", () => {
    expect(awaitsYou({ status: "open", pr: pr("MERGED") })).toBe(false);
    expect(awaitsYou({ status: "open", pr: pr("CLOSED") })).toBe(false);
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
    expect(waitingCount(asks, new Set())).toBe(2);
  });

  it("leaves out asks in snoozed workspaces", () => {
    expect(waitingCount(asks, new Set(["w2"]))).toBe(1);
    expect(waitingCount(asks, new Set(["w1", "w2"]))).toBe(0);
  });
});
