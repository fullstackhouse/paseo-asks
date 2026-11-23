/**
 * Answering an ask from any view tells the composer pills and Overview summaries, which otherwise only re-read the
 * asks on their own slower poll, so a card you just answered stops counting as waiting on you right away.
 */
const listeners = new Set<() => void>();

export function onAsksChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function asksChanged(): void {
  for (const listener of listeners) listener();
}
