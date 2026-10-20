import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { endsWithQuestion, NUDGE, parseAnswer, REFRESH, shouldNudge } from "../server/nudge";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { pickCaller } from "../server/agents";
import { isAsksPermission } from "../server/permissions";
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
    const fail = async () => Promise.reject(new Error("provider down"));
    expect(await shouldNudge([user("go"), reply("Which one?")], fail)).toBe(true);
    expect(await shouldNudge([user("go"), reply("Done.")], fail)).toBe(false);
  });
});

describe("parseAnswer", () => {
  it("reads the answer from bare, fenced or chatty output", () => {
    expect(parseAnswer('{"waitsOnHuman": true}')).toBe(true);
    expect(parseAnswer('```json\n{"waitsOnHuman":false}\n```\n\nThe reply only reports.')).toBe(false);
    expect(parseAnswer("**waitsOnHuman: true**\n\nThe reply asks the human to choose.")).toBe(true);
    expect(parseAnswer("I think yes.")).toBe(null);
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

describe("isAsksPermission", () => {
  it("recognises Claude and Codex prompts for the asks tools only", () => {
    expect(isAsksPermission({ kind: "tool", name: "mcp__asks__ask_create" })).toBe(true);
    expect(isAsksPermission({ kind: "tool", name: "CodexMcpElicitation", metadata: { serverName: "asks" } })).toBe(true);
    expect(isAsksPermission({ kind: "tool", name: "CodexMcpElicitation", metadata: { serverName: "github" } })).toBe(false);
    expect(isAsksPermission({ kind: "tool", name: "Bash" })).toBe(false);
  });
});

describe("pickCaller", () => {
  const agent = (id: string, cwd: string, status = "idle", archivedAt: string | null = null) => ({ id, cwd, status, archivedAt });
  const home = homedir();

  it("picks the agent mid-turn in the bridge's directory", () => {
    const agents = [agent("a", `${home}/w/one`), agent("b", "~/w/one", "running"), agent("c", `${home}/w/two`, "running")];
    expect(pickCaller(agents, `${home}/w/one`)).toBe("b");
  });

  it("falls back to the only live agent there, and gives up when it cannot tell", () => {
    expect(pickCaller([agent("a", "/w"), agent("b", "/w", "running", "2026-01-01")], "/w")).toBe("a");
    expect(pickCaller([agent("a", "/w"), agent("b", "/w")], "/w")).toBe(null);
    expect(pickCaller([agent("a", "/w", "running"), agent("b", "/w", "running")], "/w")).toBe(null);
  });
});
