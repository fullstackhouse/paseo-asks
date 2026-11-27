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

/** One deployment of the PR's head commit, with GitHub's raw state. Mirrors fullstackhouse/paseo#285's protocol. */
export interface HostDeployment {
  environment: string | null;
  state: string | null;
  createdAt: string;
  url?: string;
  logUrl?: string;
}

/** One pull request as the host reads it. Mirrors `ChangeRequestRead` in fullstackhouse/paseo's protocol. */
export type HostChangeRequestRead =
  | {
      url: string;
      ok: true;
      number: number;
      title: string;
      state: "open" | "merged" | "closed";
      isDraft: boolean;
      mergeable?: "mergeable" | "conflicting" | "unknown";
      reviewDecision: "approved" | "changes_requested" | "review_required" | null;
      checksState: "passing" | "failing" | "pending" | "none";
      checks: { name: string; state: "passing" | "failing" | "pending" | "skipped"; url?: string }[];
      headSha: string;
      /** From fullstackhouse/paseo#285; absent before. */
      author?: string | null;
      reviewRequestCount?: number;
      viewerCanMergeAsAdmin?: boolean;
      /** Only for subscriptions that include "deployments"; newest first. */
      deployments?: HostDeployment[];
    }
  | {
      url: string;
      ok: false;
      error: string;
      /** Missing on the first #270 builds; read it as "error". */
      reason?: "paused" | "not_found" | "unsupported" | "error";
      /** For "paused": when the host reads again, epoch ms. */
      retryAt?: number;
    };

/** What a subscription follows. Mirrors `ChangeRequestSubscriptionTarget` (fullstackhouse/paseo#285). */
export interface HostSubscriptionTarget {
  urls?: string[];
  branches?: { repo: string; headRef: string; includeClosed?: boolean }[];
  priority?: "visible" | "background";
  include?: "deployments"[];
}

/** Every result at subscribe time, then only what changed. */
export interface HostSubscriptionUpdate {
  results: HostChangeRequestRead[];
  branches: unknown[];
}

export interface HostSubscription {
  initial: HostSubscriptionUpdate;
  unsubscribe(): Promise<void>;
}

// COMPAT(changeRequestsRead): FSH hosts from fullstackhouse/paseo#270 read PR state for plugins, and from #285
// (COMPAT(changeRequestSubscriptions)) follow PRs with pushed updates. The npm client has no type for either; the plugin
// runs on the host's SDK, so a method is there exactly when the daemon serves it.
declare module "@getpaseo/client" {
  interface PaseoApi {
    readonly changeRequests?: {
      read(urls: string[]): Promise<HostChangeRequestRead[]>;
      subscribe?(target: HostSubscriptionTarget, onUpdate: (update: HostSubscriptionUpdate) => void): Promise<HostSubscription>;
    };
  }
}
