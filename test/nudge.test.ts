import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { classifierPrompt, endsWithQuestion, NUDGE, parseAnswer, REFRESH, shouldNudge, waitsOnOwnWork } from "../server/nudge";
import { clip, HumanMessages, humanText } from "../server/human-messages";
import { stuckReminder } from "../shared/prompts";
import { Outbox, type AgentState, type Courier } from "../server/outbox";
import { AsksService } from "../server/service";
import { pickCaller } from "../server/agents";
import { isAsksPermission } from "../server/permissions";
import { AskStore } from "../server/store";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const reply = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const tool = (name: string) =>
  ({
    type: "tool_call",
    name,
    callId: name,
    status: "completed",
    error: null,
  }) as unknown as AgentTimelineItem;

/** A completed asks call as the timeline carries it: the call's input and the tool's summary line. */
const askCall = (verb: "create" | "update" | "resolve", input: object, output: string) =>
  ({
    type: "tool_call",
    name: `mcp__asks__ask_${verb}`,
    callId: `${verb}-${JSON.stringify(input)}`,
    status: "completed",
    error: null,
    detail: { type: "mcp", input, output },
  }) as unknown as AgentTimelineItem;

describe("shouldNudge", () => {
  const yes = async () => true;
  const none = () => false;
  const openA3 = (id: string) => id === "A3";

  it("nudges a turn that ends on a question with no ask", async () => {
    expect(
      await shouldNudge([
        user("try PR 11"),
        tool("Bash"),
        reply("Two ways forward.\n\nWhich one?"),
      ], none),
    ).toBe(true);
  });

  it("does not nudge when an ask the turn created is still open", async () => {
    const created = askCall("create", { kind: "decision", title: "Which one?" }, "A3 [open] decision: Which one?");
    expect(await shouldNudge([user("go"), created, reply("Which one?")], openA3, yes)).toBe(false);
  });

  it("does not nudge when an ask the turn updated is still open", async () => {
    const updated = askCall("update", { id: "A3", status: "open" }, "A3 [open] pr: Merge PR #12");
    expect(await shouldNudge([user("go"), updated, reply("Ready to merge.")], openA3, yes)).toBe(false);
  });

  it("nudges when the turn only resolved an ask but the reply still waits on the human", async () => {
    const resolved = askCall("resolve", { id: "A7" }, "A7 [done] followup: Deprecate the rest");
    const turn = [user("go"), resolved, reply("Resolved A7. Still waiting on you: merge #1543.")];
    expect(await shouldNudge(turn, openA3, yes)).toBe(true);
  });

  it("nudges when the ask the turn updated is closed", async () => {
    const updated = askCall("update", { id: "A3", status: "done" }, "A3 [done] pr: Merge PR #12");
    expect(await shouldNudge([user("go"), updated, reply("Next, pick A205 or A207.")], none, yes)).toBe(true);
  });

  it("nudges when the turn only listed asks", async () => {
    expect(await shouldNudge([user("go"), tool("mcp__asks__ask_list"), reply("Which one?")], none, yes)).toBe(true);
  });

  it("does not nudge when the reply points to an existing ask", async () => {
    expect(
      await shouldNudge([user("go"), reply("Still waiting on you, see A3. Which one?")], openA3, yes),
    ).toBe(false);
  });

  it("nudges when the reply names only asks from elsewhere", async () => {
    expect(
      await shouldNudge(
        [user("go"), reply("If A30 is truly unused, A29 is worth questioning too. Reply send it?")],
        openA3,
        yes,
      ),
    ).toBe(true);
  });

  it("does not nudge a reply that only reports", async () => {
    expect(await shouldNudge([user("go"), reply("Is it fixed? Yes.\n\nTests pass.")], none)).toBe(false);
  });

  it("looks only at the latest turn", async () => {
    expect(await shouldNudge([user("a"), reply("Which one?"), user("b"), reply("Done.")], none)).toBe(
      false,
    );
    expect(
      await shouldNudge([
        user("a"),
        tool("mcp__asks__ask_list"),
        reply("ok"),
        user("b"),
        reply("Which one?"),
      ], none),
    ).toBe(true);
  });

  it("never nudges the answer to a nudge", async () => {
    expect(await shouldNudge([user(NUDGE), reply("Which one?")], none, yes)).toBe(false);
  });

  it("joins streamed reply chunks", async () => {
    expect(await shouldNudge([user("go"), reply("Which "), reply("one?")], none)).toBe(true);
    let seen = "";
    await shouldNudge([user("go"), reply("Which "), reply("one?")], none,
      async (text) => ((seen = text), true),
    );
    expect(seen).toBe("Which one?");
  });

  it("hands the classifier the human's latest messages", async () => {
    let seen: [string, readonly string[]] | undefined;
    const human = ["no PR until I've tested it", "push the branch"];
    await shouldNudge(
      [user("push the branch"), tool("Bash"), reply("Pushed. The PR opens once you've tested it.")],
      none,
      async (text, said) => ((seen = [text, said]), false),
      human,
    );
    expect(seen).toEqual(["Pushed. The PR opens once you've tested it.", human]);
  });

  it("lets the classifier catch requests without a question mark", async () => {
    const turn = [user("go"), reply("Decide on the migration, then re-review.")];
    expect(await shouldNudge(turn, none)).toBe(false);
    expect(await shouldNudge(turn, none, yes)).toBe(true);
    expect(await shouldNudge([user("go"), reply("Which one?")], none, async () => false)).toBe(false);
  });

  it("falls back to the question mark check when the classifier fails", async () => {
    const fail = async () => Promise.reject(new Error("provider down"));
    expect(await shouldNudge([user("go"), reply("Which one?")], none, fail)).toBe(true);
    expect(await shouldNudge([user("go"), reply("Done.")], none, fail)).toBe(false);
  });
});

