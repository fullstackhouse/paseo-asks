import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Outbox, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";
import { parseAsksMessage } from "../shared/messages";
import { NUDGE, REFRESH } from "../shared/prompts";

const WS = "wks_1";
const OWNER = "agent-1";
const SIDE = "agent-side";
// Parentheses, quotes and a colon in the title: the patterns must not split on them.
const TITLE = 'Windows 11 (25H2) doesn\'t fit: use a "16 GB" pendrive?';

describe("parseAsksMessage", () => {
  let service: AsksService;
  let store: AskStore;
  let sent: string[];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "asks-messages-"));
    sent = [];
    const courier: Courier = {
      state: async () => "idle",
      send: async (_agentId, text) => void sent.push(text),
    };
    store = new AskStore(dir);
    const outbox = new Outbox(dir, courier, async () => undefined);
    service = new AsksService(store, outbox, async (agentId) => (agentId === OWNER || agentId === SIDE ? WS : null));
  });

  const create = async () => {
    await service.callTool(OWNER, "ask_create", {
      kind: "decision",
      title: TITLE,
      actions: [
        { label: "16 GB pendrive", kind: "resolve", recommended: true },
        { label: "Drop WinRE", kind: "resolve" },
        { label: "Merge v1.2", kind: "send", prompt: "Merge PR #30. Then tag it." },
      ],
    });
    return store.list(WS).find((ask) => ask.id === "A1")!;
  };
  const last = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return parseAsksMessage(sent.at(-1)!);
  };
  const note = 'will I be able to "restore" WinRE later?\nAsking for the laptop.';

  it("reads a reply", async () => {
    await create();
    await service.act({ workspaceId: WS, id: "A1", verb: "reply", note });
    expect(await last()).toEqual({ askId: "A1", title: TITLE, event: "replied", note });
  });

  it("reads a chosen option, with and without a note", async () => {
    const ask = await create();
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: ask.actions[0].id });
    expect(await last()).toEqual({ askId: "A1", title: TITLE, event: "chose “16 GB pendrive”", note: undefined });
  });

  it("reads a send action with a note", async () => {
    const ask = await create();
    await service.act({ workspaceId: WS, id: "A1", verb: "action", actionId: ask.actions[2].id, note: "squash it" });
    expect(await last()).toEqual({ askId: "A1", title: TITLE, event: "chose “Merge v1.2”", note: "squash it" });
  });

  it("reads done and dropped", async () => {
    await create();
    await service.act({ workspaceId: WS, id: "A1", verb: "done", note: "did it myself" });
    expect(await last()).toEqual({ askId: "A1", title: TITLE, event: "marked done", note: "did it myself" });
    await service.act({ workspaceId: WS, id: "A1", verb: "drop" });
    expect(await last()).toEqual({ askId: "A1", title: TITLE, event: "dropped", note: undefined });
  });

  it("reads side chat outcomes", async () => {
    const ask = await create();
    await service.callTool(SIDE, "ask_update", { id: "A1", status: "in_progress" });
    expect(await last()).toEqual({ askId: "A1", title: TITLE, event: "marked in progress in a side chat" });
    await service.callTool(SIDE, "ask_resolve", { id: "A1", actionId: ask.actions[1].id, note: "WinRE can be rebuilt." });
    expect(await last()).toEqual({
      askId: "A1",
      title: TITLE,
      event: "resolved in a side chat: “Drop WinRE”",
      note: "WinRE can be rebuilt.",
    });
  });

  it("reads PR updates", () => {
    expect(parseAsksMessage(`[asks] A2 (Merge PR #30) PR #30 checks passing, review: approved.`)).toEqual({
      askId: "A2",
      title: "Merge PR #30",
      event: "PR #30 checks passing, review: approved",
    });
  });

  it("reads the nudge and refresh prompts", () => {
    expect(parseAsksMessage(NUDGE)?.event).toMatch(/^Reminded/);
    expect(parseAsksMessage(REFRESH)?.event).toMatch(/^Asked/);
  });

  it("leaves other text alone", () => {
    expect(parseAsksMessage("fix the tests")).toBeUndefined();
    expect(parseAsksMessage("[asks] A1 something new the parser does not know")).toBeUndefined();
  });
});
