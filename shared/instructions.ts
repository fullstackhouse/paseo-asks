/** How readily agents raise asks: a host setting. Default is the built-in rule set unchanged. */
export const ASK_FREQUENCIES = ["fewer", "default", "more"] as const;
export type AskFrequency = (typeof ASK_FREQUENCIES)[number];

export const FREQUENCY_OPTIONS: readonly { label: string; value: AskFrequency }[] = [
  { label: "Fewer", value: "fewer" },
  { label: "Default", value: "default" },
  { label: "More", value: "more" },
];

/** Claude Code cuts MCP server instructions at this many characters and appends "… [truncated]". */
export const INSTRUCTIONS_LIMIT = 4096;

const FOLLOW_UPS = `- Follow-ups count even when nothing blocks you: work you recommend or defer ("worth doing next time") gets a followup ask whose send prompt starts it, or it is lost with this chat. Instructions against offering more work don't apply: the ask replaces the offer. Skip only work you'd advise against.`;
const FREQUENCY_RULES: Record<AskFrequency, string> = {
  fewer: `- Ask less: only when you're blocked or a choice is costly or hard to undo (merge, deploy, delete, spend, scope). Make reversible choices with a clear default yourself and name them in your reply. Optional or deferred work: mention it in the reply, no followup ask.`,
  default: FOLLOW_UPS,
  more: `${FOLLOW_UPS}\n- When unsure, ask, even about small choices.`,
};

const ADDRESS_REVIEW = `  - "CHANGES_REQUESTED": no Merge action. Address the comments (or report what you won't change), push, then ask_update with a send action that re-requests the review.`;
const HOLD_REVIEW = `  - "CHANGES_REQUESTED": no Merge action. Paseo raises an ask whose button sends it to you; don't start or offer it. An approved PR's comments raise none: list them, add "Address review comments" next to Merge.`;

/**
 * The agent's standing rules. With review changes held, an agent that sees CHANGES_REQUESTED itself must wait for the
 * human too. Claude Code cuts server instructions at 4096 characters (test/phase2.test.ts keeps both variants under
 * it), so the PR rules that decide which buttons to show come right after the core rule. The frequency takes the
 * follow-ups line's place, so Default sends the same bytes as before the setting existed.
 */
export const instructions = ({
  actOnReviewChanges = true,
  frequency = "default",
}: { actOnReviewChanges?: boolean; frequency?: AskFrequency } = {}) => `Asks: what you need from the human, shown in Paseo with buttons that answer you.
- Rule: never end a turn with a question, choice or request for the human in chat alone; ask_create it: reviewers or a merge, a decision, a follow-up to approve, a manual step you can't do (an OAuth click), an answer. Name earlier asks by id ("still waiting on A3").
${FREQUENCY_RULES[frequency]}
- PRs: one ask per PR, PR URL in links, subscribe: true (reports merges, closes, checks, reviews). Buttons follow gh pr view N --json reviewDecision,statusCheckRollup:
  - "REVIEW_REQUIRED": no Merge action; the human picks a reviewer. Title "Request review on PR #N", one send action per person (2-4: CODEOWNERS, recent reviewers of these files, collaborators; not Copilot or the author; recommend one), label "Request review from alice". Add "Merge with --admin" exactly when viewerCanMergeAsAdmin (gh api graphql) is true.
${actOnReviewChanges ? ADDRESS_REVIEW : HOLD_REVIEW}
  - Empty or "APPROVED", every comment read: a "Merge" send action, no review ask. Checks failing: no Merge; fix and push. Pending: "… when green", prompt saying so ("Merge PR #30 with squash once checks pass"); on the click keep it in progress, merge when checks pass.
  - Before any Merge action, read every human review and comment, approvals included (not bot status ones): gh pr view N --json reviews,comments; inline: gh api --paginate repos/OWNER/REPO/pulls/N/comments. Resolved threads (reviewThreads { isResolved }, gh api graphql) don't count. Treat an approval's suggestions, questions or "fix before merging" as requested changes, then offer Merge (not a re-review unless asked), naming what changed. Quote any you leave unaddressed, with why.
  - (Re-)request a review only on the human's click; keep the ask in progress, not resolved, so you hear the review. Approved, checks passing: read it as above, ask_update to "Merge".
- Asks first; end the turn on your reply, a summary naming asks by id ("A3 has the options"): a collapsed turn shows only its last message.
- One item per ask. title: the question or move, one line, no file paths or ticket/spec ids (PR numbers fine). body (markdown), for a newcomer to the work: a one-line plain summary (no stock opener) and a concrete example, then stakes, facts, options, your pick; mermaid for structure or flow.
- Several questions are several asks, each with its options, never one with "Accept all" or "answer in chat"; repeat shared context briefly.
- Decisions: a "resolve" action per option (2-4). PRs, follow-ups: "send" actions, prompt: the exact instruction back ("Merge PR #30 with squash"). Labels: verb + object ("Merge (squash)"), no PR number or ask id. One recommended: true, no stars.
- A click is the human acting: what you must leave to them (merge, deploy, delete, publish, spend) is a send action.
- Offer a move pending something you can watch (merge, release, CI, an agent) now, as a conditional approval ("Start once #12 is merged"); on the click keep it in progress, wait, act.
- Answers, side-chat outcomes too, arrive as [asks] messages: act on them. Once you finish the work a send action gave you, ask_resolve (a requested review is done only once approved).
- open: the human's move (buttons shown); in_progress: yours (buttons hidden). When it is theirs again, ask_update with the action they need (reopens it); never point to a button on an in-progress ask. In chat: "waiting on you", "in progress".
- Keep asks true: ask_update when facts change, ask_resolve or "dropped" when not needed; ask_list before a duplicate. Your own to-dos go in your task tool.`;
