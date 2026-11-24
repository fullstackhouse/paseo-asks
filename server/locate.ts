import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { askCardFor } from "../shared/timeline";
import type { TimelinePosition } from "../shared/asks";

type TimelineSource = Pick<PaseoAgentTimelineHandle, "refetch">;

const PAGE_SIZE = 200;
// Long-lived agents run to thousands of entries; give up rather than page through all of them.
const MAX_PAGES = 25;

/**
 * Where the agent's latest ask_create or ask_update call for `askId` sits in its timeline, or null when it is not
 * there (another agent raised it, or the call is older than the pages read). `seq` is the projected entry's `seqStart`,
 * which the host's `navigation.openAgent({ timelinePosition })` scrolls to.
 */
export async function findAskCall(timeline: TimelineSource, askId: string): Promise<TimelinePosition | null> {
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "projected" });
  for (let read = 1; ; read++) {
    for (let index = page.entries.length - 1; index >= 0; index--) {
      const { item, seqStart } = page.entries[index]!;
      if (item.type !== "tool_call") continue;
      const card = askCardFor(item);
      if (card?.askId === askId && card.verb !== "resolve") return { epoch: page.epoch, seq: seqStart };
    }
    if (read >= MAX_PAGES || !page.hasOlder || !page.startCursor) return null;
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: PAGE_SIZE,
      projection: "projected",
    });
  }
}
