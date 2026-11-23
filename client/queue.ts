import { awaitsYou, oldestFirst, type Ask } from "../shared/asks";
import type { PendingQuestion } from "../shared/questions";
import type { PrCard } from "../shared/prs";

export type QueueFilter = "needs_you" | "later" | "in_progress" | "other";

export interface QuestionQueue {
  needs_you: PendingQuestion[];
  later: PendingQuestion[];
  other: PendingQuestion[];
}

/** Native questions in the main queue: pending ones wait on you, postponed ones are for later, snoozed workspaces go to Other. */
export function questionQueue(questions: readonly PendingQuestion[], snoozed: ReadonlySet<string>): QuestionQueue {
  const queue: QuestionQueue = { needs_you: [], later: [], other: [] };
  for (const question of questions) {
    queue[snoozed.has(question.workspaceId) ? "other" : question.state === "pending" ? "needs_you" : "later"].push(question);
  }
  return queue;
}

/** Keep the main queue's attention count consistent with the sidebar. */
export function askQueue(
  asks: readonly Ask[],
  snoozed: ReadonlySet<string>,
): Record<QueueFilter, Ask[]> {
  const queue: Record<QueueFilter, Ask[]> = { needs_you: [], later: [], in_progress: [], other: [] };
  for (const ask of asks) {
    if (ask.status !== "open" && ask.status !== "in_progress") continue;
    const filter = snoozed.has(ask.workspaceId) ? "other" : awaitsYou(ask) ? "needs_you" : "in_progress";
    queue[filter].push(ask);
  }
  for (const rows of Object.values(queue)) rows.sort(oldestFirst);
  return queue;
}

/** PR cards in the main queue: waiting on you, the agent's move (In progress), and merged or closed today (Other). */
export function prQueue(cards: readonly PrCard[], snoozed: ReadonlySet<string>): Record<QueueFilter, PrCard[]> {
  const queue: Record<QueueFilter, PrCard[]> = { needs_you: [], later: [], in_progress: [], other: [] };
  for (const card of cards) {
    const filter = snoozed.has(card.workspaceId) || card.phase === "done" ? "other" : card.phase === "waiting" ? "needs_you" : "in_progress";
    queue[filter].push(card);
  }
  return queue;
}
