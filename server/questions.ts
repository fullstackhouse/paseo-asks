import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  answerMessage,
  DROPPED_LATER,
  checkAnswers,
  PendingQuestionSchema,
  questionKey,
  readQuestions,
  type Answers,
  type PendingQuestion,
} from "../shared/questions";

/** What the agent's question tool returns when the human picks Answer later. Read by the model, so keep it plain. */
export { DROPPED_LATER };

export const POSTPONED =
  "Postponed: the human will answer this later in Paseo. Do not ask it again and do not wait for it. Continue with any work that does not depend on the answer; leave what depends on it undone and say so in your final reply. The answer will arrive later as a message starting with [asks].";


/**
 * What the host reports when a pending question's turn ends without an answer: Claude's Stop and its session closing
 * (a daemon restart). Codex reports nothing when its process goes; reconcile catches that.
 */
const CANCELED = new Set(["Permission request canceled", "Claude session closed"]);

/** Question tools whose agent keeps working while the question waits: the host keeps them pending past the turn. */
const NON_BLOCKING = new Set(["request_user_input_async"]);

export interface PermissionResponder {
  respond(agentId: string, requestId: string, response: { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }): Promise<void>;
  /** Queue a message for the agent, held while it waits on another question and sent like any [asks] message. */
  message(agentId: string, workspaceId: string, text: string): void;
}

interface QuestionRequest {
  id: string;
  kind: string;
  name?: string;
  provider?: string;
  input?: unknown;
}

/**
 * Native questions from every agent, on disk. A pending one belongs to the agent's running turn and the host re-lists
 * it (reconcile). A postponed one exists only here once its agent was released. A pending one whose turn died (a
 * daemon restart) without an answer is kept as postponed, so the human's answer still reaches the agent.
 */
export class QuestionBook {
  private readonly path: string;
  private readonly questions = new Map<string, PendingQuestion>();

  constructor(
    root: string,
    private readonly responder: PermissionResponder,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(root, "questions.json");
    const saved = existsSync(this.path) ? z.array(PendingQuestionSchema).safeParse(JSON.parse(readFileSync(this.path, "utf8"))) : null;
    for (const question of saved?.success ? saved.data : []) this.questions.set(questionKey(question), question);
  }

