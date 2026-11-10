import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

// COMPAT(hostLatestTurn): FSH hosts since fullstackhouse/paseo 0bd77c5 supply latestTurn at runtime, but the npm SDK
// has no type for it until getpaseo/paseo#9307 ships. Delete this file when the SDK pin includes it.
declare module "@getpaseo/plugin/server" {
  /** The last user message and everything after it; turn hooks carry no history. */
  export function latestTurn(timeline: Pick<PaseoAgentTimelineHandle, "refetch">): Promise<AgentTimelineItem[]>;
}
