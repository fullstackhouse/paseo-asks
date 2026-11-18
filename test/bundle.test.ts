import { describe, expect, it } from "vitest";
import { bundleReason } from "../server/bundle";

// Real asks from the asks data (titles and labels, details paraphrased). Bundles put several questions behind one
// "accept all" button; the singles must keep passing, including bodies that list questions meant for someone else.
const BUNDLES: [string, string[]][] = [
  ["Answer Q1–Q7 for the identity spec", ["Accept all recommendations"]],
  ["Sign off SPEC-024 decisions D1–D10 (reset plan)?", ["Accept all, push as PR", "Push as draft PR, I'll edit", "Rework it"]],
  ["Answer the 8 gate questions for the attribute-system spec (#471)", ["Accept all recommendations", "I'll answer in the PR"]],
  ["Audit 2023–2025: facts before I compute the exposure", ["Odpowiadam w czacie", "Nie róbmy audytu"]],
  ["D3: answer spec #565's 4 open questions, then merge #565 and #568?", ["Accept all 4 proposals + merge both", "Answer differently", "Merge #565 only"]],
  ["Review spec #590: monitoring for queues and jobs (11 open questions)", ["Accept all defaults", "Open #590 to comment"]],
  ["Answer the 7 open questions for the organization-scoped settings spec", ["Accept all recommended", "I'll answer in chat"]],
  ["Settings nav atlas ready: approve option F (or say what to change)?", ["Approve as proposed", "Changes"]],
];

const SINGLES: [string, string[]][] = [
  ["Review spec PR #6: product structure", ["Approve the spec", "Request changes", "Open PR"]],
  ["Push the identity spec and open a PR?", ["Push and open the PR", "I'll read it locally first"]],
  ["Review #116: upgrade notes per release", ["Merge #116 (squash)", "Relabel the upgrade skills in #116 too"]],
  ["Forward-undo spec: soft delete + restore (B), or delete not undoable (C)?", ["B: soft delete + restore", "C: delete not undoable", "Discuss first"]],
  ["Commit the 3 storyboard comments to PR #35's comments.js?", ["Commit to PR #35 (recommended)", "Commit to PR #36 instead", "Don't commit"]],
  ["Buy the account (ask the seller 4 questions first)", ["Open the offer", "Bought"]],
  ["Bundled asks: which mechanism do I build?", ["A: skill fix + rejection", "B: A + questions[] field", "C: skill fix only"]],
  ["Request review on PR #30", ["Request review from alice", "Merge with --admin"]],
  ["Merge PR #30 when green", ["Merge when green"]],
  ["Approve deploying 1.2.3 to production?", ["Approve", "Not yet"]],
  ["Review the time & attendance spec", ["Approve", "Uwagi w czacie"]],
];

describe("bundleReason", () => {
  it.each(BUNDLES)("flags %s", (title, labels) => {
    expect(bundleReason(title, labels)).not.toBeNull();
  });
  it.each(SINGLES)("passes %s", (title, labels) => {
    expect(bundleReason(title, labels)).toBeNull();
  });
});
