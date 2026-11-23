import { mergeBlockedBy, OPEN_STATUSES, prUrlOf, visibleActions, type Ask, type PrState } from "../shared/asks";
import { RateLimited } from "./gh";
import { changesNewlyRequested, describePrChange, watchedAsks, type FetchPr } from "./github";
import type { AsksService } from "./service";
import type { AskStore } from "./store";

/** Keeps each open PR ask's `pr` snapshot fresh and tells subscribed owners what changed. */
export class PrWatcher {
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AskStore,
    private readonly service: AsksService,
    private readonly fetchPr: FetchPr,
    /** False when the human wants requested changes held as an ask rather than sent to the agent. */
    private readonly actOnReviewChanges: () => Promise<boolean> = async () => true,
    /** Ids of the workspaces that are not archived; null while the daemon can't be asked. */
    private readonly liveWorkspaces: () => Promise<ReadonlySet<string> | null> = async () => null,
  ) {}

  refresh(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    this.running = this.running.then(() => this.refreshNow(only)).catch((error) => {
      console.error("[asks] PR refresh failed", error);
    });
    return this.running;
  }

  private async refreshNow(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    const watched = watchedAsks(this.store.list(only?.workspaceId)).filter((ask) => !only || ask.id === only.id);
    if (!watched.length) return;
    // An archived workspace's asks are out of the human's queue, so their PRs would only spend the GitHub quota.
    // A restored workspace is polled again on the next pass. A single ask comes from a tool call, made in a visible
    // workspace. When the daemon can't list workspaces, the pass polls them all rather than none.
    const live = only
      ? null
      : await this.liveWorkspaces().catch((error) => {
          console.error("[asks] could not list workspaces; polling all PR asks", error);
          return null;
        });
    const asks = live ? watched.filter((ask) => live.has(ask.workspaceId)) : watched;
    if (!asks.length) return;
    const actOnReviews = await this.actOnReviewChanges();
    // Several asks often link one PR; each pass reads it once.
    const fetched = new Map<string, PrState | null>();
    for (const ask of asks) {
      const url = prUrlOf(ask)!;
      if (!fetched.has(url)) {
        try {
          fetched.set(url, await this.fetchPr(url));
        } catch (error) {
          // The rest of the pass would fail the same way; the next one after the reset picks it up.
          if (error instanceof RateLimited) return;
          console.error(`[asks] gh pr view failed for ${url}`, error instanceof Error ? error.message : error);
          fetched.set(url, null);
        }
      }
      let pr = fetched.get(url);
      if (pr == null) continue;
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
      // The card hides a Merge action this snapshot rules out, so the owner must re-offer: told once per decision, even
      // unsubscribed, since the plugin took the button away. Covers asks that got through a failed gh read and asks
      // from before the check. Held changes are the Address ask's business, so the agent is not told about those.
      const blocked = mergeBlockedBy(pr);
      const hides = blocked !== null && visibleActions({ ...current, pr }).length < current.actions.length;
      // The human may have closed the ask while gh was running.
      const live = !current.orphaned && OPEN_STATUSES.includes(current.status);
      const tell = hides && live && !holdReview && current.mergeHiddenNotice !== blocked;
      const notice = tell ? blocked : hides ? current.mergeHiddenNotice : undefined;
      await this.store.update(ask.workspaceId, ask.id, { pr, mergeHiddenNotice: notice }, { touch: false });
      if (!live) continue;
      const reoffer = tell
        ? `Its Merge action is hidden while the PR is ${blocked.toLowerCase().replace(/_/g, " ")}: ask_update ${current.id} with what the human does now (reviewer choices, or a re-request once you have addressed the changes).`
        : "";
      if (current.subscribe && change) this.service.notify(current, `[asks] ${current.id} (${current.title}) ${change}.${reoffer ? ` ${reoffer}` : ""}`);
      else if (reoffer) this.service.notify(current, `[asks] ${current.id} (${current.title}) PR #${pr.number}: ${reoffer}`);
      if (!current.subscribe) continue;
      if (holdReview) await this.service.raiseReview(current, pr, { newRound: previous !== undefined && changesNewlyRequested(previous, pr) });
    }
  }
}
