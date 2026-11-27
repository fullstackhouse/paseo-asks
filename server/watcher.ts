import { OPEN_STATUSES, prUrlOf, type Ask, type PrState } from "../shared/asks";
import { RateLimited } from "./gh";
import { changesNewlyRequested, describePrChange, PrReadsPaused, PrReadsUnavailable, watchedAsks, type FetchPrs } from "./github";
import type { AsksService } from "./service";
import type { AskStore } from "./store";

/** Keeps each open PR ask's `pr` snapshot fresh and tells subscribed owners what changed. */
export class PrWatcher {
  private running: Promise<void> = Promise.resolve();
  /** The host pause last logged, so a pause is logged once however many passes hit it. */
  private loggedPause: number | undefined | null = null;

  constructor(
    private readonly store: AskStore,
    private readonly service: AsksService,
    private readonly fetchPrs: FetchPrs,
    /** False when the human wants requested changes held as an ask rather than sent to the agent. */
    private readonly actOnReviewChanges: () => Promise<boolean> = async () => true,
    /** Ids of the workspaces that are not archived; null while the daemon can't be asked. */
    private readonly liveWorkspaces: () => Promise<ReadonlySet<string> | null> = async () => null,
    /** After a full pass: the PRs still watched, so the feed stops following the rest. */
    private readonly retain: (urls: string[]) => Promise<void> = async () => undefined,
  ) {}

  refresh(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    this.running = this.running.then(() => this.refreshNow(only)).catch((error) => {
      console.error("[asks] PR refresh failed", error);
    });
    return this.running;
  }

  private async refreshNow(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    const watched = watchedAsks(this.store.list(only?.workspaceId)).filter((ask) => !only || ask.id === only.id);
    if (!watched.length) {
      if (!only) await this.retain([]);
      return;
    }
    // An archived workspace's asks are out of the human's queue, so their PRs would only spend the GitHub quota.
    // A restored workspace is followed again on the next pass. A single ask comes from a tool call, made in a visible
    // workspace. When the daemon can't list workspaces, the pass polls them all rather than none.
    const live = only
      ? null
      : await this.liveWorkspaces().catch((error) => {
          console.error("[asks] could not list workspaces; polling all PR asks", error);
          return null;
        });
    const asks = live ? watched.filter((ask) => live.has(ask.workspaceId)) : watched;
    if (!only) await this.retain([...new Set(asks.map((ask) => prUrlOf(ask)!))]);
    if (!asks.length) return;
    const actOnReviews = await this.actOnReviewChanges();
    // Several asks often link one PR; each pass reads every PR once, in one host read.
    const urls = [...new Set(asks.map((ask) => prUrlOf(ask)!))];
    const snapshots = new Map<string, PrState>();
    for (const ask of asks) {
      if (ask.pr && ask.pr.url === prUrlOf(ask) && !snapshots.has(ask.pr.url)) snapshots.set(ask.pr.url, ask.pr);
    }
    let fetched: Map<string, PrState | Error>;
    try {
      fetched = await this.fetchPrs(urls, snapshots);
    } catch (error) {
      // The whole pass failed the same way; the next one after the reset picks it up.
      if (error instanceof RateLimited || error instanceof PrReadsUnavailable) return;
      if (error instanceof PrReadsPaused) {
        if (this.loggedPause !== error.retryAt) console.error(`[asks] ${error.message}; keeping the last PR snapshots`);
        this.loggedPause = error.retryAt;
        return;
      }
      console.error("[asks] PR refresh failed", error instanceof Error ? error.message : error);
      return;
    }
    for (const [url, result] of fetched) {
      if (result instanceof Error) console.error(`[asks] PR read failed for ${url}`, result.message);
    }
    for (const ask of asks) {
      const url = prUrlOf(ask)!;
      const result = fetched.get(url);
      if (!result || result instanceof Error) continue;
      let pr = result;
      // Held whenever changes are requested, not only on the change into it: the setting may have been turned off
      // afterwards, and agents told to wait for the Address ask must get one.
      const holdReview = !actOnReviews && pr.reviewDecision === "CHANGES_REQUESTED";
      // A relinked ask's snapshot belongs to its old PR: comparing would report e.g. a merged PR as reopened.
      const previous = ask.pr?.url === pr.url ? ask.pr : undefined;
      // A failed deployments lookup keeps the last known ones rather than blanking them until the next poll.
      if (!pr.deployments && previous?.deployments) pr = { ...pr, deployments: previous.deployments };
      const change = previous ? describePrChange(previous, pr, { review: !holdReview }) : null;
      const current = this.store.get(ask.workspaceId, ask.id);
      if (!current) continue;
      await this.store.update(ask.workspaceId, ask.id, { pr }, { touch: false });
      // The human may have closed the ask while the PR was read.
      if (!current.subscribe || current.orphaned || !OPEN_STATUSES.includes(current.status)) continue;
      if (change) this.service.notify(current, `[asks] ${current.id} (${current.title}) ${change}.`);
      if (holdReview) await this.service.raiseReview(current, pr, { newRound: previous !== undefined && changesNewlyRequested(previous, pr) });
    }
  }
}
