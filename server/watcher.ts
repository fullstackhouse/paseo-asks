import { prUrlOf, type Ask } from "../shared/asks";
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
  ) {}

  refresh(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    this.running = this.running.then(() => this.refreshNow(only)).catch((error) => {
      console.error("[asks] PR refresh failed", error);
    });
    return this.running;
  }

  private async refreshNow(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    const asks = watchedAsks(this.store.list(only?.workspaceId)).filter((ask) => !only || ask.id === only.id);
    if (!asks.length) return;
    const actOnReviews = await this.actOnReviewChanges();
    for (const ask of asks) {
      let pr;
      try {
        pr = await this.fetchPr(prUrlOf(ask)!);
      } catch (error) {
        console.error(`[asks] gh pr view failed for ${ask.workspaceId}/${ask.id}`, error instanceof Error ? error.message : error);
        continue;
      }
      const holdReview = !actOnReviews && ask.pr !== undefined && changesNewlyRequested(ask.pr, pr);
      const change = ask.pr ? describePrChange(ask.pr, pr, { review: !holdReview }) : null;
      const current = this.store.get(ask.workspaceId, ask.id);
      if (!current) continue;
      await this.store.update(ask.workspaceId, ask.id, { pr }, { touch: false });
      if (!current.subscribe || current.orphaned) continue;
      if (change) this.service.notify(current, `[asks] ${current.id} (${current.title}) ${change}.`);
      if (holdReview) await this.service.raiseReview(current, pr);
    }
  }
}
