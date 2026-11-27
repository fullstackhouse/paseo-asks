import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";

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
const HOLD_MS = 8_000;

describe("undo", () => {
  let dir: string;
  let store: AskStore;
  let courier: FakeCourier;
  let outbox: Outbox;
  let service: AsksService;
  let clock: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asks-undo-"));
    clock = Date.now();
    store = new AskStore(dir);
    courier = new FakeCourier();
    outbox = new Outbox(dir, courier, undefined, () => new Date(clock), HOLD_MS);
    service = new AsksService(store, outbox, async () => WS);
  });

  const decision = {
    kind: "decision",
    title: "Squash-only merges?",
    actions: [
      { label: "a: leave as is", kind: "resolve" },
      { label: "b: squash-only", kind: "resolve" },
    ],
  };

  it("holds the answer for the undo window, then delivers it", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a2" });
    await outbox.flush();
    expect(courier.sent).toEqual([]);
    clock += HOLD_MS;
    await outbox.flush();
    expect(courier.sent).toEqual(["[asks] A1 (Squash-only merges?) resolved: b: squash-only."]);
  });

  it("takes an answer back before the agent hears of it", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    const before = store.get(WS, "A1")!;
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a2", note: "now" });
    const { ask, notified } = await service.act({ workspaceId: WS, id: "A1", verb: "undo" });
    expect(notified).toBe(false);
    expect(ask).toEqual(before);
    expect(store.get(WS, "A1")).toEqual(before);
    clock += HOLD_MS;
    await outbox.flush();
    expect(courier.sent).toEqual([]);
    expect(outbox.pending()).toEqual([]);
  });

  it("puts an ask taken over back in progress with what it waited on", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Ship it" });
    await service.callTool(AGENT, "ask_update", { id: "A1", status: "in_progress", waitingOn: "CI on #12" });
    const before = store.get(WS, "A1")!;
    await service.act({ workspaceId: WS, id: "A1", verb: "reopen" });
    expect(store.get(WS, "A1")!.status).toBe("open");
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "undo" });
    expect(ask).toEqual(before);
  });

  it("undoes a drop, a reply and a reminder", async () => {
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
    clock += HOLD_MS;
    await outbox.flush();
    expect(courier.sent).toEqual([]);
  });

  it("refuses once the agent has the answer, and leaves the ask as answered", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    clock += HOLD_MS;
    await outbox.flush();
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "undo" })).rejects.toThrow(/Too late/);
    expect(store.get(WS, "A1")!.status).toBe("done");
    expect(courier.sent).toHaveLength(1);
  });

  it("refuses once the ask changed since", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Ship it" });
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "go" });
    await service.callTool(AGENT, "ask_update", { id: "A1", waitingOn: "CI" });
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "undo" })).rejects.toThrow(/nothing to undo/);
    expect(store.get(WS, "A1")!.status).toBe("in_progress");
  });

  it("undoes only the last act", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "first" });
    const replied = store.get(WS, "A1")!;
    await service.act({ workspaceId: WS, id: "A1", verb: "done" });
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "undo" });
    expect(ask.status).toBe("in_progress");
    expect(ask.outcome).toEqual(replied.outcome);
    await expect(service.act({ workspaceId: WS, id: "A1", verb: "undo" })).rejects.toThrow(/nothing to undo/);
    clock += HOLD_MS;
    await outbox.flush();
    expect(courier.sent).toEqual(['[asks] A1 (Squash-only merges?) reply from the human: "first". Update or resolve A1 accordingly.']);
  });
});
