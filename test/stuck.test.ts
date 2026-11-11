import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Outbox, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { STALE_MS } from "../server/stuck";
import type { PrState } from "../shared/asks";

const WS = "wks_1";
const AGENT = "agent-1";
const PR_URL = "https://github.com/acme/app/pull/30";

const pr = (patch: Partial<PrState> = {}): PrState => ({
  number: 30,
  url: PR_URL,
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  checks: "passing",
  mergeable: "MERGEABLE",
  fetchedAt: new Date().toISOString(),
  ...patch,
});

describe("asks stuck in progress", () => {
  let store: AskStore;
  let outbox: Outbox;
  let service: AsksService;
  let sent: string[];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "asks-stuck-"));
    store = new AskStore(dir);
    sent = [];
    const courier: Courier = {
      state: async () => "idle",
      send: async (_agentId, text) => void sent.push(text),
    };
    outbox = new Outbox(dir, courier, async () => {});
    service = new AsksService(store, outbox, async (agentId) => (agentId === AGENT ? WS : null));
  });

  const prAsk = async () => {
    await service.callTool(AGENT, "ask_create", {
      kind: "pr",
      title: "Merge PR #30",
      subscribe: true,
      links: [{ label: "PR #30", url: PR_URL }],
      actions: [{ label: "Merge when green", kind: "send", prompt: "Merge PR #30 once checks pass" }],
    });
    // The human clicks: the ask becomes the agent's.
    const { ask } = await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: "a1" });
    return ask;
  };

  it("tells the agent to reopen the ask when the PR waits on the human, not to leave it in progress", async () => {
    await prAsk();
    await outbox.flush(AGENT);
    expect(sent[0]).toContain("If it waits on the human (a label, an approval, a merge only they can do), ask_update it");
    expect(sent[0]).not.toContain("If the PR still waits on the human after it");
  });

  it("reopens on new actions even when the agent passes status in_progress", async () => {
    await prAsk();
    const result = await service.callTool(AGENT, "ask_update", {
      id: "A1",
      status: "in_progress",
      actions: [{ label: "Authorize: add QA labels + merge", kind: "send", prompt: "Add the labels and merge" }],
    });
    expect(result.text).toMatch(/^A1 \[open\]/);
  });

  it("still lets the agent resolve or drop an ask while giving it actions", async () => {
    await prAsk();
    await service.callTool(AGENT, "ask_update", {
      id: "A1",
      status: "dropped",
      actions: [{ label: "x", kind: "send", prompt: "x" }],
    });
    expect(store.get(WS, "A1")?.status).toBe("dropped");
  });

  it("reminds the owner once when its turn ends holding an in-progress ask", async () => {
    await prAsk();
    await outbox.flush(AGENT);
    sent.length = 0;
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Your turn ended with A1 (Merge PR #30) in progress");
    // A quiet rerun: nothing changed since the reminder.
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(1);
    // The ask changes (another click), so it may be reminded again.
    await service.callTool(AGENT, "ask_update", { id: "A1", body: "rebased" });
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(2);
  });

  it("does not remind while a subscribed PR's checks are pending: the watcher wakes the owner", async () => {
    await prAsk();
    await store.update(WS, "A1", { pr: pr({ checks: "pending" }) }, { touch: false });
    await outbox.flush(AGENT);
    sent.length = 0;
    await service.remindStuck(AGENT, WS);
    await outbox.flush(AGENT);
    expect(sent).toHaveLength(0);
  });

  it("hands an archived owner's in-progress asks back to the human", async () => {
    await prAsk();
    await service.callTool(AGENT, "ask_create", { kind: "followup", title: "Untouched" });
    const released = await service.releaseOwner(AGENT);
    expect(released.map((ask) => ask.id)).toEqual(["A1"]);
    expect(store.get(WS, "A1")?.status).toBe("open");
  });

  it("reopens a stale in-progress ask whose owner is not running, and leaves the rest", async () => {
    await prAsk();
    const later = new Date(Date.parse(store.get(WS, "A1")!.updatedAt) + STALE_MS);
    const early = new Date(later.getTime() - 1000);
    expect(await service.reopenStale(async () => false, early)).toEqual([]);
    expect(await service.reopenStale(async () => true, later)).toEqual([]);
    const reopened = await service.reopenStale(async () => false, later);
    expect(reopened.map((ask) => ask.id)).toEqual(["A1"]);
    expect(store.get(WS, "A1")?.status).toBe("open");
  });
});
