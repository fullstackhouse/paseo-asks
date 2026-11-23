import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DROPPED_LATER, POSTPONED, QuestionBook, type PermissionResponder } from "../server/questions";
import { parseAsksMessage } from "../shared/messages";
import { answerMessage, pendingByWorkspace, questionTitle, readQuestions } from "../shared/questions";

type Response = Parameters<PermissionResponder["respond"]>[2];

class FakeResponder implements PermissionResponder {
  responses: { agentId: string; requestId: string; response: Response }[] = [];
  messages: { agentId: string; workspaceId: string; text: string }[] = [];
  fail = false;
  async respond(agentId: string, requestId: string, response: Response) {
    if (this.fail) throw new Error("already answered");
    this.responses.push({ agentId, requestId, response });
  }
  message(agentId: string, workspaceId: string, text: string) {
    this.messages.push({ agentId, workspaceId, text });
  }
}

const AGENT = { id: "agent-1", workspaceId: "wks_1", provider: "claude" };
const claudeQuestion = (id = "permission-1") => ({
  id,
  kind: "question",
  name: "AskUserQuestion",
  provider: "claude",
  input: {
    questions: [
      {
        header: "License",
        question: "Simply put: the repo has no license yet.\n\nWhich license should LICENSE.txt use?",
        options: [
          { label: "MIT (Recommended)", description: "Short and permissive." },
          { label: "Apache-2.0", description: "Adds a patent grant." },
        ],
        allowOther: true,
      },
    ],
  },
});
const codexAsyncQuestion = {
  id: "permission-async-1",
  kind: "question",
  name: "request_user_input_async",
  provider: "codex",
  input: { questions: [{ id: "0", header: "Question 1", question: "Which license?", options: [{ label: "MIT" }], isOther: true }] },
};

describe("readQuestions", () => {
  it("reads a question request's questions and skips other requests", () => {
    expect(readQuestions(claudeQuestion())).toEqual([
      {
        header: "License",
        question: "Simply put: the repo has no license yet.\n\nWhich license should LICENSE.txt use?",
        options: [
          { label: "MIT (Recommended)", description: "Short and permissive." },
          { label: "Apache-2.0", description: "Adds a patent grant." },
        ],
      },
    ]);
    expect(readQuestions({ kind: "tool", input: { command: "ls" } })).toBeNull();
    expect(readQuestions({ kind: "question", input: { questions: [] } })).toBeNull();
  });

  it("names a question without a header by its position", () => {
    expect(readQuestions({ kind: "question", input: { questions: [{ question: "Why?", options: [] }] } })?.[0]?.header).toBe("Question 1");
  });

  it("titles a question by the sentence that asks, not its context paragraph", () => {
    expect(questionTitle({ questions: readQuestions(claudeQuestion())! })).toBe("Which license should LICENSE.txt use?");
    const oneParagraph = "Simply put: MIT lets anyone reuse it. Which license should the LICENSE file use? Recommendation: MIT.";
    expect(questionTitle({ questions: [{ header: "License", question: oneParagraph, options: [] }] })).toBe(
      "Which license should the LICENSE file use?",
    );
    expect(questionTitle({ questions: [{ header: "License", question: "Pick a **license**.", options: [] }] })).toBe("Pick a license.");
  });
});

