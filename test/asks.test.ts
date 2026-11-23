import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isWorking, Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService, BACKGROUND_SKIP } from "../server/service";
import { AskStore } from "../server/store";
import { AskSchema } from "../shared/asks";

class FakeCourier implements Courier {
  states = new Map<string, AgentState>();
  sent: { agentId: string; text: string; messageId: string }[] = [];
  failNext = false;
  failAlways = false;
  async state(agentId: string) {
    return this.states.get(agentId) ?? "idle";
  }
  async send(agentId: string, text: string, messageId: string) {
    if (this.failNext || this.failAlways) {
      this.failNext = false;
      throw new Error("daemon said no");
    }
    this.sent.push({ agentId, text, messageId });
  }
}

const WS = "wks_1";
const AGENT = "agent-1";

describe("asks", () => {
  let dir: string;
  let store: AskStore;
  let courier: FakeCourier;
  let outbox: Outbox;
  let service: AsksService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asks-"));
    store = new AskStore(dir);
    courier = new FakeCourier();
    outbox = new Outbox(dir, courier, async (deliveries, reason) => {
      for (const delivery of deliveries)
        if (delivery.askId)
          await store.update(
            delivery.workspaceId,
            delivery.askId,
            reason === "gone" ? { orphaned: true } : { status: "open" },
          );
    });
    service = new AsksService(store, outbox, async (agentId) => (agentId === AGENT ? WS : null));
  });

  const decision = {
    kind: "decision",
    title: "Squash-only merges?",
    actions: [
      { label: "a: leave as is", kind: "resolve" },
      { label: "b: squash-only", kind: "resolve", recommended: true },
    ],
  };

  it("numbers asks per workspace and persists them", async () => {
    const first = await service.callTool(AGENT, "ask_create", decision);
    const second = await service.callTool(AGENT, "ask_create", {
      kind: "followup",
      title: "File issue for retention switch",
    });
    expect(first.text).toMatch(/^A1 \[open\] decision/);
    expect(second.text).toMatch(/^A2 /);
    expect(new AskStore(dir).list(WS).map((ask) => ask.id)).toEqual(["A1", "A2"]);
  });

  it("rejects a bundled ask on create and update, saving nothing", async () => {
    const bundled = await service.callTool(AGENT, "ask_create", {
      kind: "review",
      title: "Answer the 6 open questions",
      actions: [{ label: "Approve as proposed", kind: "send", prompt: "Approve as proposed" }],
    });
    expect(bundled.isError).toBe(true);
    expect(bundled.text).toMatch(/one ask per question/);
    expect(store.list(WS)).toEqual([]);

    await service.callTool(AGENT, "ask_create", decision);
    const relabelled = await service.callTool(AGENT, "ask_update", {
      id: "A1",
      actions: [{ label: "Accept all recommendations", kind: "resolve" }],
    });
    expect(relabelled.isError).toBe(true);
    expect(store.get(WS, "A1")?.actions.map((action) => action.label)).toEqual(["a: leave as is", "b: squash-only"]);
  });

  it("preserves Markdown source through creation, persistence and the response schema", async () => {
    const body =
      "# Plan\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n[Guide][guide]\n\n[guide]: https://example.com";
    await service.callTool(AGENT, "ask_create", { ...decision, body });
    const [ask] = new AskStore(dir).list(WS);
    expect(AskSchema.parse(ask).body).toBe(body);
  });

  it("records nothing for an agent in a background workspace, and tells it so", async () => {
    let background = true;
    const scoped = new AsksService(store, outbox, async () => WS, async () => background);
    expect(await scoped.callTool(AGENT, "ask_create", decision)).toEqual({ text: BACKGROUND_SKIP });
    expect(store.list(WS)).toEqual([]);
    // The human opened the run's chat, so it isn't background any more.
    background = false;
    expect((await scoped.callTool(AGENT, "ask_create", decision)).text).toMatch(/^A1 /);
  });

  it("rejects a decision without two options, and a call with no agent id", async () => {
    const bad = await service.callTool(AGENT, "ask_create", { kind: "decision", title: "x" });
    expect(bad.isError).toBe(true);
    expect((await service.callTool(null, "ask_create", decision)).isError).toBe(true);
  });

  it("delivers a human's choice to the owning agent once, and only after its turn ends", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    courier.states.set(AGENT, "running");
    const { ask, notified } = await service.act({
      workspaceId: WS,
      id: "A1",
      verb: "action",
      actionId: "a2",
      note: "and update AGENTS.md",
    });
    await outbox.flush();
    expect(ask.status).toBe("done");
    expect(ask.outcome).toMatchObject({ label: "b: squash-only", by: "human" });
    expect(notified).toBe(true);
    expect(courier.sent).toEqual([]);

    courier.states.set(AGENT, "idle");
    await outbox.flush(AGENT);
    await outbox.flush(AGENT);
    expect(courier.sent).toHaveLength(1);
    expect(courier.sent[0]!.text).toBe(
      '[asks] A1 (Squash-only merges?) resolved: b: squash-only. Note from the human: "and update AGENTS.md"',
    );
  });

  it("records the send action the human chose, so the in-progress card can show it", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "Ship the export fix",
      actions: [{ label: "Merge (squash)", kind: "send", prompt: "Merge PR #30 with squash" }],
    });
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1", note: "after lunch" });
    expect(ask.status).toBe("in_progress");
    expect(ask.outcome).toMatchObject({ actionId: "a1", label: "Merge (squash)", note: "after lunch", by: "human" });
  });

  it("steers a human's choice into a running turn when the provider can take it", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    courier.states.set(AGENT, "steerable");
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await outbox.flush();
    expect(courier.sent).toHaveLength(1);
    expect(outbox.pending(AGENT)).toEqual([]);
  });

  it("keeps an in-progress ask open while its agent works a steerable turn", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Retention switch" });
    await service.callTool(AGENT, "ask_update", { id: "A1", status: "in_progress" });
    courier.states.set(AGENT, "steerable");
    const later = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const reopened = await service.reopenStale(async (id) => isWorking(await courier.state(id)), later);
    expect(reopened.map((ask) => ask.id)).toEqual([]);
  });

  it("batches several answers into one message", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Retention switch" });
    courier.states.set(AGENT, "running");
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await service.act({ workspaceId: WS, id: "A2", verb: "drop" });
    courier.states.set(AGENT, "idle");
    await outbox.flush();
    expect(courier.sent).toHaveLength(1);
    expect(courier.sent[0]!.text.split("\n")).toHaveLength(2);
  });

  it("a send action puts the ask in progress until the agent resolves it", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "PR #30 ready",
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #30 with squash" }],
    });
    const { ask } = await service.act({
      workspaceId: WS,
      id: "A1",
      verb: "action",
      actionId: "a1",
    });
    await outbox.flush();
    expect(ask.status).toBe("in_progress");
    expect(courier.sent[0]!.text).toContain("Merge PR #30 with squash");
    expect(courier.sent[0]!.text).toContain("call ask_resolve for A1");

    await service.callTool(AGENT, "ask_resolve", { id: "A1", note: "merged" });
    expect(store.get(WS, "A1")).toMatchObject({
      status: "done",
      outcome: { by: "agent", note: "merged" },
    });
    expect(courier.sent).toHaveLength(1);
  });

  it("tells the agent to keep a watched PR ask open while the PR still waits on the human", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "Request review on PR #30",
      links: [{ label: "PR #30", url: "https://github.com/example/shop/pull/30" }],
      subscribe: true,
      actions: [
        {
          label: "Request review from alice",
          kind: "send",
          prompt: "Request review on PR #30 from alice",
        },
      ],
    });
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "PR #31 ready",
      links: [{ label: "PR #31", url: "https://github.com/example/shop/pull/31" }],
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #31 with squash" }],
    });
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await service.act({ workspaceId: WS, id: "A2", verb: "action", actionId: "a1" });
    await outbox.flush();

    const [watched, unwatched] = courier.sent.map((message) => message.text);
    expect(watched).toContain("keep the ask in progress instead of resolving it");
    expect(unwatched).not.toContain("keep the ask in progress");
  });

  it("new options on an in-progress ask hand it back to the human", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "PR #30 ready",
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #30 with squash" }],
    });
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    await service.callTool(AGENT, "ask_update", { id: "A1", body: "Working on it" });
    expect(store.get(WS, "A1")!.status).toBe("in_progress");

    await service.callTool(AGENT, "ask_update", {
      id: "A1",
      actions: [{ label: "I merged it", kind: "resolve" }],
    });
    expect(store.get(WS, "A1")!.status).toBe("open");

    await service.callTool(AGENT, "ask_update", {
      id: "A1",
      actions: [{ label: "Retry", kind: "send" }],
      status: "in_progress",
    });
    // Buttons on an in-progress ask can't be clicked, so an explicit in_progress doesn't hide them.
    expect(store.get(WS, "A1")!.status).toBe("open");
  });

  it("new options don't reopen an ask whose click the agent hasn't received yet", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "followup",
      title: "Hide nav entries",
      actions: [{ label: "Do it", kind: "send", prompt: "After #877 merges, open the PR" }],
    });
    courier.states.set(AGENT, "running");
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    // Mid-turn, unaware of the click, the agent rewords the action.
    await service.callTool(AGENT, "ask_update", {
      id: "A1",
      actions: [{ label: "Do it", kind: "send", prompt: "Open the PR" }],
    });
    expect(store.get(WS, "A1")!.status).toBe("in_progress");
    expect(store.get(WS, "A1")!.actions[0]!.prompt).toBe("Open the PR");

    courier.states.set(AGENT, "idle");
    await outbox.flush();
    expect(courier.sent).toHaveLength(1);
  });

  it("survives a restart with messages still pending", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    courier.states.set(AGENT, "running");
    await service.act({ workspaceId: WS, id: "A1", verb: "done" });
    const revived = new Outbox(dir, courier);
    courier.states.set(AGENT, "idle");
    await revived.flush();
    expect(courier.sent).toHaveLength(1);
  });

  it("retries a failed send", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    courier.failNext = true;
    await service.act({ workspaceId: WS, id: "A1", verb: "done" }); // its own flush fails
    await outbox.flush();
    expect(courier.sent).toHaveLength(1);
    expect(outbox.pending()).toHaveLength(0);
  });

  it("hands a click back to the human when it can't be delivered", async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "Merge PR #30?",
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #30 with squash" }],
    });
    courier.failAlways = true;
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    expect(store.get(WS, "A1")?.status).toBe("in_progress");
    for (let attempt = 0; attempt < 5; attempt++) await outbox.flush();
    expect(outbox.pending()).toHaveLength(0);
    // Back to open, so the human sees the buttons again instead of an ask nobody works on.
    expect(store.get(WS, "A1")?.status).toBe("open");
    expect(store.get(WS, "A1")?.orphaned).toBeFalsy();
  });

  it("closes a decision or question on a reply, since the reply is the answer", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which region?" });
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "squash, but keep merge commits on release/*" });
    expect(ask).toMatchObject({ status: "done", outcome: { note: "squash, but keep merge commits on release/*", by: "human" } });
    await service.act({ workspaceId: WS, id: "A2", verb: "reply", note: "eu-central" });
    expect(store.get(WS, "A2")).toMatchObject({ status: "done", outcome: { note: "eu-central", by: "human" } });
    await outbox.flush();
    expect(courier.sent.map((message) => message.text)).toEqual([
      '[asks] A1 (Squash-only merges?) answered by the human: "squash, but keep merge commits on release/*". A1 is done; act on the answer without resolving it.',
      '[asks] A2 (Which region?) answered by the human: "eu-central". A2 is done; act on the answer without resolving it.',
    ]);
  });

  it("leaves a follow-up or PR ask open on a reply, for the agent to settle", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Add retries next?" });
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "Merge PR #30?",
      actions: [{ label: "Merge", kind: "send", prompt: "Merge PR #30 with squash" }],
    });
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "only for the webhook client" });
    await service.act({ workspaceId: WS, id: "A2", verb: "reply", note: "wait for Ola's review" });
    expect(store.get(WS, "A1")?.status).toBe("open");
    expect(store.get(WS, "A2")?.status).toBe("open");
    await outbox.flush();
    expect(courier.sent.map((message) => message.text)).toEqual([
      '[asks] A1 (Add retries next?) reply from the human: "only for the webhook client". Update or resolve A1 accordingly.',
      "[asks] A2 (Merge PR #30?) reply from the human: \"wait for Ola's review\". Update or resolve A2 accordingly.",
    ]);
  });

  it("orphans an open ask whose agent is gone, and stops notifying", async () => {
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Which region?" });
    courier.states.set(AGENT, "gone");
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note: "eu-central" });
    await outbox.flush();
    expect(store.get(WS, "A1")?.orphaned).toBe(true);
    expect((await service.act({ workspaceId: WS, id: "A1", verb: "done" })).notified).toBe(false);
  });

  it("lists active asks (open and in progress) by default, labelled by status", async () => {
    await service.callTool(AGENT, "ask_create", decision);
    await service.callTool(AGENT, "ask_create", { kind: "question", title: "Other" });
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Later" });
    await service.callTool(AGENT, "ask_update", { id: "A2", status: "dropped" });
    await service.callTool(AGENT, "ask_update", { id: "A3", status: "in_progress" });
    const active = ["A1 [open] decision: Squash-only merges?", "A3 [in_progress] followup: Later"];
    expect((await service.callTool(AGENT, "ask_list", {})).text.split("\n")).toEqual(active);
    expect((await service.callTool(AGENT, "ask_list", { status: "active" })).text.split("\n")).toEqual(active);
    expect(
      (await service.callTool(AGENT, "ask_list", { status: "all" })).text.split("\n"),
    ).toHaveLength(3);
  });
});
