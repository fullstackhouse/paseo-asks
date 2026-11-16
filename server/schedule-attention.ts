import { awaitsYou, type Ask } from "../shared/asks";

export interface ScheduleRunAttention {
  reason: "failed" | "permission" | "plugin";
  message: string | null;
}

/**
 * What a scheduled run that left asks waiting on you should report: the count and the newest title.
 * Null when nothing waits, so the daemon archives the run as usual.
 */
export function attentionForOpenAsks(asks: readonly Ask[], agentId: string): ScheduleRunAttention | null {
  const waiting = asks
    .filter((ask) => ask.ownerAgentId === agentId && awaitsYou(ask))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const newest = waiting[0];
  if (!newest) return null;
  const count = waiting.length === 1 ? "1 open ask" : `${waiting.length} open asks`;
  return { reason: "plugin", message: `${count}: ${newest.title}`.slice(0, 500) };
}
