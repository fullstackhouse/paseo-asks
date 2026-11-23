import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Outbox } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { askCardFor, AskCardSchema, callKey } from "../shared/timeline";

const call = (name: string, status: string, input?: unknown, output?: unknown) => ({
  name,
  status,
  detail: { type: "unknown", input, output },
});

describe("askCardFor", () => {
  it("reads the new id from a string result", () => {
    expect(askCardFor(call("mcp__asks__ask_create", "completed", {}, "A3 [open] decision: Pick one"))).toMatchObject({ askId: "A3", verb: "create" });
  });

  it("reads the new id from an MCP content array", () => {
    const output = { content: [{ type: "text", text: "A12 [open] pr: Merge #4\nactions: a1 send \"Merge\"" }] };
    expect(askCardFor(call("mcp__asks__ask_create", "completed", {}, output))).toMatchObject({ askId: "A12", verb: "create" });
  });

  it.each([
    ["an object holding a string", { result: "A2 [open] question: Ship on Friday?" }],
    ["a JSON string", JSON.stringify({ text: "A2 [open] question: Ship on Friday?" })],
    ["a content array", [{ type: "text", text: "A2 [open] question: Ship on Friday?" }]],
  ])("reads the result from %s", (_, output) => {
    const card = askCardFor(call("mcp__asks__ask_create", "completed", {}, output));
    expect(card).toMatchObject({ askId: "A2", snapshot: { title: "Ship on Friday?" } });
  });

  it("takes update and resolve ids from the input", () => {
    expect(askCardFor(call("mcp__asks__ask_update", "completed", { id: "A2", status: "dropped" }, "ok"))).toMatchObject({ askId: "A2", verb: "update" });
    expect(askCardFor(call("asks.ask_resolve", "completed", { id: "A1" }, "ok"))).toMatchObject({ askId: "A1", verb: "resolve" });
  });

  it("keeps running, failed and unrelated rows", () => {
    expect(askCardFor(call("mcp__asks__ask_create", "running", {}))).toBeUndefined();
    expect(askCardFor(call("mcp__asks__ask_create", "failed", {}, "A decision needs at least two \"resolve\" actions"))).toBeUndefined();
    expect(askCardFor(call("mcp__asks__ask_list", "completed", {}, "A1 [open] question: x"))).toBeUndefined();
    expect(askCardFor(call("Bash", "completed", { id: "A1" }))).toBeUndefined();
  });

  it("snapshots a create from its input and result", () => {
    const input = {
      kind: "decision",
      title: "Pick one",
      body: "Facts.",
      actions: [{ label: "A", kind: "resolve" }, { label: "B", kind: "resolve", recommended: true }],
      links: [{ label: "PR", url: "https://github.com/o/r/pull/1" }],
    };
    const card = askCardFor(call("mcp__asks__ask_create", "completed", input, "A3 [open] decision: Pick one\nactions: a1 resolve \"A\", a2 resolve \"B\""));
    expect(card?.snapshot).toEqual({
      status: "open",
      kind: "decision",
      title: "Pick one",
      body: "Facts.",
      actions: [{ label: "A" }, { label: "B", recommended: true }],
      links: [{ label: "PR", url: "https://github.com/o/r/pull/1" }],
    });
    expect(card?.changed).toEqual([]);
    // Timeline data must survive the renderer's schema and JSON.
    expect(AskCardSchema.parse(JSON.parse(JSON.stringify(card)))).toEqual(card);
  });

  it("lists what an update set, with the state it left", () => {
    const card = askCardFor(call("mcp__asks__ask_update", "completed", { id: "A3", title: "Pick two", status: "in_progress" }, "A3 [in_progress] decision: Pick two"));
    expect(card?.changed).toEqual(["title", "status"]);
    expect(card?.snapshot).toEqual({ status: "in_progress", kind: "decision", title: "Pick two" });
  });

  it("names the option a resolve picked", () => {
    const card = askCardFor(
      call("mcp__asks__ask_resolve", "completed", { id: "A3", actionId: "a2", note: "Shipped" }, "A3 [done] decision: Pick one\nactions: a1 resolve \"A\", a2 resolve \"B\""),
    );
    expect(card?.snapshot).toMatchObject({ status: "done", choice: "B", note: "Shipped" });
  });
});

describe("callKey", () => {
  it("ignores key order and reads JSON-string arguments", () => {
    const key = callKey("update", { id: "A1", title: "x", actions: [{ label: "a", kind: "send" }] });
    expect(callKey("update", { actions: [{ kind: "send", label: "a" }], title: "x", id: "A1" })).toBe(key);
    expect(callKey("update", JSON.stringify({ title: "x", id: "A1", actions: [{ label: "a", kind: "send" }] }))).toBe(key);
    expect(callKey("resolve", { id: "A1", title: "x", actions: [{ label: "a", kind: "send" }] })).not.toBe(key);
    expect(callKey("update", { id: "A1", title: "y", actions: [{ label: "a", kind: "send" }] })).not.toBe(key);
  });
});

describe("live card", () => {
  const WS = "wks_1";
  const AGENT = "agent-1";
  const service = () => {
    const dir = mkdtempSync(join(tmpdir(), "asks-timeline-"));
    const store = new AskStore(dir);
    const outbox = new Outbox(dir, { state: async () => "idle", send: async () => {} }, async () => {});
    return { store, service: new AsksService(store, outbox, async () => WS) };
  };

  it("matches only the agent's latest call on the ask", async () => {
    const { store, service: asks } = service();
    const create = { kind: "question", title: "Which port?" };
    const created = await asks.callTool(AGENT, "ask_create", create);
    const createCard = askCardFor(call("mcp__asks__ask_create", "completed", create, created.text))!;
    expect(store.get(WS, "A1")?.lastCall).toBe(createCard.call);

    const update = { id: "A1", body: "6767 is taken." };
    const updated = await asks.callTool(AGENT, "ask_update", update);
    const updateCard = askCardFor(call("mcp__asks__ask_update", "completed", update, updated.text))!;
    expect(store.get(WS, "A1")?.lastCall).toBe(updateCard.call);
    expect(updateCard.call).not.toBe(createCard.call);

    // A human answering doesn't move it: the agent's latest card stays the live one.
    await asks.act({ workspaceId: WS, id: "A1", verb: "done" });
    expect(store.get(WS, "A1")?.lastCall).toBe(updateCard.call);
  });
});
