import { describe, expect, it } from "vitest";
import { awaitsYou, type PrState } from "../shared/asks";

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