describe("waitsOnOwnWork", () => {
  const list = <T,>(items: T[]) => ({ list: async () => items });

  it("waits while a subagent the agent started is still running", async () => {
    expect(await waitsOnOwnWork({ providerSubagents: list([{ status: "running" }]), backgroundWork: list([]) })).toBe(true);
  });

  it("waits while a monitor the agent started is still watching", async () => {
    expect(await waitsOnOwnWork({ providerSubagents: list([]), backgroundWork: list([{ kind: "monitor" }]) })).toBe(true);
  });

  it("does not wait on finished subagents or a background shell, which may never exit", async () => {
    expect(
      await waitsOnOwnWork({
        providerSubagents: list([{ status: "completed" }, { status: "failed" }]),
        backgroundWork: list([{ kind: "shell" }]),
      }),
    ).toBe(false);
  });

  it("does not wait on hosts without these handles or when a read fails", async () => {
    expect(await waitsOnOwnWork({})).toBe(false);
    const broken = { list: async () => Promise.reject(new Error("unsupported")) };
    expect(await waitsOnOwnWork({ providerSubagents: broken, backgroundWork: broken })).toBe(false);
  });
});

describe("HumanMessages", () => {
  it("keeps each agent's latest three human messages across turns, on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "asks-"));
    const messages = new HumanMessages(dir);
    messages.record("a", [user("no PR until I've tested it"), reply("Understood.")]);
    messages.record("b", [user("other agent")]);
    messages.record("a", [user("fix the flaky test"), reply("Fixed."), user("and push it"), reply("Pushed.")]);
    expect(messages.record("a", [user(NUDGE), reply("no ask")])).toEqual(["no PR until I've tested it", "fix the flaky test", "and push it"]);
    expect(messages.record("a", [user("rebase it")])).toEqual(["fix the flaky test", "and push it", "rebase it"]);
    expect(new HumanMessages(dir).get("a")).toEqual(["fix the flaky test", "and push it", "rebase it"]);
    expect(new HumanMessages(dir).get("b")).toEqual(["other agent"]);
  });

  it("keeps what the human did with an ask, and drops the plugin's reminders, PR updates and other agents", () => {
    expect(humanText('[asks] A2 (Open the PR?) reply from the human: "not until I test it". Update or resolve A2 accordingly.')).toEqual([
      "A2 (Open the PR?): replied: not until I test it",
    ]);
    expect(humanText("[asks] A1 (Keep carts in Redis or Postgres?) resolved: Postgres.")).toEqual([
      "A1 (Keep carts in Redis or Postgres?): chose “Postgres”",
    ]);
    expect(humanText("[asks] A3 (Merge PR #30) PR #30 checks passing.")).toEqual([]);
    expect(humanText(NUDGE)).toEqual([]);
    expect(humanText(REFRESH)).toEqual([]);
    expect(humanText(stuckReminder([{ id: "A3", title: "Merge PR #30" }]))).toEqual([]);
    expect(humanText('<paseo-system version="1" kind="agent-message">\nhello\n</paseo-system>')).toEqual([]);
  });

  it("keeps the head and the tail of a long message, where the instruction usually sits", () => {
    const pasted = `${"log line\n".repeat(1_000)}So: don't open the PR yet.`;
    const kept = clip(pasted);
    expect(kept.length).toBeLessThan(4_100);
    expect(kept.startsWith("log line")).toBe(true);
    expect(kept.endsWith("So: don't open the PR yet.")).toBe(true);
    expect(clip("short")).toBe("short");
  });

  it("puts each message in its own human tags before the reply", () => {
    const prompt = classifierPrompt("Done.", ["one", "two"]);
    expect(prompt).toContain("<human>\none\n</human>\n\n<human>\ntwo\n</human>\n\n<reply>\nDone.\n</reply>");
    expect(prompt).toContain('</reply>\n\nAnswer only with {"waitsOnHuman": true or false, "alreadySettled": true or false}.');
  });
});

