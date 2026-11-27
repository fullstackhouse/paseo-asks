import { prUrlOf, type Action, type Ask } from "../shared/asks";

/** What decides which buttons of an ask on a PR that waits for a review can work. */
export interface PrReview {
  number: number;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  /** True when the human may merge past the review: an admin past branch protection, or a ruleset bypass actor. */
  viewerCanMergeAsAdmin: boolean;
  author: string | null;
}

export type PrReviewOf = (url: string) => Promise<PrReview>;

type ActionLike = Pick<Action, "kind" | "label" | "prompt">;

/**
 * "Merge" as the verb a clause starts with ("Merge (squash)", "QA, then merge when green", "Rebase and merge"), or
 * `gh pr merge`. Not a word in passing: "Wait for #12 to merge, then start", "Start phase 2 (after merge #12)",
 * "Close it, don't merge it", "Fix merge conflicts".
 */
const MERGE_VERB = /(?:^|[\n.,;:!?(]\s*|\b(?:then|and)\s+)(?:squash[- ]?)?merge\b(?![- ]conflicts?\b)|\bgh pr merge\b/i;
const REVIEW = /\breview\b/i;
// "Request review from alice", "Request review on PR #30 from @alice", "Ask bob for a review".
const REVIEWER = /\bfrom\s+@?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\b|\bask\s+@?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\s+(?:for|to)\b/i;
// "Merge PR #30 with squash once alice approves", "Merge (squash) when approved".
const WAITS_FOR_APPROVAL = /\b(?:once|when|after|if)\b[^\n]*\bapprov/i;
const NOT_A_PERSON = /^(?:copilot|me|myself|you|github|codeowners|someone|anyone|the|a|an|team|them)$/i;

const text = (action: ActionLike) => `${action.label}\n${action.prompt ?? ""}`;

/**
 * A send action that merges the PR. A review request that merges afterwards ("Request review from alice", prompt "…
 * then merge") is not one; "Merge (skip review)" is, so the label must name a reviewer to count as a request.
 */
export function isMergeAction(action: ActionLike): boolean {
  return action.kind === "send" && MERGE_VERB.test(text(action)) && !(REVIEW.test(action.label) && REVIEWER.test(action.label));
}

/** The reviewer a send action asks for, or null when it asks for nobody in particular (or for a bot). */
export function reviewerOf(action: ActionLike): string | null {
  if (action.kind !== "send" || !REVIEW.test(text(action)) || isMergeAction(action)) return null;
  for (const part of [action.label, action.prompt ?? ""]) {
    const match = part.match(REVIEWER);
    const login = match?.[1] ?? match?.[2];
    if (login) return NOT_A_PERSON.test(login) ? null : login;
  }
  return null;
}

const isBotReview = (action: ActionLike) => action.kind === "send" && REVIEW.test(text(action)) && /\bcopilot\b/i.test(text(action));

/**
 * Asks that carry a PR's next move: they get the review buttons. A follow-up that only mentions the PR does not, and
 * neither does a "review" ask about something else on it ("Check the preview of PR #30"): other kinds count only by
 * their actions.
 */
export function isPrMove(ask: Pick<Ask, "kind" | "links">, actions: readonly ActionLike[]): boolean {
  if (!prUrlOf(ask)) return false;
  if (ask.kind === "pr") return true;
  return actions.some((action) => isMergeAction(action) || reviewerOf(action) !== null || isBotReview(action));
}

/**
 * What cannot work among these buttons on a PR that waits for a review, or null when every one can. Only buttons whose
 * click cannot succeed are refused (SPEC-051): a merge the human cannot perform (no admin or ruleset bypass), and a
 * review request to Copilot or the author, whose review never counts toward the required one. Which buttons to offer is
 * the repo's delivery process's call, so none is required. A merge that waits for an approval can work.
 */
export function reviewButtonsProblem(pr: PrReview, actions: readonly ActionLike[]): string | null {
  if (pr.state !== "OPEN" || pr.isDraft || pr.reviewDecision !== "REVIEW_REQUIRED") return null;
  const problems: string[] = [];
  const merge = pr.viewerCanMergeAsAdmin ? undefined : actions.find((action) => isMergeAction(action) && !WAITS_FOR_APPROVAL.test(text(action)));
  if (merge) problems.push(`"${merge.label}" merges a PR that still needs a review, and the human cannot merge past it (viewerCanMergeAsAdmin is false)`);
  const bot = actions.find(isBotReview);
  if (bot) problems.push(`"${bot.label}" asks Copilot, whose review does not count toward the required one`);
  const author = pr.author ? actions.map(reviewerOf).find((login) => login?.toLowerCase() === pr.author!.toLowerCase()) : undefined;
  if (author) problems.push(`${author} wrote the PR and cannot review it`);
  return problems.length ? problems.join("; ") : null;
}

export function reviewButtonsRefusal(pr: PrReview, problem: string): string {
  const author = pr.author ? ` or ${pr.author} (the author)` : "";
  return (
    `PR #${pr.number} is REVIEW_REQUIRED on GitHub: ${problem}. Nothing was saved. ` +
    `Drop the buttons that cannot work. A merge must wait for the approval ("Merge PR #${pr.number} with squash once approved"); a review request names a person, never Copilot${author}.`
  );
}

/** The PR's review decision and who may merge past it, in one GraphQL call. */
export function ghPrReviewOf(run: (args: string[]) => Promise<string>): PrReviewOf {
  return async (url) => {
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) throw new Error(`Not a PR URL: ${url}`);
    const [, owner, name, number] = match;
    const query =
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state isDraft reviewDecision viewerCanMergeAsAdmin author{login}}}}";
    const out = await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]);
    const pr = JSON.parse(out).data?.repository?.pullRequest;
    if (!pr) throw new Error(`No PR at ${url}`);
    return {
      number: pr.number,
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      reviewDecision: pr.reviewDecision || null,
      viewerCanMergeAsAdmin: Boolean(pr.viewerCanMergeAsAdmin),
      author: pr.author?.login ?? null,
    };
  };
}
