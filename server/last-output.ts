import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoAgentTimelineHandle, PaseoAgentTimelineRefetchOptions } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

const MAX_CHARS = 8000;

/** Each agent's latest reply, so a side chat can start with the context the human just read. */
export class LastOutputs {
  private readonly path: string;
  private readonly byAgent: Record<string, string>;

  constructor(root: string) {
    this.path = join(root, "last-output.json");
    this.byAgent = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }

  get(agentId: string): string | undefined {
    return this.byAgent[agentId];
  }

  record(agentId: string, timeline: readonly AgentTimelineItem[]): void {
    const text = latestReply(timeline);
    if (!text || this.byAgent[agentId] === text) return;
    this.byAgent[agentId] = text;
    writeFileSync(this.path, JSON.stringify(this.byAgent));
  }
}

/** The assistant text after the last user message; streamed replies arrive as several items. */
export function latestReply(timeline: readonly AgentTimelineItem[]): string {
  const parts: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message") break;
    if (item.type === "assistant_message") parts.unshift(item.text);
  }
  return parts.join("").trim().slice(-MAX_CHARS);
}

type TimelinePage = Pick<
  Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>,
  "hasOlder" | "startCursor"
> & { entries: { item: AgentTimelineItem }[] };

/** Turn hooks no longer include history; read back only as far as the latest user message. */
export async function latestTurn(source: {
  refetch(options: PaseoAgentTimelineRefetchOptions): Promise<TimelinePage>;
}): Promise<AgentTimelineItem[]> {
  const items: AgentTimelineItem[] = [];
  let page = await source.refetch({ direction: "tail", limit: 50 });
  for (;;) {
    items.unshift(...page.entries.map((entry) => entry.item));
    const boundary = items.findLastIndex((item) => item.type === "user_message");
    if (boundary >= 0) return items.slice(boundary);
    if (!page.hasOlder || !page.startCursor) return items;
    page = await source.refetch({ direction: "before", cursor: page.startCursor, limit: 50 });
  }
}