describe("parseAnswer", () => {
  it("reads the answer from bare, fenced or chatty output", () => {
    expect(parseAnswer('{"waitsOnHuman": true}')).toBe(true);
    expect(parseAnswer('```json\n{"waitsOnHuman":false}\n```\n\nThe reply only reports.')).toBe(
      false,
    );
    expect(parseAnswer("**waitsOnHuman: true**\n\nThe reply asks the human to choose.")).toBe(true);
    // Haiku on Claude ignores outputSchema and answers in prose (seen live).
    expect(parseAnswer("Set `waitsOnHuman` to **true**. The reply ends with a question to the human.")).toBe(true);
    expect(parseAnswer("waitsOnHuman should be false: it only reports.")).toBe(false);
    expect(parseAnswer("waitsOnHuman is unclear; true and false both fit.")).toBe(null);
    expect(parseAnswer("I think yes.")).toBe(null);
  });

  it("does not nudge what the human already settled", () => {
    expect(parseAnswer('{"waitsOnHuman": true, "alreadySettled": true}')).toBe(false);
    expect(parseAnswer('{"waitsOnHuman": true, "alreadySettled": false}')).toBe(true);
    expect(parseAnswer('{"waitsOnHuman": false, "alreadySettled": false}')).toBe(false);
    expect(parseAnswer("waitsOnHuman is true and alreadySettled is **true**.")).toBe(false);
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
    const courier: Courier = {
      state: async () => state,
      send: async (_agent, text) => void sent.push(text),
    };
    const outbox = new Outbox(dir, courier);
    return {
      sent,
      outbox,
      service: new AsksService(new AskStore(dir), outbox, async () => "wks_1"),
    };
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
    expect(
      isAsksPermission({
        kind: "tool",
        name: "CodexMcpElicitation",
        metadata: { serverName: "asks" },
      }),
    ).toBe(true);
    expect(
      isAsksPermission({
        kind: "tool",
        name: "CodexMcpElicitation",
        metadata: { serverName: "github" },
      }),
    ).toBe(false);
    expect(isAsksPermission({ kind: "tool", name: "Bash" })).toBe(false);
  });
});

describe("pickCaller", () => {
  const agent = (id: string, cwd: string, status = "idle", archivedAt: string | null = null) => ({
    id,
    cwd,
    status,
    archivedAt,
  });
  const home = homedir();

  it("picks the agent mid-turn in the bridge's directory", () => {
    const agents = [
      agent("a", `${home}/w/one`),
      agent("b", "~/w/one", "running"),
      agent("c", `${home}/w/two`, "running"),
    ];
    expect(pickCaller(agents, `${home}/w/one`)).toBe("b");
  });

  it("ignores agents whose bridge sends its own ID, so a Claude agent beside a Codex one is not ambiguous", () => {
    const claude = { ...agent("a", "/w", "running"), provider: "claude" };
    const codex = { ...agent("b", "/w", "running"), provider: "codex" };
    expect(pickCaller([claude, codex], "/w")).toBe("b");
    expect(pickCaller([claude], "/w")).toBe(null);
  });

  it("falls back to the only live agent there, and gives up when it cannot tell", () => {
    expect(pickCaller([agent("a", "/w"), agent("b", "/w", "running", "2026-01-01")], "/w")).toBe(
      "a",
    );
    expect(pickCaller([agent("a", "/w"), agent("b", "/w")], "/w")).toBe(null);
    expect(pickCaller([agent("a", "/w", "running"), agent("b", "/w", "running")], "/w")).toBe(null);
  });
});
