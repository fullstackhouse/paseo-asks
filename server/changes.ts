import type { AskChangesEvent } from "../shared/changes";

/** Writes coalesce for this long, so an agent's create-then-update or a watcher pass is one event. */
export const PUSH_DELAY_MS = 50;

export interface AskChangeFeed {
  onChange(listener: (workspaceId: string) => void): () => void;
}

/** Serves one client's `askChanges` subscription: one event per burst of writes, until `signal` aborts. */
export function pushAskChanges(
  feed: AskChangeFeed,
  push: (event: AskChangesEvent) => Promise<unknown>,
  signal: AbortSignal,
): void {
  if (signal.aborted) return;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const workspaceIds = [...pending];
    pending = new Set();
    if (signal.aborted || workspaceIds.length === 0) return;
    void push({ type: "changed", workspaceIds }).catch(() => undefined);
  };
  const stop = feed.onChange((workspaceId) => {
    pending.add(workspaceId);
    timer ??= setTimeout(flush, PUSH_DELAY_MS);
  });
  signal.addEventListener(
    "abort",
    () => {
      stop();
      if (timer) clearTimeout(timer);
    },
    { once: true },
  );
}
