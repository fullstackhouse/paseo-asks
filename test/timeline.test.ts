import { describe, expect, it } from "vitest";
import { askCardFor } from "../shared/timeline";

const call = (name: string, status: string, input?: unknown, output?: unknown) => ({
  name,
  status,
  detail: { type: "unknown", input, output },
});

describe("askCardFor", () => {
  it("reads the new id from a string result", () => {
    expect(askCardFor(call("mcp__asks__ask_create", "completed", {}, "A3 [open] decision: Pick one"))).toEqual({ askId: "A3", verb: "create" });
  });

  it("reads the new id from an MCP content array", () => {
    const output = { content: [{ type: "text", text: "A12 [open] pr: Merge #4\nactions: a1 send \"Merge\"" }] };
    expect(askCardFor(call("mcp__asks__ask_create", "completed", {}, output))).toEqual({ askId: "A12", verb: "create" });
  });

  it("takes update and resolve ids from the input", () => {
    expect(askCardFor(call("mcp__asks__ask_update", "completed", { id: "A2", status: "dropped" }, "ok"))).toEqual({ askId: "A2", verb: "update" });
    expect(askCardFor(call("asks.ask_resolve", "completed", { id: "A1" }, "ok"))).toEqual({ askId: "A1", verb: "resolve" });
  });

  it("keeps running, failed and unrelated rows", () => {
    expect(askCardFor(call("mcp__asks__ask_create", "running", {}))).toBeUndefined();
    expect(askCardFor(call("mcp__asks__ask_create", "failed", {}, "A decision needs at least two \"resolve\" actions"))).toBeUndefined();
    expect(askCardFor(call("mcp__asks__ask_list", "completed", {}, "A1 [open] question: x"))).toBeUndefined();
    expect(askCardFor(call("Bash", "completed", { id: "A1" }))).toBeUndefined();
  });
});
