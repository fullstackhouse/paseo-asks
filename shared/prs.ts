import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { PrStateSchema, type PrState } from "./asks";

/**
 * A workspace's pull request as Asks shows it: built from the PR's own state, not from an ask an agent created.
 * Paseo's daemon already polls each workspace's PR (the `githubRuntime` of its workspace snapshot), so reading it
 * costs no GitHub quota; only preview deployments need a `gh` call of their own.
 */

export const PR_BUTTON_IDS = [
  "merge",
  "merge_when_green",
  "request_review",
  "address_review",
  "fix_checks",
  "resolve_conflicts",
] as const;
export type PrButtonId = (typeof PR_BUTTON_IDS)[number];

export const PrButtonSchema = z.object({
  id: z.enum(PR_BUTTON_IDS),
  label: z.string(),
  primary: z.boolean().optional(),
});
export type PrButton = z.infer<typeof PrButtonSchema>;

/** The button the human last pressed, kept until the PR's state moves on. */
export const PrPressSchema = z.object({
  id: z.enum(PR_BUTTON_IDS),
  label: z.string(),
  note: z.string().optional(),
  at: z.string(),
  /** `prFingerprint` when it was pressed: once the PR changes, the card can wait on the human again. */
  fingerprint: z.string(),
});
export type PrPress = z.infer<typeof PrPressSchema>;

export const AGENT_STATES = ["running", "idle", "gone"] as const;

/** Whose move it is: the human's (`waiting`), the agent's (`working`), nobody's (`done`, merged or closed). */
export const PR_PHASES = ["waiting", "working", "done"] as const;

export const PrCardSchema = z.object({
  url: z.string(),
  number: z.number(),
  title: z.string(),
  workspaceId: z.string(),
  /** The agent a button reaches: the workspace's agent that owns the PR. Null when the workspace has none left. */
  agentId: z.string().nullable(),
  agentState: z.enum(AGENT_STATES),
  pr: PrStateSchema,
  pressed: PrPressSchema.optional(),
  buttons: z.array(PrButtonSchema),
  phase: z.enum(PR_PHASES),
  /** One line on why the card is in its phase, e.g. "Checks are running" or "Ready to merge". */
  reason: z.string(),
  updatedAt: z.string(),
});
export type PrCard = z.infer<typeof PrCardSchema>;

export const listPrs = defineRpc({
  name: "asks.prs.list",
  input: z.object({ workspaceId: z.string().optional() }),
  output: z.object({ prs: z.array(PrCardSchema), workspaceNames: z.record(z.string(), z.string()).optional() }),
});

export const actOnPr = defineRpc({
  name: "asks.prs.act",
  input: z.object({ url: z.string(), button: z.enum(PR_BUTTON_IDS), note: z.string().optional() }),
  output: z.object({ card: PrCardSchema, sent: z.boolean() }),
});

/** The parts of a PR's state that change what a card offers. A press holds until one of them changes. */
export function prFingerprint(pr: Pick<PrState, "state" | "isDraft" | "checks" | "reviewDecision" | "mergeable">): string {
  return [pr.state, pr.isDraft ? "draft" : "ready", pr.checks, pr.reviewDecision ?? "none", pr.mergeable].join("|");
}

export const PR_BUTTON_LABELS: Record<PrButtonId, string> = {
  merge: "Merge",
  merge_when_green: "Merge when green",
  request_review: "Request review",
  address_review: "Address review comments",
  fix_checks: "Fix checks",
  resolve_conflicts: "Resolve conflicts",
};

export interface PrRuleInput {
  pr: PrState;
  agentState: (typeof AGENT_STATES)[number];
  pressed?: PrPress;
  /** The "Tell agents about requested changes" setting: on, the agent already works the review on its own. */
  actOnReviewChanges: boolean;
}

/**
 * What the card offers and whose move it is. The waiting rule, which the sidebar count, the pill and the queue share:
 *
 * A PR waits on the human when it is open, not a draft, its agent is idle, no button was pressed since the PR last
 * changed, and the next move is one only the human makes:
 * - checks passed (or there are none) and nobody asked for changes: Merge;
 * - a review is required: pick the reviewer (Request review);
 * - changes were requested while "Tell agents about requested changes" is off: say when to address them.
 *
 * It does not wait while checks run (Merge when green is there to press), while its agent is running, when checks
 * fail or it conflicts with its base (the agent's move: it is told about failing checks), on a draft, after a press
 * until the PR changes, or when its agent is gone (nobody would get the button). Merged and closed PRs are done.
 */
export function prRules({ pr, agentState, pressed, actOnReviewChanges }: PrRuleInput): {
  buttons: PrButton[];
  phase: PrCard["phase"];
  reason: string;
} {
  if (pr.state !== "OPEN") return { buttons: [], phase: "done", reason: pr.state === "MERGED" ? "Merged" : "Closed" };
  if (agentState === "gone") return { buttons: [], phase: "working", reason: "No agent left in this workspace to act on it" };
  if (pr.isDraft) return { buttons: [], phase: "working", reason: "Draft" };
  const { ids, waits, reason } = next(pr, actOnReviewChanges);
  const buttons = ids.map((id, index) => ({ id, label: PR_BUTTON_LABELS[id], ...(index === 0 ? { primary: true } : {}) }));
  const held = pressed?.fingerprint === prFingerprint(pr);
  if (held) return { buttons, phase: "working", reason: `You chose ${pressed.label}` };
  if (agentState === "running") return { buttons, phase: "working", reason: "The agent is working" };
  return { buttons, phase: waits ? "waiting" : "working", reason };
}