  list(workspaceId?: string): PendingQuestion[] {
    return [...this.questions.values()]
      .filter((question) => !workspaceId || question.workspaceId === workspaceId)
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  /** Whether the agent is stopped on a question right now: a message steered into its turn would cancel it. */
  isWaiting(agentId: string): boolean {
    return this.list().some((question) => question.agentId === agentId && question.state === "pending" && question.blocking);
  }

  /** A permission request became pending. Returns the question it carries, or null for any other request. */
  track(agent: { id: string; workspaceId?: string | null; provider?: string }, request: QuestionRequest): PendingQuestion | null {
    const questions = readQuestions(request);
    if (!questions || !agent.workspaceId) return null;
    const key = questionKey({ agentId: agent.id, requestId: request.id });
    const known = this.questions.get(key);
    if (known) return known;
    const question: PendingQuestion = {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      requestId: request.id,
      provider: request.provider ?? agent.provider ?? "unknown",
      blocking: !NON_BLOCKING.has(request.name ?? ""),
      questions,
      state: "pending",
      askedAt: this.now().toISOString(),
    };
    this.questions.set(key, question);
    this.save();
    return question;
  }

  /**
   * A pending request was answered or cleared (in the chat, by another plugin, or by an interrupt). Postponed ones
   * stay. A blocking question whose turn was canceled (a daemon restart, Stop) never got an answer: it is kept as put
   * off, so the human's answer still reaches the agent, as a message.
   */
  resolved(agentId: string, requestId: string, resolution?: { behavior: string; message?: string }): void {
    const question = this.questions.get(questionKey({ agentId, requestId }));
    if (!question || (question.state === "postponed" && question.blocking)) return;
    if (question.blocking && resolution?.behavior === "deny" && CANCELED.has(resolution.message ?? "")) {
      this.questions.set(questionKey(question), { ...question, state: "postponed", postponedAt: this.now().toISOString() });
      this.save();
      return;
    }
    this.forget(question);
  }

  /**
   * The host's own pending requests per agent win over what the hooks left behind. Only agents in the listing are
   * reconciled: one the listing left out (a page limit) keeps its questions.
   */
  reconcile(
    agents: readonly {
      id: string;
      workspaceId?: string | null;
      provider?: string;
      status?: string;
      pendingPermissions?: readonly QuestionRequest[] | null;
    }[],
  ): void {
    const running = new Set(agents.filter((agent) => agent.status === "running" || agent.status === "initializing").map((agent) => agent.id));
    const listed = new Set(agents.map((agent) => agent.id));
    const live = new Set<string>();
    for (const agent of agents) {
      for (const request of agent.pendingPermissions ?? []) {
        if (this.track(agent, request)) live.add(questionKey({ agentId: agent.id, requestId: request.id }));
      }
    }
    for (const [key, question] of this.questions) {
      if (!listed.has(question.agentId) || live.has(key)) continue;
      // A postponed blocking question was released on purpose; a postponed async one still lives in the host.
      if (question.state === "postponed" && question.blocking) continue;
      if (question.state === "pending" && question.blocking && !running.has(question.agentId)) {
        // Its turn ended without an answer reaching it (a daemon restart): the answer can only go out as a message.
        this.questions.set(key, { ...question, state: "postponed", postponedAt: this.now().toISOString() });
        this.save();
        continue;
      }
      this.forget(question);
    }
  }

  async answer(agentId: string, requestId: string, raw: Answers): Promise<{ delivered: "tool" | "message" }> {
    const question = this.require(agentId, requestId);
    const answers = checkAnswers(question.questions, raw);
    if (question.state === "pending" || !question.blocking) {
      await this.responder.respond(agentId, requestId, { behavior: "allow", updatedInput: { answers } });
      this.forget(question);
      return { delivered: "tool" };
    }
    this.responder.message(agentId, question.workspaceId, answerMessage(question.questions, answers));
    this.forget(question);
    return { delivered: "message" };
  }

  /** Answer later: the agent's tool call returns now, and the question stays here until the human answers it. */
  async postpone(agentId: string, requestId: string): Promise<PendingQuestion> {
    const question = this.require(agentId, requestId);
    if (question.state === "postponed") return question;
    // Marked first: answering fires the resolved hook, which must not drop it.
    const postponed: PendingQuestion = { ...question, state: "postponed", postponedAt: this.now().toISOString() };
    this.questions.set(questionKey(question), postponed);
    this.save();
    // The agent never stopped for it: nothing to release.
    if (!question.blocking) return postponed;
    try {
      // A placeholder answer, not a decline: agents read a decline as a failed question and re-ask it (Claude
      // recorded it with ask_create). With this answer Claude and Codex both carried on with the rest of the task.
      await this.responder.respond(agentId, requestId, {
        behavior: "allow",
        updatedInput: { answers: Object.fromEntries(question.questions.map((item) => [item.header, POSTPONED])) },
      });
    } catch (error) {
      this.questions.set(questionKey(question), question);
      this.save();
      throw error;
    }
    return postponed;
  }

  async drop(agentId: string, requestId: string): Promise<{ dropped: boolean }> {
    const question = this.questions.get(questionKey({ agentId, requestId }));
    if (!question) return { dropped: false };
    if (question.state === "pending" || !question.blocking) {
      await this.responder.respond(agentId, requestId, { behavior: "deny", message: "The human dismissed this question." });
      this.forget(question);
    } else {
      this.responder.message(agentId, question.workspaceId, `${DROPPED_LATER} ${question.questions.map((item) => item.question).join(" / ")}`);
      this.forget(question);
    }
    return { dropped: true };
  }

  /** The agent is archived: its questions can't be answered any more. */
  forgetAgent(agentId: string): void {
    let changed = false;
    for (const [key, question] of this.questions) {
      if (question.agentId !== agentId) continue;
      this.questions.delete(key);
      changed = true;
    }
    if (changed) this.save();
  }

  private forget(question: PendingQuestion): void {
    this.questions.delete(questionKey(question));
    this.save();
  }

  private require(agentId: string, requestId: string): PendingQuestion {
    const question = this.questions.get(questionKey({ agentId, requestId }));
    if (!question) throw new Error("This question was already answered or is gone");
    return question;
  }

  private save(): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.list(), null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
