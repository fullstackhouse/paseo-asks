/** Sent once when a turn leaves something for the human that no ask records. Worded so "no ask" is not the easy way out. */
export const NUDGE =
  '[asks] A check found that your last reply leaves something for the human (a question, decision, approval, review, manual step, or a follow-up you recommended or deferred), and no ask records it, so it is easy to miss. Call ask_create now, one per item, then reply with just the ids. Reply "no ask" only if your reply truly leaves nothing for the human to do or decide.';

/** Sent when the human presses Refresh on an agent's asks. */
export const REFRESH =
  "[asks] The human wants your asks up to date. Run ask_list with scope mine. Create an ask for anything you are waiting on them for, and any follow-up you recommended or deferred, that has none, and ask_update or ask_resolve the ones that are out of date. Leave out what the human already decided or said they will do themselves. Then reply in one line.";

const STUCK_HEAD = "[asks] Your turn ended with ";
const STUCK_TAIL =
  " For each: if you are still working on it, or it waits on CI or a reviewer other than the human, leave it. If the next move is the human's (a label, an approval, a merge, an answer), ask_update it with the action they need; that sets it back to open. If it is finished, ask_resolve it. Then reply in one line.";

/** Sent when the agent's turn ends holding asks in progress, which hides their buttons from the human. */
export function stuckReminder(asks: readonly { id: string; title: string }[]): string {
  const list = asks.map((ask) => `${ask.id} (${ask.title})`).join(", ");
  return `${STUCK_HEAD}${list} in progress, so the human sees no buttons on ${asks.length > 1 ? "them" : "it"}.${STUCK_TAIL}`;
}

/** The asks a stuck reminder names, or undefined for any other text. */
export function parseStuckReminder(text: string): { id: string; title: string }[] | undefined {
  if (!text.startsWith(STUCK_HEAD) || !text.endsWith(STUCK_TAIL)) return undefined;
  const list = text.slice(STUCK_HEAD.length, -STUCK_TAIL.length).match(/^([\s\S]*) in progress, so the human sees no buttons on (?:it|them)\.$/)?.[1];
  if (!list) return undefined;
  // Titles can hold ", " and parentheses, so split only where the next ask's id starts.
  return list.split(/, (?=A\d+ \()/).flatMap((entry) => {
    const m = entry.match(/^(A\d+) \(([\s\S]*)\)$/);
    return m ? [{ id: m[1], title: m[2] }] : [];
  });
}