describe("QuestionBook", () => {
  let dir: string;
  let responder: FakeResponder;
  let book: QuestionBook;
  const now = () => new Date("2026-11-23T10:00:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asks-questions-"));
    responder = new FakeResponder();
    book = new QuestionBook(dir, responder, now);
  });

  it("lists a pending question and answers it through the tool, keyed by header", async () => {
    book.track(AGENT, claudeQuestion());
    expect(book.list("wks_1")).toMatchObject([{ agentId: "agent-1", requestId: "permission-1", state: "pending", blocking: true }]);
    expect(book.isWaiting("agent-1")).toBe(true);

    expect(await book.answer("agent-1", "permission-1", { License: " MIT " })).toEqual({ delivered: "tool" });
    expect(responder.responses).toEqual([
      { agentId: "agent-1", requestId: "permission-1", response: { behavior: "allow", updatedInput: { answers: { License: "MIT" } } } },
    ]);
    expect(book.list()).toEqual([]);
    expect(book.isWaiting("agent-1")).toBe(false);
  });

  it("refuses an answer that leaves a question empty", async () => {
    book.track(AGENT, claudeQuestion());
    await expect(book.answer("agent-1", "permission-1", { License: "  " })).rejects.toThrow('Answer "License"');
    expect(responder.responses).toEqual([]);
  });

  it("Answer later releases the agent with a placeholder answer and keeps the question on disk", async () => {
    book.track(AGENT, claudeQuestion());
    const postponed = await book.postpone("agent-1", "permission-1");
    expect(postponed).toMatchObject({ state: "postponed", postponedAt: "2026-11-23T10:00:00.000Z" });
    expect(responder.responses).toEqual([
      { agentId: "agent-1", requestId: "permission-1", response: { behavior: "allow", updatedInput: { answers: { License: POSTPONED } } } },
    ]);
    // The host reports the request resolved once the placeholder lands; the question stays.
    book.resolved("agent-1", "permission-1");
    expect(book.isWaiting("agent-1")).toBe(false);

    const reloaded = new QuestionBook(dir, responder, now);
    expect(reloaded.list()).toMatchObject([{ requestId: "permission-1", state: "postponed" }]);
    expect(JSON.parse(readFileSync(join(dir, "questions.json"), "utf8"))).toHaveLength(1);
  });

  it("sends the later answer as a message and forgets the question", async () => {
    book.track(AGENT, claudeQuestion());
    await book.postpone("agent-1", "permission-1");
    responder.responses = [];

    expect(await book.answer("agent-1", "permission-1", { License: "Apache-2.0" })).toEqual({ delivered: "message" });
    expect(responder.responses).toEqual([]);
    expect(responder.messages).toEqual([
      {
        agentId: "agent-1",
        workspaceId: "wks_1",
        text: answerMessage(readQuestions(claudeQuestion())!, { License: "Apache-2.0" }),
      },
    ]);
    expect(responder.messages[0]!.text).toContain("Which license should LICENSE.txt use?\nAnswer: Apache-2.0");
    // The chat shows what the human did, not the agent's instructions.
    expect(parseAsksMessage(responder.messages[0]!.text)).toMatchObject({ event: "Answered a question you put off" });
    expect(new QuestionBook(dir, responder, now).list()).toEqual([]);
  });

  it("keeps the question pending when releasing the agent fails", async () => {
    book.track(AGENT, claudeQuestion());
    responder.fail = true;
    await expect(book.postpone("agent-1", "permission-1")).rejects.toThrow("already answered");
    expect(book.list()).toMatchObject([{ state: "pending" }]);
    expect(new QuestionBook(dir, responder, now).list()).toMatchObject([{ state: "pending" }]);
  });

  it("postpones a Codex async question without answering it, and answers it through the tool later", async () => {
    book.track({ ...AGENT, provider: "codex" }, codexAsyncQuestion);
    expect(book.list()).toMatchObject([{ blocking: false }]);
    // The agent never stopped, so messages need not wait for it.
    expect(book.isWaiting("agent-1")).toBe(false);

    await book.postpone("agent-1", "permission-async-1");
    expect(responder.responses).toEqual([]);

    expect(await book.answer("agent-1", "permission-async-1", { "Question 1": "MIT" })).toEqual({ delivered: "tool" });
    expect(responder.responses).toEqual([
      { agentId: "agent-1", requestId: "permission-async-1", response: { behavior: "allow", updatedInput: { answers: { "Question 1": "MIT" } } } },
    ]);
    expect(responder.messages).toEqual([]);
  });

  it("drops a pending question when it is answered or dismissed in the chat", () => {
    book.track(AGENT, claudeQuestion("permission-a"));
    book.track(AGENT, claudeQuestion("permission-b"));
    book.resolved("agent-1", "permission-a", { behavior: "allow" });
    book.resolved("agent-1", "permission-b", { behavior: "deny", message: "The user answered with a message instead of approving. Their message follows." });
    expect(book.list()).toEqual([]);
  });

  it("keeps a question whose turn was canceled (Stop, daemon shutdown) as put off", () => {
    book.track(AGENT, claudeQuestion("permission-a"));
    book.track(AGENT, claudeQuestion("permission-b"));
    book.resolved("agent-1", "permission-a", { behavior: "deny", message: "Permission request canceled" });
    book.resolved("agent-1", "permission-b", { behavior: "deny", message: "Claude session closed" });
    expect(new QuestionBook(dir, responder, now).list()).toMatchObject([
      { requestId: "permission-a", state: "postponed" },
      { requestId: "permission-b", state: "postponed" },
    ]);
  });

  it("reconciles with the host: finds questions the hooks missed and drops ones the host no longer has", async () => {
    book.track(AGENT, claudeQuestion("permission-gone"));
    book.track(AGENT, claudeQuestion("permission-later"));
    await book.postpone("agent-1", "permission-later");
    book.track({ id: "agent-unlisted", workspaceId: "wks_2" }, claudeQuestion("permission-unlisted"));

    book.reconcile([
      { ...AGENT, status: "running", pendingPermissions: [claudeQuestion("permission-new"), { id: "permission-tool", kind: "tool" }] },
    ]);

    expect(book.list().map((question) => `${question.requestId}:${question.state}`).sort()).toEqual([
      "permission-later:postponed",
      "permission-new:pending",
      // Not in the listing (a page limit), so left alone.
      "permission-unlisted:pending",
    ]);
  });

  it("keeps a question whose turn died unanswered (a daemon restart) as put off, so the answer still reaches the agent", async () => {
    book.track(AGENT, claudeQuestion());
    // The plugin restarts with the daemon; the question comes back from disk.
    const restarted = new QuestionBook(dir, responder, now);
    restarted.reconcile([{ ...AGENT, status: "idle", pendingPermissions: [] }]);
    expect(restarted.list()).toMatchObject([{ requestId: "permission-1", state: "postponed" }]);

    expect(await restarted.answer("agent-1", "permission-1", { License: "MIT" })).toEqual({ delivered: "message" });
    expect(responder.responses).toEqual([]);
  });

  it("drops a postponed async question the host no longer has", async () => {
    book.track(AGENT, codexAsyncQuestion);
    await book.postpone("agent-1", "permission-async-1");
    book.reconcile([{ ...AGENT, pendingPermissions: [] }]);
    expect(book.list()).toEqual([]);
  });

  it("dismissing declines a pending question and tells the agent about a postponed one", async () => {
    book.track(AGENT, claudeQuestion("permission-a"));
    book.track(AGENT, claudeQuestion("permission-b"));
    await book.postpone("agent-1", "permission-b");
    responder.responses = [];

    expect(await book.drop("agent-1", "permission-a")).toEqual({ dropped: true });
    expect(responder.responses).toEqual([
      { agentId: "agent-1", requestId: "permission-a", response: { behavior: "deny", message: "The human dismissed this question." } },
    ]);
    expect(await book.drop("agent-1", "permission-b")).toEqual({ dropped: true });
    expect(responder.messages[0]!.text.startsWith(DROPPED_LATER)).toBe(true);
    expect(book.list()).toEqual([]);
    expect(await book.drop("agent-1", "permission-b")).toEqual({ dropped: false });
  });

  it("forgets an archived agent's questions", async () => {
    book.track(AGENT, claudeQuestion("permission-a"));
    book.track(AGENT, claudeQuestion("permission-b"));
    await book.postpone("agent-1", "permission-b");
    book.forgetAgent("agent-1");
    expect(book.list()).toEqual([]);
    expect(new QuestionBook(dir, responder, now).list()).toEqual([]);
  });

  it("ignores questions from agents without a workspace", () => {
    expect(book.track({ id: "agent-x", workspaceId: null }, claudeQuestion())).toBeNull();
    expect(book.list()).toEqual([]);
  });
});

describe("counts", () => {
  it("counts pending questions per workspace for the composer pill, leaving postponed ones out", async () => {
    const book = new QuestionBook(mkdtempSync(join(tmpdir(), "asks-questions-")), new FakeResponder());
    book.track(AGENT, claudeQuestion("permission-a"));
    book.track(AGENT, claudeQuestion("permission-b"));
    await book.postpone("agent-1", "permission-b");
    book.track({ id: "agent-2", workspaceId: "wks_2" }, claudeQuestion("permission-c"));

    expect(pendingByWorkspace(book.list())).toEqual(new Map([["wks_1", 1], ["wks_2", 1]]));
  });
});
