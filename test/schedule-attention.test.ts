import { describe, expect, it } from "vitest";
import type { Ask } from "../shared/asks";
import { attentionForOpenAsks } from "../server/schedule-attention";

function ask(overrides: Partial<Ask>): Ask {
  return {
    id: "A1",
    workspaceId: "w1",
    ownerAgentId: "agent-1",
    kind: "followup",
    title: "Rebase #367 manually",
    actions: [],
    links: [],
    status: "open",
    createdAt: "2026-11-15T08:00:00Z",
    updatedAt: "2026-11-15T08:00:00Z",
    ...overrides,
  };
}

describe("attentionForOpenAsks", () => {
  it("flags a run whose agent left asks waiting on you, naming the newest", () => {
    const asks = [
      ask({}),
      ask({ id: "A2", title: "Land draft PR #103", createdAt: "2026-11-15T09:00:00Z" }),
    ];
    expect(attentionForOpenAsks(asks, "agent-1")).toEqual({
      reason: "plugin",
      message: "2 open asks: Land draft PR #103",
    });
  });

  it("ignores asks the agent is still working on, closed asks and other agents' asks", () => {
    const asks = [
      ask({ status: "in_progress" }),
      ask({ status: "done" }),
      ask({ ownerAgentId: "agent-2" }),
    ];
    expect(attentionForOpenAsks(asks, "agent-1")).toBeNull();
  });
});
