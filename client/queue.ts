import { awaitsYou, type Ask } from "../shared/asks";

export type QueueFilter = "needs_you" | "in_progress" | "other";

/** Keep the main queue's attention count consistent with the sidebar. */
export function askQueue(
  asks: readonly Ask[],
  snoozed: ReadonlySet<string>,
): Record<QueueFilter, Ask[]> {
  const queue: Record<QueueFilter, Ask[]> = { needs_you: [], in_progress: [], other: [] };
  for (const ask of asks) {
    if (ask.status !== "open" && ask.status !== "in_progress") continue;
    const filter =
      snoozed.has(ask.workspaceId) || (ask.pr && ask.pr.state !== "OPEN")
        ? "other"
        : awaitsYou(ask)
          ? "needs_you"
          : "in_progress";
    queue[filter].push(ask);
  }
  for (const rows of Object.values(queue))
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return queue;
}
