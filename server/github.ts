import { existsSync } from "node:fs";
import { OPEN_STATUSES, prUrlOf, type Ask, type Deployment, type PrState } from "../shared/asks";
import { fetchDeployments } from "./deployments";
import { RateLimited, type Gh } from "./gh";
import type { HostChangeRequestRead } from "./host-sdk";

// The daemon is often launched from the Dock with a bare PATH, so look where gh usually lives.
const GH_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export function findGh(): string | null {
  return GH_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export type FetchPr = (url: string) => Promise<PrState>;

/** `paseo.changeRequests.read` (typed in `host-sdk.ts`). */
export type ReadPrs = (urls: string[]) => Promise<HostChangeRequestRead[]>;

/** The host reports its own failure for this URL, such as a forge it can't read. */
export class PrReadFailed extends Error {}

/** No PR can be read this pass: no daemon session yet, or a host older than `changeRequests.read`. */
export class PrReadsUnavailable extends Error {}

/**
 * The host holds GitHub reads to stay under the rate limit until `retryAt`. The pause covers every PR, so the pass
 * stops and each ask keeps its last snapshot.
 */
export class PrReadsPaused extends Error {
  constructor(readonly retryAt: number | undefined) {
    super(`Paseo paused GitHub reads${retryAt ? ` until ${new Date(retryAt).toISOString()}` : ""}`);
  }
}

const REVIEW_DECISIONS = { approved: "APPROVED", changes_requested: "CHANGES_REQUESTED", review_required: "REVIEW_REQUIRED" } as const;
const MERGEABLE = { mergeable: "MERGEABLE", conflicting: "CONFLICTING", unknown: "UNKNOWN" } as const;

/** The host's read in the shape asks stores, minus deployments. */
export function prStateOf(read: Extract<HostChangeRequestRead, { ok: true }>, fetchedAt = new Date()): PrState {
  return {
    number: read.number,
    url: read.url,
    state: read.state === "merged" ? "MERGED" : read.state === "closed" ? "CLOSED" : "OPEN",
    isDraft: read.isDraft,
    reviewDecision: read.reviewDecision ? REVIEW_DECISIONS[read.reviewDecision] : null,
    mergeable: MERGEABLE[read.mergeable ?? "unknown"],
    checks: read.checksState,
    fetchedAt: fetchedAt.toISOString(),
  };
}

/**
 * PR state from the host, which batches, rate-limits and caches reads for every plugin; deployments still come from
 * `gh` (the host doesn't read them). Without `gh` the snapshot has no deployments.
 */
export function hostFetcher(readPrs: ReadPrs, gh: Gh | null): FetchPr {
  return async (url) => {
    // Deployments are extra: a failed lookup leaves them unset, not the PR line broken.
    const deployments = gh
      ? fetchDeployments(gh, url).catch((error): Deployment[] | undefined => {
          if (!(error instanceof RateLimited)) {
            console.error(`[asks] deployments lookup failed for ${url}`, error instanceof Error ? error.message : error);
          }
          return undefined;
        })
      : Promise.resolve(undefined);
    const [read] = await readPrs([url]);
    if (!read) throw new PrReadFailed("the host returned no result");
    if (!read.ok) throw read.reason === "paused" ? new PrReadsPaused(read.retryAt) : new PrReadFailed(read.error);
    return { ...prStateOf(read), deployments: await deployments };
  };
}

/** What changed between two snapshots, in words an agent can act on; null when nothing it cares about did. */
export function describePrChange(before: PrState, after: PrState, { review = true } = {}): string | null {
  const changes: string[] = [];
  if (before.state !== after.state) changes.push(after.state === "MERGED" ? "merged" : after.state === "CLOSED" ? "closed without merging" : "reopened");
  if (before.checks !== after.checks && (after.checks === "failing" || after.checks === "passing")) changes.push(`checks ${after.checks}`);
  for (const deployment of after.deployments ?? []) {
    if (deployment.state !== "ready" || !before.deployments) continue;
    const was = before.deployments.find((entry) => entry.url === deployment.url);
    if (was?.state !== "ready") changes.push(`preview ready: ${deployment.url}`);
  }
  if (review && before.reviewDecision !== after.reviewDecision && after.reviewDecision) {
    const decision = `review: ${after.reviewDecision.toLowerCase().replace(/_/g, " ")}`;
    // An approval often carries comments; agents told only "approved" offered Merge without reading them.
    const unread = after.reviewDecision === "APPROVED" && after.state === "OPEN";
    changes.push(unread ? `${decision} (read the review body and comments before offering Merge)` : decision);
  }
  return changes.length ? `PR #${after.number} ${changes.join(", ")}` : null;
}

export function changesNewlyRequested(before: PrState, after: PrState): boolean {
  return before.reviewDecision !== "CHANGES_REQUESTED" && after.reviewDecision === "CHANGES_REQUESTED";
}

export function watchedAsks(asks: readonly Ask[]): Ask[] {
  return asks.filter((ask) => {
    const url = prUrlOf(ask);
    if (!url || !OPEN_STATUSES.includes(ask.status)) return false;
    // A held review's ask links the same PR as the PR ask it came from, so polling it would only repeat that call.
    if (ask.heldReview) return false;
    // A merged PR never changes again. Agents leave merged PR asks open by the hundred, and polling them spent the
    // GitHub quota every other gh user on the machine shares. A relinked ask's snapshot is its old PR, so it still polls.
    return !(ask.pr?.state === "MERGED" && ask.pr.url === url);
  });
}
