import type { Ask } from "../shared/asks";

/**
 * in_progress hides an ask's buttons and keeps it out of "waiting on you", so it is only true while the owner is
 * working on it or someone other than the human holds it. These rules catch the asks where neither holds.
 */

/** An in-progress ask the owner has not touched for this long while not running is waiting on the human, or on nobody. */
export const STALE_MS = 24 * 60 * 60 * 1000;

/** Pending checks on a subscribed PR: the watcher wakes the owner when they finish, so nobody needs reminding. */
export function waitsOnChecks(ask: Pick<Ask, "subscribe" | "pr">): boolean {
  return Boolean(ask.subscribe && ask.pr?.state === "OPEN" && ask.pr.checks === "pending");
}

/** Owner ended a turn holding this ask in progress: remind once per change of the ask. */
export function needsReminder(ask: Ask): boolean {
  if (ask.status !== "in_progress" || ask.orphaned || waitsOnChecks(ask)) return false;
  return !ask.remindedAt || ask.remindedAt < ask.updatedAt;
}

/** In progress, owner not running, untouched for STALE_MS. */
export function isStale(ask: Ask, now: Date, ownerRunning: boolean): boolean {
  return ask.status === "in_progress" && !ownerRunning && now.getTime() - Date.parse(ask.updatedAt) >= STALE_MS;
}

export function stuckReminder(asks: readonly Pick<Ask, "id" | "title">[]): string {
  const list = asks.map((ask) => `${ask.id} (${ask.title})`).join(", ");
  return `[asks] Your turn ended with ${list} in progress, so the human sees no buttons on ${asks.length > 1 ? "them" : "it"}. For each: if you are still working on it, or it waits on CI or a reviewer other than the human, leave it. If the next move is the human's (a label, an approval, a merge, an answer), ask_update it with the action they need; that sets it back to open. If it is finished, ask_resolve it. Then reply in one line.`;
}
