import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { UNDO_ACCEPT_MS } from "../shared/asks";

class FakeCourier implements Courier {
  states = new Map<string, AgentState>();
  sent: string[] = [];
  async state(agentId: string) {
    return this.states.get(agentId) ?? "idle";
  }
  async send(_agentId: string, text: string) {
    this.sent.push(text);
  }
}

const WS = "wks_1";
const AGENT = "agent-1";

describe("undo", () => {
  let dir: string;
  let store: AskStore;
  let courier: FakeCourier;
  let outbox: Outbox;
  let service: AsksService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asks-undo-"));
    store = new AskStore(dir);
    courier = new FakeCourier();
    outbox = new Outbox(dir, courier);
    service = new AsksService(store, outbox, async () => WS);
  });
  afterEach(() => vi.useRealTimers());

  const decision = {
    kind: "decision",
    title: "Squash-only merges?",
    actions: [
      { label: "a: leave as is", kind: "resolve" },
      { label: "b: squash-only", kind: "resolve" },
    ],
  };

  it("drops an answer still waiting for the agent's turn to end, so it never hears of it", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    const before = store.get(WS, "A1")!;
    courier.states.set(AGENT, "running");
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a2", note: "now" });
    const { ask, notified } = await service.act({ workspaceId: WS, id: "A1", verb: "undo" });
    expect(notified).toBe(false);
    expect(ask).toEqual(before);
    expect(store.get(WS, "A1")).toEqual(before);
    courier.states.set(AGENT, "idle");
    await outbox.flush();
    expect(courier.sent).toEqual([]);
  });

  it("tells an agent that already has the answer to stop, and puts the ask back", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "Ship it",
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #30" }],
    });
    const before = store.get(WS, "A1")!;
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await outbox.flush();
    expect(courier.sent).toHaveLength(1);
    courier.states.set(AGENT, "steerable");
    const { ask, notified } = await service.act({ workspaceId: WS, id: "A1", verb: "undo" });
    await outbox.flush();
    expect(notified).toBe(true);
    expect(ask).toEqual(before);
    expect(courier.sent[1]).toBe(
      '[asks] A1 (Ship it): the human undid their last answer (they chose "Merge"); it waits on the human again. Stop anything you started for that answer and undo what you can.',
    );
  });

  it("puts an ask taken over back in progress with what it waited on", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Ship it" });
    await service.callTool(AGENT, "ask_update", { id: "A1", status: "in_progress", waitingOn: "CI on #12" });
    const before = store.get(WS, "A1")!;
    await service.act({ workspaceId: WS, id: "A1", verb: "reopen" });
    expect(store.get(WS, "A1")!.status).toBe("open");
    await outbox.flush();
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "undo" });
    await outbox.flush();
    expect(ask).toEqual(before);
    expect(courier.sent.at(-1)).toMatch(/they took it over\); it is in progress again/);
  });

  it("undoes a drop, a reply and a reminder", async () => {
    courier.states.set(AGENT, "running");
    await service.callTool(AGENT, "ask_create", decision);
    const open = store.get(WS, "A1")!;
    for (const verb of ["drop", "reply"] as const) {
      await service.act({ workspaceId: WS, id: "A1", verb, note: "hm" });
      expect((await service.act({ workspaceId: WS, id: "A1", verb: "undo" })).ask).toEqual(open);
    }
    await service.callTool(AGENT, "ask_update", { id: "A1", status: "in_progress" });
    const taken = store.get(WS, "A1")!;
    await service.act({ workspaceId: WS, id: "A1", verb: "remind" });
    expect((await service.act({ workspaceId: WS, id: "A1", verb: "undo" })).ask).toEqual(taken);
    courier.states.set(AGENT, "idle");
    await outbox.flush();
    expect(courier.sent).toEqual([]);
  });

  it("refuses after the toast's window", async () => {
    vi.useFakeTimers();
    await service.callTool(AGENT, "ask_create", decision);
    await service.act({ workspaceId: WS, id: "A1", verb: "drop" });
    vi.advanceTimersByTime(UNDO_ACCEPT_MS + 1);
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "undo" })).rejects.toThrow(/Too late/);
    expect(store.get(WS, "A1")!.status).toBe("dropped");
  });

  it("refuses once the ask changed since", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Ship it" });
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "go" });
    await service.callTool(AGENT, "ask_update", { id: "A1", waitingOn: "CI" });
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "undo" })).rejects.toThrow(/nothing to undo/);
    expect(store.get(WS, "A1")!.status).toBe("in_progress");
  });

  it("undoes only the last act", async () => {
    courier.states.set(AGENT, "running");
    await service.callTool(AGENT, "ask_create", decision);
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "first" });
    const replied = store.get(WS, "A1")!;
    await service.act({ workspaceId: WS, id: "A1", verb: "done" });
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "undo" });
    expect(ask.status).toBe("in_progress");
    expect(ask.outcome).toEqual(replied.outcome);
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "undo" })).rejects.toThrow(/nothing to undo/);
    courier.states.set(AGENT, "idle");
    await outbox.flush();
    expect(courier.sent).toEqual(['[asks] A1 (Squash-only merges?) reply from the human: "first". Update or resolve A1 accordingly.']);
  });
});
