import { askChanges, type AskChangesEvent } from "../shared/changes";

/**
 * Tells the composer pills, Overview summaries and open Asks views that the asks changed, so they re-read them now
 * instead of on their own slower poll: after an action in any view, and when the server pushes a change (an agent's
 * ask_create/ask_update/ask_resolve, the PR watcher).
 */
const listeners = new Set<() => void>();

export function onAsksChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function asksChanged(): void {
  for (const listener of listeners) listener();
}

/** The slice of the plugin client context this needs. COMPAT(pluginSubscriptions): the npm SDK pin doesn't type it. */
export interface SubscribingClient {
  subscribe?: (
    contract: typeof askChanges,
    input: Record<string, never>,
    onEvent: (event: AskChangesEvent) => void,
  ) => () => void;
}

/** Signals `asksChanged` for every change the server pushes. On hosts without subscriptions, the polls carry on alone. */
export function watchAskChanges(client: SubscribingClient): () => void {
  if (typeof client.subscribe !== "function") return () => undefined;
  const stop = client.subscribe(askChanges, {}, () => asksChanged());
  return () => stop();
}
