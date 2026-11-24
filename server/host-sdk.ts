import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent } from "@getpaseo/plugin/server";

// COMPAT(hostLatestTurn): FSH hosts since fullstackhouse/paseo 0bd77c5 supply latestTurn at runtime, but the npm SDK
// has no type for it until getpaseo/paseo#9307 ships. Delete this file when the SDK pin includes it.
declare module "@getpaseo/plugin/server" {
  /** The last user message and everything after it; turn hooks carry no history. */
  export function latestTurn(timeline: Pick<PaseoAgentTimelineHandle, "refetch">): Promise<AgentTimelineItem[]>;
}

// COMPAT(scheduleRunAttention): FSH hosts from fullstackhouse/paseo#106 run this hook and advertise
// `features.scheduleRunAttention`; older hosts reject the name at registration. Not in the npm SDK.
declare module "@getpaseo/plugin/internal/lifecycle" {
  interface PluginScheduleRunFinishRequest {
    readonly schedule: { readonly id: string; readonly name: string | null };
    readonly runId: string;
    readonly agent: PluginHookAgent;
    attention: { reason: "failed" | "permission" | "plugin"; message: string | null } | null;
  }
  interface PluginHookRequests {
    "schedule.run.finish.before": PluginScheduleRunFinishRequest;
  }
}

// COMPAT(pluginNotifications): FSH hosts supply `paseo.notifications`; the npm client has no type for it.
declare module "@getpaseo/client" {
  interface PaseoApi {
    readonly notifications: {
      send(input: {
        title: string;
        body: string;
        open?: { screen: string; params?: Record<string, string> } | { agentId: string };
        key?: string;
      }): Promise<{ delivered: boolean; dropped?: string }>;
    };
  }
}

// COMPAT(providerSubagents): FSH hosts from fullstackhouse/paseo#101 supply these on agent handles; the npm client has
// no type for them. Optional: older hosts lack them.
declare module "@getpaseo/client" {
  interface PaseoAgentHandle {
    readonly providerSubagents?: { list(): Promise<{ status: string }[]> };
    readonly backgroundWork?: { list(): Promise<{ kind: string }[]> };
  }
}
