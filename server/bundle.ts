/**
 * Detects an ask that bundles several questions behind one "accept all" button, which the human can't answer one
 * question at a time. Only the title and action labels are checked: a body may legitimately list questions meant for
 * someone else (a seller, a PR's reviewers), so bodies would give false positives. Patterns come from real bundles in
 * the asks data; see test/bundle.test.ts.
 */
const BUNDLED_TITLE = [
  // "Answer the 7 open questions", "Review spec #590 (11 open questions)", "Sign off 10 decisions". A bare "4
  // questions" may be questions for someone else ("ask the seller 4 questions first"), so it needs "answer".
  /\b\d+\s+(?:open|gate|owner|pending)\s+(?:questions|decisions)\b|\b\d+\s+decisions\b|\banswer\b.*\b\d+\s+questions\b/i,
  // "Answer Q1–Q7", "Sign off decisions D1–D10"
  /\b[QD]-?1\s*[–—-]\s*[QD]?-?\d+\b/i,
];

const BUNDLED_LABEL = [
  // "Accept all recommendations", "Accept all 4 proposals + merge both", "Approve as proposed", "Accept all defaults"
  /\b(?:accept|approve)\b.*\b(?:all|everything|as proposed|defaults|recommendations|proposals)\b/i,
  // "I'll answer in chat", "Answer differently", "Answer by number", "Odpowiadam w czacie"
  /\banswer(?:ing)?\s+(?:in\s+chat|in\s+the\s+pr|by\s+number|differently)\b|\bodpowi\w*\s+w\s+czacie\b/i,
];

/** Why the ask is a bundle, or null when it is one item. */
export function bundleReason(title: string, actionLabels: string[]): string | null {
  if (BUNDLED_TITLE.some((pattern) => pattern.test(title))) return `the title "${title}" counts several questions`;
  const label = actionLabels.find((candidate) => BUNDLED_LABEL.some((pattern) => pattern.test(candidate)));
  if (label) return `the action "${label}" answers several questions at once`;
  return null;
}

export function checkNotBundled(title: string, actionLabels: string[]): void {
  const reason = bundleReason(title, actionLabels);
  if (!reason) return;
  throw new Error(
    `This ask bundles several questions: ${reason}. Create one ask per question instead, each with its own options and your proposal marked recommended; repeat the shared context in a line or two of each body. Nothing was saved.`,
  );
}
