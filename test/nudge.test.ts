import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { endsWithQuestion, NUDGE, REFRESH, shouldNudge } from "../server/nudge";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const reply = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = (name: string) => ({ type: "tool_call", name, callId: name, status: "completed", error: null }) as unknown as AgentTimelineItem;

describe("shouldNudge", () => {
  const yes = async () => true;

  it("nudges a turn that ends on a question with no ask", async () => {
    expect(await shouldNudge([user("try PR 11"), tool("Bash"), reply("Two ways forward.\n\nWhich one?")])).toBe(true);
  });

  it("does not nudge when the turn used an asks tool", async () => {
    expect(await shouldNudge([user("go"), tool("mcp__asks__ask_create"), reply("Which one?")], yes)).toBe(false);
  });

  it("does not nudge when the reply points to an existing ask", async () => {
    expect(await shouldNudge([user("go"), reply("Still waiting on you, see A3. Which one?")], yes)).toBe(false);
  });

  it("does not nudge a reply that only reports", async () => {
    expect(await shouldNudge([user("go"), reply("Is it fixed? Yes.\n\nTests pass.")])).toBe(false);
  });

  it("looks only at the latest turn", async () => {
    expect(await shouldNudge([user("a"), reply("Which one?"), user("b"), reply("Done.")])).toBe(false);
    expect(await shouldNudge([user("a"), tool("mcp__asks__ask_list"), reply("ok"), user("b"), reply("Which one?")])).toBe(true);
  });

  it("never nudges the answer to a nudge", async () => {
    expect(await shouldNudge([user(NUDGE), reply("Which one?")], yes)).toBe(false);
  });

  it("joins streamed reply chunks", async () => {
    expect(await shouldNudge([user("go"), reply("Which "), reply("one?")])).toBe(true);
    let seen = "";
    await shouldNudge([user("go"), reply("Which "), reply("one?")], async (text) => ((seen = text), true));
    expect(seen).toBe("Which one?");
  });

  it("lets the classifier catch requests without a question mark", async () => {
    const turn = [user("go"), reply("Decide on the migration, then re-review.")];
    expect(await shouldNudge(turn)).toBe(false);
    expect(await shouldNudge(turn, yes)).toBe(true);
    expect(await shouldNudge([user("go"), reply("Which one?")], async () => false)).toBe(false);
  });

  it("falls back to the question mark check when the classifier fails", async () => {
    const fail = async () => Promise.reject(new Error("no claude"));
    expect(await shouldNudge([user("go"), reply("Which one?")], fail)).toBe(true);
    expect(await shouldNudge([user("go"), reply("Done.")], fail)).toBe(false);
  });
});

describe("endsWithQuestion", () => {
  it("ignores question marks in code and links", () => {
    expect(endsWithQuestion("Run `a?.b` here.")).toBe(false);
    expect(endsWithQuestion("See https://x.dev/p?q=1")).toBe(false);
    expect(endsWithQuestion("```\nwhy?\n```")).toBe(false);
  });
});

describe("refresh", () => {
  const setup = (state: AgentState) => {
    const dir = mkdtempSync(join(tmpdir(), "asks-"));
    const sent: string[] = [];
    const courier: Courier = { state: async () => state, send: async (_agent, text) => void sent.push(text) };
    const outbox = new Outbox(dir, courier);
    return { sent, outbox, service: new AsksService(new AskStore(dir), outbox, async () => "wks_1") };
  };

  it("sends now to an idle agent", async () => {
    const { sent, service } = setup("idle");
    expect(await service.refresh("agent")).toEqual({ sent: true });
    expect(sent).toEqual([REFRESH]);
  });

  it("waits for a running agent and does not queue the same request twice", async () => {
    const { sent, outbox, service } = setup("running");
    expect(await service.refresh("agent")).toEqual({ sent: false });
    await service.refresh("agent");
    expect(sent).toEqual([]);
    expect(outbox.pending("agent")).toHaveLength(1);
  });
});
