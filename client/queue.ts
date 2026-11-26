import { awaitsYou, oldestFirst, type Ask } from "../shared/asks";

export type QueueFilter = "needs_you" | "in_progress" | "other";

/** Keep the main queue's attention count consistent with the sidebar. */
export function askQueue(
  asks: readonly Ask[],
  snoozed: ReadonlySet<string>,
): Record<QueueFilter, Ask[]> {
  const queue: Record<QueueFilter, Ask[]> = { needs_you: [], in_progress: [], other: [] };
  for (const ask of asks) {
    if (ask.status !== "open" && ask.status !== "in_progress") continue;
    const filter = snoozed.has(ask.workspaceId) ? "other" : awaitsYou(ask) ? "needs_you" : "in_progress";
    queue[filter].push(ask);
  }
  for (const rows of Object.values(queue)) rows.sort(oldestFirst);
  return queue;
}

/** The ask to open once `answered` is answered: the next one below it that waits on you, else the first above it. */
export function nextWaitingAsk(rows: readonly Ask[], answered: Pick<Ask, "workspaceId" | "id">): Ask | undefined {
  const index = rows.findIndex((ask) => ask.workspaceId === answered.workspaceId && ask.id === answered.id);
  const after = index === -1 ? rows : rows.slice(index + 1);
  const before = index === -1 ? [] : rows.slice(0, index);
  return after.find(awaitsYou) ?? before.find(awaitsYou);
}
