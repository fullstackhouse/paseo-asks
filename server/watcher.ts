import { prUrlOf, type Ask } from "../shared/asks";
import { describePrChange, watchedAsks, type FetchPr } from "./github";
import type { AsksService } from "./service";
import type { AskStore } from "./store";

/** Keeps each open PR ask's `pr` snapshot fresh and tells subscribed owners what changed. */
export class PrWatcher {
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AskStore,
    private readonly service: AsksService,
    private readonly fetchPr: FetchPr,
  ) {}

  refresh(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    this.running = this.running.then(() => this.refreshNow(only)).catch((error) => {
      console.error("[asks] PR refresh failed", error);
    });
    return this.running;
  }

  private async refreshNow(only?: Pick<Ask, "workspaceId" | "id">): Promise<void> {
    const asks = watchedAsks(this.store.list(only?.workspaceId)).filter((ask) => !only || ask.id === only.id);
    for (const ask of asks) {
      let pr;
      try {
        pr = await this.fetchPr(prUrlOf(ask)!);
      } catch (error) {
        console.error(`[asks] gh pr view failed for ${ask.workspaceId}/${ask.id}`, error instanceof Error ? error.message : error);
        continue;
      }
      const change = ask.pr ? describePrChange(ask.pr, pr) : null;
      const current = this.store.get(ask.workspaceId, ask.id);
      if (!current) continue;
      await this.store.update(ask.workspaceId, ask.id, { pr }, { touch: false });
      if (change && current.subscribe && !current.orphaned) {
        this.service.notify(current, `[asks] ${current.id} (${current.title}) ${change}.`);
      }
    }
  }
}
