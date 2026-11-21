import { useCallback, useState } from "react";

/**
 * Half-written replies, per ask. The reply box unmounts when its ask collapses (opening another ask
 * in the Overview closes this one), so local state alone loses what the human typed. Kept for the
 * plugin's lifetime; a sent reply clears its draft.
 */
const drafts = new Map<string, string>();

function draftKey(workspaceId: string, askId: string): string {
  return `${workspaceId}\u0000${askId}`;
}

export function readDraft(workspaceId: string, askId: string): string {
  return drafts.get(draftKey(workspaceId, askId)) ?? "";
}

export function writeDraft(workspaceId: string, askId: string, text: string): void {
  if (text) drafts.set(draftKey(workspaceId, askId), text);
  else drafts.delete(draftKey(workspaceId, askId));
}

/** `useState` for an ask's reply box that survives the box unmounting. */
export function useDraft(workspaceId: string, askId: string): [string, (text: string) => void] {
  const [text, setText] = useState(() => readDraft(workspaceId, askId));
  const set = useCallback(
    (next: string) => {
      writeDraft(workspaceId, askId, next);
      setText(next);
    },
    [workspaceId, askId],
  );
  return [text, set];
}
