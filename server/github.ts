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

/**
 * Each URL's PR state for one pass, read together. `previous` is each URL's last snapshot, so unchanged deployments can be
 * kept. A failure of the whole pass (a host pause, no host) throws; one PR's failure is its Error in the map.
 */
export type FetchPrs = (urls: readonly string[], previous: ReadonlyMap<string, PrState>) => Promise<Map<string, PrState | Error>>;

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

/** Deployments are looked up again at least this often while nothing else says they changed. */
export const DEPLOYMENTS_RECHECK_MS = 10 * 60_000;

/**
 * Whether a PR's deployments need a `gh` lookup this pass. Deployments belong to the head commit: a new commit, a
 * deployment still running, or checks still running (deploys often start with them) can change them; otherwise the last
 * lookup stands for `DEPLOYMENTS_RECHECK_MS`. Merged and closed PRs keep what they had.
 */
export function needsDeploymentsLookup(read: Extract<HostChangeRequestRead, { ok: true }>, previous: PrState | undefined, now: number): boolean {
  if (read.state !== "open") return false;
  if (!previous?.deployments || !previous.deploymentsAt || previous.headSha !== read.headSha) return true;
  if (read.checksState === "pending" || previous.deployments.some((deployment) => deployment.state === "deploying")) return true;
  return now - Date.parse(previous.deploymentsAt) >= DEPLOYMENTS_RECHECK_MS;
}

/**
 * PR state from the host, all of a pass's PRs in one read (the host batches, rate-limits and caches it for every
 * plugin); deployments still come from `gh` (the host doesn't read them), only when `needsDeploymentsLookup` says so.
 * Without `gh` the snapshot has no deployments.
 */
export function hostFetcher(readPrs: ReadPrs, gh: Gh | null, now: () => number = Date.now): FetchPrs {
  return async (urls, previous) => {
    const reads = urls.length ? await readPrs([...urls]) : [];
    const paused = reads.find((read) => !read.ok && read.reason === "paused");
    if (paused && !paused.ok) throw new PrReadsPaused(paused.retryAt);
    const results = new Map<string, PrState | Error>();
    await Promise.all(
      urls.map(async (url, index) => {
        const read = reads[index];
        if (!read) return void results.set(url, new PrReadFailed("the host returned no result"));
        if (!read.ok) return void results.set(url, new PrReadFailed(read.error));
        const before = previous.get(url);
        const at = now();
        const state: PrState = { ...prStateOf(read, new Date(at)), headSha: read.headSha };
        if (!gh || !needsDeploymentsLookup(read, before, at)) {
          // The last lookup still describes this head commit; a different commit's deployments are dropped.
          const kept = before?.headSha === read.headSha ? before : undefined;
          return void results.set(url, kept?.deployments ? { ...state, deployments: kept.deployments, deploymentsAt: kept.deploymentsAt } : state);
        }
        // Deployments are extra: a failed lookup leaves them unset, not the PR line broken.
        const deployments = await fetchDeployments(gh, url).catch((error): Deployment[] | undefined => {
          if (!(error instanceof RateLimited)) {
            console.error(`[asks] deployments lookup failed for ${url}`, error instanceof Error ? error.message : error);
          }
          return undefined;
        });
        results.set(url, deployments ? { ...state, deployments, deploymentsAt: new Date(at).toISOString() } : state);
      }),
    );
    return results;
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
