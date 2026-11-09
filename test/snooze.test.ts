import { describe, expect, it } from "vitest";
import { applyWorkspaceChange, snoozedIds } from "../shared/snooze";

describe("snoozedIds", () => {
  it("keeps workspaces with snoozedAt set", () => {
    const ids = snoozedIds([
      { id: "a", snoozedAt: "2026-11-09T10:00:00Z" },
      { id: "b", snoozedAt: null },
      { id: "c" },
    ]);
    expect([...ids]).toEqual(["a"]);
  });
});

describe("applyWorkspaceChange", () => {
  const ids = new Set(["a"]);

  it("adds a workspace when its snooze starts and drops it when the snooze ends", () => {
    expect([...applyWorkspaceChange(ids, { kind: "upsert", workspace: { id: "b", snoozedAt: "2026-11-09T10:00:00Z" } })]).toEqual(["a", "b"]);
    expect([...applyWorkspaceChange(ids, { kind: "upsert", workspace: { id: "a", snoozedAt: null } })]).toEqual([]);
  });

  it("treats a host without snooze fields as not snoozed", () => {
    expect([...applyWorkspaceChange(ids, { kind: "upsert", workspace: { id: "a" } })]).toEqual([]);
  });

  it("drops removed workspaces", () => {
    expect([...applyWorkspaceChange(ids, { kind: "remove", id: "a" })]).toEqual([]);
  });

  it("returns the same set when nothing changes", () => {
    expect(applyWorkspaceChange(ids, { kind: "upsert", workspace: { id: "b" } })).toBe(ids);
    expect(applyWorkspaceChange(ids, { kind: "upsert", workspace: { id: "a", snoozedAt: "2026-11-09T10:00:00Z" } })).toBe(ids);
  });
});
