/** Sent once when a turn leaves something for the human that no ask records. Worded so "no ask" is not the easy way out. */
export const NUDGE =
  '[asks] A check found that your last reply leaves something for the human (a question, decision, approval, review, manual step, or a follow-up you recommended or deferred), and no ask records it, so it is easy to miss. Call ask_create now, one per item, then reply with just the ids. Reply "no ask" only if your reply truly leaves nothing for the human to do or decide.';

/** Sent when the human presses Refresh on an agent's asks. */
export const REFRESH =
  "[asks] The human wants your asks up to date. Run ask_list with scope mine. Create an ask for anything you are waiting on them for, and any follow-up you recommended or deferred, that has none, and ask_update or ask_resolve the ones that are out of date. Then reply in one line.";