function next(pr: PrState, actOnReviewChanges: boolean): { ids: PrButtonId[]; waits: boolean; reason: string } {
  if (pr.mergeable === "CONFLICTING") return { ids: ["resolve_conflicts"], waits: false, reason: "Conflicts with its base" };
  if (pr.checks === "failing") return { ids: ["fix_checks"], waits: false, reason: "Checks are failing" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return actOnReviewChanges
      ? { ids: ["address_review"], waits: false, reason: "Changes requested; the agent was told" }
      : { ids: ["address_review"], waits: true, reason: "Changes requested; the agent waits for you" };
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { ids: ["request_review"], waits: true, reason: "Needs a reviewer" };
  if (pr.checks === "pending") return { ids: ["merge_when_green"], waits: false, reason: "Checks are running" };
  // No review decision: the repo requires none, so a review is optional.
  return pr.reviewDecision === "APPROVED"
    ? { ids: ["merge"], waits: true, reason: "Approved and green" }
    : { ids: ["merge", "request_review"], waits: true, reason: "Green; no review required" };
}

/** What a button sends the agent. Merges read the reviews first: an approval often carries "fix before merging". */
export function prPrompt(button: PrButtonId, pr: Pick<PrState, "number" | "url">, note?: string): string {
  const ref = `PR #${pr.number} (${pr.url})`;
  const reviews = `First read every review body and comment from people, approvals included, skipping bot status comments (gh pr view ${pr.number} --json reviews,comments; inline ones with gh api --paginate repos/OWNER/REPO/pulls/${pr.number}/comments; resolved threads don't count) and handle what they ask. If something there should stop the merge, ask me with your question tool instead.`;
  const prompts: Record<PrButtonId, string> = {
    merge: `Merge ${ref}. ${reviews}`,
    merge_when_green: `Merge ${ref} once its checks pass: watch them (gh pr checks ${pr.number} --watch), and if they fail, fix them, push and watch again. ${reviews}`,
    request_review: `Request a review on ${ref}. If my note doesn't name the reviewer, pick the likely ones (CODEOWNERS, recent reviewers of the touched files) and ask me with your question tool which to request.`,
    address_review: `Address the review comments on ${ref}, or say what you will not change and why, then push and re-request review from the reviewers who asked for changes.`,
    fix_checks: `Checks are failing on ${ref}. Find out why, fix them and push.`,
    resolve_conflicts: `${ref} conflicts with its base branch. Merge or rebase onto the base, resolve the conflicts and push.`,
  };
  return `[asks] ${PR_BUTTON_LABELS[button]}: ${prompts[button]}${note ? ` Note from the human: "${note}"` : ""}`;
}

/** The PR of a workspace snapshot's `githubRuntime`, in the plugin's own shape; null when there is none. */
export interface HostPullRequest {
  number?: number;
  url: string;
  title: string;
  state: string;
  isMerged: boolean;
  isDraft?: boolean;
  mergeable?: string;
  checksStatus?: "none" | "pending" | "success" | "failure";
  reviewDecision?: "approved" | "changes_requested" | "pending" | null;
}

const CHECKS: Record<NonNullable<HostPullRequest["checksStatus"]>, PrState["checks"]> = {
  none: "none",
  pending: "pending",
  success: "passing",
  failure: "failing",
};
const REVIEWS: Record<NonNullable<HostPullRequest["reviewDecision"]>, string> = {
  approved: "APPROVED",
  changes_requested: "CHANGES_REQUESTED",
  pending: "REVIEW_REQUIRED",
};

export function fromHost(pr: HostPullRequest, fetchedAt: string): (PrState & { title: string }) | null {
  const number = pr.number ?? Number(/\/pull\/(\d+)/.exec(pr.url)?.[1]);
  if (!Number.isFinite(number)) return null;
  return {
    number,
    url: pr.url,
    title: pr.title,
    state: pr.isMerged || pr.state === "merged" ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN",
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision ? REVIEWS[pr.reviewDecision] : null,
    checks: CHECKS[pr.checksStatus ?? "none"],
    mergeable: pr.mergeable ?? "UNKNOWN",
    fetchedAt,
  };
}

/** Changes an agent acts on, keyed by PR rather than by ask: merged, closed, checks failing, changes requested. */
export function describeCardChange(before: PrState, after: PrState, { review }: { review: boolean }): string | null {
  const changes: string[] = [];
  if (before.state !== after.state && after.state !== "OPEN") changes.push(after.state === "MERGED" ? "merged" : "closed without merging");
  if (after.state === "OPEN" && before.checks !== "failing" && after.checks === "failing") changes.push("checks failing: fix them and push");
  if (review && after.state === "OPEN" && before.reviewDecision !== "CHANGES_REQUESTED" && after.reviewDecision === "CHANGES_REQUESTED") {
    changes.push("changes requested: address the comments, or say what you will not change, then push and re-request review");
  }
  return changes.length ? `[asks] PR #${after.number} ${changes.join("; ")}.` : null;
}

/** Done PRs stay this long, so a merge you just made still shows, then fold away. */
export const DONE_KEPT_MS = 24 * 60 * 60 * 1000;

/** Overview entry ids for PR cards; ask ids are `A<n>`, so the prefix keeps them apart. */
export const PR_ENTRY_PREFIX = "pr:";
export function prEntryId(card: Pick<PrCard, "url">): string {
  return PR_ENTRY_PREFIX + card.url;
}

/** PR cards that wait on the human, per workspace, leaving out snoozed workspaces like the asks count does. */
export function waitingPrsByWorkspace(cards: readonly PrCard[], snoozed: ReadonlySet<string>): Map<string, PrCard[]> {
  const result = new Map<string, PrCard[]>();
  for (const card of cards) {
    if (card.phase !== "waiting" || snoozed.has(card.workspaceId)) continue;
    result.set(card.workspaceId, [...(result.get(card.workspaceId) ?? []), card]);
  }
  return result;
}
