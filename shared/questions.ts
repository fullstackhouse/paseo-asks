import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * A question an agent asked with its provider's own question tool (Claude's AskUserQuestion, Codex's
 * request_user_input, OpenCode's and Pi's question tools). Paseo shows it as a pending permission of kind
 * "question"; this plugin lists them from every agent next to the asks.
 */
export const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});

export const NativeQuestionSchema = z.object({
  /** Answers are keyed by header: every provider maps that back to its own shape. */
  header: z.string(),
  question: z.string(),
  options: z.array(QuestionOptionSchema),
  multiSelect: z.boolean().optional(),
});
export type NativeQuestion = z.infer<typeof NativeQuestionSchema>;

export const QUESTION_STATES = ["pending", "postponed"] as const;

export const PendingQuestionSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  requestId: z.string(),
  provider: z.string(),
  /**
   * The agent stops until it is answered (Claude, Codex request_user_input). False for Codex's async questions: the
   * agent keeps working and the host keeps the question after the turn, so Answer later only moves it in this list.
   */
  blocking: z.boolean().default(true),
  questions: z.array(NativeQuestionSchema),
  /**
   * pending: the agent waits on the answer (Claude stops until then; Codex async questions keep working).
   * postponed: the human chose Answer later; the agent was told to go on, and the answer goes out as a message.
   */
  state: z.enum(QUESTION_STATES),
  askedAt: z.string(),
  postponedAt: z.string().optional(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

/** Header → answer. Several picked options are joined with ", ", as the host's question card does. */
export const AnswersSchema = z.record(z.string(), z.string());
export type Answers = z.infer<typeof AnswersSchema>;

export function questionKey(question: Pick<PendingQuestion, "agentId" | "requestId">): string {
  return `${question.agentId}/${question.requestId}`;
}

/** The questions of a permission request, or null when it is not a question or its input has no usable questions. */
export function readQuestions(request: { kind: string; input?: unknown }): NativeQuestion[] | null {
  if (request.kind !== "question" || !isRecord(request.input) || !Array.isArray(request.input.questions)) return null;
  const questions: NativeQuestion[] = [];
  request.input.questions.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const question = text(raw.question);
    if (!question) return;
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          if (!isRecord(option) || !text(option.label)) return [];
          return [
            {
              label: text(option.label)!,
              ...(text(option.description) ? { description: text(option.description) } : {}),
              ...(text(option.preview) ? { preview: text(option.preview) } : {}),
            },
          ];
        })
      : [];
    questions.push({
      header: text(raw.header) ?? `Question ${index + 1}`,
      question,
      options,
      ...(raw.multiSelect === true ? { multiSelect: true } : {}),
    });
  });
  return questions.length ? questions : null;
}

/** Every question answered with non-empty text; the host rejects a partial answer. */
export function checkAnswers(questions: readonly NativeQuestion[], answers: Answers): Answers {
  const result: Answers = {};
  for (const question of questions) {
    const answer = answers[question.header]?.trim();
    if (!answer) throw new Error(`Answer "${question.header}" before sending`);
    result[question.header] = answer;
  }
  return result;
}

export const LATER_ANSWER_HEAD = "[asks] The human answered the question you asked earlier and they postponed. Act on it now:";
export const DROPPED_LATER = "[asks] The human dropped the question you asked earlier and postponed; do not wait for an answer:";

/** The answer as the agent reads it once its question was postponed: each question, then the human's answer. */
export function answerMessage(questions: readonly NativeQuestion[], answers: Answers): string {
  const lines = questions.map((question) => `${question.question}\nAnswer: ${answers[question.header]}`);
  return `${LATER_ANSWER_HEAD}\n\n${lines.join("\n\n")}`;
}

/** The question's title in a list: its header, or the headers of several. */
export function questionTitle(question: Pick<PendingQuestion, "questions">): string {
  const first = question.questions[0]!;
  if (question.questions.length > 1) return question.questions.map((item) => item.header).join(" · ");
  return firstLine(first.question) || first.header;
}

/** The sentence that asks, wherever the agent put it after its context; else the first line. */
function firstLine(markdown: string): string {
  const plain = markdown
    .split("\n")
    .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
    .filter(Boolean)
    .map((line) => line.replace(/\*\*|__|`/g, ""));
  const sentences = plain.flatMap((line) => line.split(/(?<=[.?!])\s+/));
  return [...sentences].reverse().find((sentence) => sentence.endsWith("?")) ?? plain[0] ?? "";
}

/** Pending questions per workspace, for the composer pill. */
export function pendingByWorkspace(questions: readonly PendingQuestion[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const question of questions) {
    if (question.state === "pending") counts.set(question.workspaceId, (counts.get(question.workspaceId) ?? 0) + 1);
  }
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export const listQuestions = defineRpc({
  name: "asks.questions.list",
  input: z.object({ workspaceId: z.string().optional() }),
  output: z.object({
    questions: z.array(PendingQuestionSchema),
    workspaceNames: z.record(z.string(), z.string()).optional(),
  }),
});

/** Answer a native question. Pending: the agent's tool call returns it. Postponed: it goes out as a message. */
export const answerQuestion = defineRpc({
  name: "asks.questions.answer",
  input: z.object({ agentId: z.string(), requestId: z.string(), answers: AnswersSchema }),
  output: z.object({ delivered: z.enum(["tool", "message"]) }),
});

/** Answer later: release the agent now and keep the question in the list until the human answers it. */
export const postponeQuestion = defineRpc({
  name: "asks.questions.later",
  input: z.object({ agentId: z.string(), requestId: z.string() }),
  output: z.object({ question: PendingQuestionSchema }),
});

/** Drop a question: a pending one is declined, a postponed one leaves the list and the agent is told not to wait. */
export const dropQuestion = defineRpc({
  name: "asks.questions.drop",
  input: z.object({ agentId: z.string(), requestId: z.string() }),
  output: z.object({ dropped: z.boolean() }),
});
