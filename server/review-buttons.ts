import { prUrlOf, type Action, type Ask } from "../shared/asks";

/** What decides the buttons of an ask on a PR that waits for its first review. */
export interface PrReview {
  number: number;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  /** True when the human may merge past the review: an admin past branch protection, or a ruleset bypass actor. */
  viewerCanMergeAsAdmin: boolean;
  author: string | null;
  /** Reviews requested and not yet given. */
  reviewRequests: number;
}

export type PrReviewOf = (url: string) => Promise<PrReview>;

type ActionLike = Pick<Action, "kind" | "label" | "prompt">;

/**
 * "Merge" as the verb a clause starts with ("Merge (squash)", "QA, then merge when green", "Rebase and merge"), or
 * `gh pr merge`. Not a word in passing: "Wait for #12 to merge, then start", "Start phase 2 (after merge #12)",
 * "Close it, don't merge it", "Fix merge conflicts".
 */
const MERGE_VERB = /(?:^|[\n.,;:!?(]\s*|\b(?:then|and)\s+)(?:squash[- ]?)?merge\b(?![- ]conflicts?\b)|\bgh pr merge\b/i;
const ADMIN = /--admin\b/;
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

export function isAdminMerge(action: ActionLike): boolean {
  return isMergeAction(action) && ADMIN.test(text(action));
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
 * What is wrong with these buttons for a PR that waits for its first review, or null when they are right. The rule,
 * from #18: one "Request review from <person>" per candidate (2-4, never the author or Copilot), plus "Merge with
 * --admin" exactly when the human can merge past the review. No other Merge. Once a review is requested the PR stays
 * REVIEW_REQUIRED until someone approves, so the ask may then wait for that approval instead of naming reviewers again.
 */
export function reviewButtonsProblem(pr: PrReview, actions: readonly ActionLike[]): string | null {
  if (pr.state !== "OPEN" || pr.isDraft || pr.reviewDecision !== "REVIEW_REQUIRED") return null;
  const problems: string[] = [];
  const requested = pr.reviewRequests > 0;
  const merge = actions.find(
    (action) => isMergeAction(action) && !isAdminMerge(action) && !(requested && WAITS_FOR_APPROVAL.test(text(action))),
  );
  if (merge) {
    const wait = requested ? "; a merge must wait for the requested review's approval" : "";
    problems.push(`"${merge.label}" merges a PR that still needs a review${wait}`);
  }
  const admin = actions.find(isAdminMerge);
  if (admin && !pr.viewerCanMergeAsAdmin) problems.push(`"${admin.label}" is offered, but the human cannot merge past the review (viewerCanMergeAsAdmin is false)`);
  if (!admin && pr.viewerCanMergeAsAdmin) problems.push(`"Merge with --admin" is missing: the human can merge past the review`);
  const bot = actions.find(isBotReview);
  if (bot) problems.push(`"${bot.label}" asks Copilot, whose review does not count toward the required one`);
  const reviewers = actions.map(reviewerOf).filter((login): login is string => login !== null);
  const author = pr.author ? reviewers.find((login) => login.toLowerCase() === pr.author!.toLowerCase()) : undefined;
  if (author) problems.push(`${author} wrote the PR and cannot review it`);
  if (!requested && !reviewers.some((login) => login !== author)) problems.push("no action requests a review from a person");
  return problems.length ? problems.join("; ") : null;
}

export function reviewButtonsRefusal(pr: PrReview, problem: string): string {
  const admin = pr.viewerCanMergeAsAdmin ? ` plus a send action "Merge with --admin" (prompt "Merge PR #${pr.number} with --admin")` : "";
  const author = pr.author ? `, never ${pr.author} (the author)` : "";
  if (pr.reviewRequests > 0) {
    return (
      `PR #${pr.number} is REVIEW_REQUIRED on GitHub, with a review already requested: ${problem}. Nothing was saved. ` +
      `Offer a merge that waits for the approval ("Merge PR #${pr.number} with squash once approved")${admin}, or more reviewers as "Request review from <login>"; never Copilot${author}.`
    );
  }
  return (
    `PR #${pr.number} is REVIEW_REQUIRED on GitHub: ${problem}. Nothing was saved. ` +
    `Offer one send action per candidate reviewer, 2-4 of them, labelled "Request review from <login>" with the prompt "Request review on PR #${pr.number} from <login>", one marked recommended${admin}. ` +
    `Candidates are people: CODEOWNERS, then recent reviewers (gh pr list --state merged -L 20 --json reviews), then collaborators; never Copilot${author}. Fewer than 2 only if fewer exist.`
  );
}

/** The PR's review decision and who may merge past it, in one GraphQL call. */
export function ghPrReviewOf(run: (args: string[]) => Promise<string>): PrReviewOf {
  return async (url) => {
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) throw new Error(`Not a PR URL: ${url}`);
    const [, owner, name, number] = match;
    const query =
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number state isDraft reviewDecision viewerCanMergeAsAdmin author{login} reviewRequests{totalCount}}}}";
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
      reviewRequests: pr.reviewRequests?.totalCount ?? 0,
    };
  };
}
