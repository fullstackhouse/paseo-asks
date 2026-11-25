import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import type { AskEntry, InProgressEntry, WorkspaceAsks } from "../shared/asks";

// COMPAT(workspaceSummaryItem): FSH hosts from fullstackhouse/paseo#83 have addWorkspaceSummaryItem, and FSH hosts
// with Overview v2 read `entries`, but the npm SDK pin types neither yet. Older hosts lack the item (Asks then only
// shows its pills) or drop `entries`. Overview v2 hosts also render each entry with `EntryComponent`.
// COMPAT(workspaceInProgress): FSH hosts with Overview In progress read `inProgress` and pass `nothingMoving`; the npm
// SDK pin types neither, and older hosts ignore both.
export interface WorkspaceSummaryState {
  label?: string;
  count?: number;
  needsYou?: boolean;
  key?: string;
  panelId?: string;
  /** Things in this workspace that wait on the human, one Overview row each. */
  entries?: AskEntry[];
  /** Asks this workspace's agents hold in progress, one In progress row each; empty when there are none. */
  inProgress?: InProgressEntry[];
}
export interface WorkspaceSummaryRegistration {
  update(patch: WorkspaceSummaryState): void;
  remove(): void;
}
/** What an Overview v2 host passes to `EntryComponent` for one of `entries`. */
export interface SummaryEntryProps
  extends Pick<PluginWorkspacePanelProps, "theme" | "host" | "layout" | "navigation" | "workspaceId"> {
  entryId: string;
  /** True for the Overview's first move: show it open, with its actions. */
  defaultExpanded: boolean;
  /** Set by hosts that keep one entry open at a time; toggles go to `onExpandedChange`. */
  expanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
  /** For one of `inProgress`: its owner runs no turn, nothing else will report back, and it sat over ten minutes. */
  nothingMoving?: boolean;
}
type SummaryHost = {
  addWorkspaceSummaryItem?: (
    contribution: WorkspaceSummaryState & {
      id: string;
      workspaceId: string;
      title: string;
      EntryComponent?: ComponentType<SummaryEntryProps>;
    },
  ) => WorkspaceSummaryRegistration;
};

/** The summary item for a workspace's asks; nothing waiting reads 0, not absent. Asks in progress list even when snoozed. */
export function summaryState(asks: WorkspaceAsks | undefined): WorkspaceSummaryState {
  const count = asks?.count ?? 0;
  return {
    label: count > 0 ? `${count} waiting on you` : "Nothing waiting",
    count,
    needsYou: count > 0,
    key: asks?.newestId,
    panelId: "asks",
    entries: asks?.entries ?? [],
    inProgress: asks?.inProgress ?? [],
  };
}

/** Tells the host what waits in each workspace, so entering one can open the Asks panel and Overview can list the asks. */
export function createWorkspaceSummaries(
  client: PluginClientContext,
  EntryComponent: ComponentType<SummaryEntryProps>,
) {
  const host = client as PluginClientContext & SummaryHost;
  const items = new Map<string, WorkspaceSummaryRegistration>();
  return {
    set(workspaceId: string, asks: WorkspaceAsks | undefined) {
      if (!host.addWorkspaceSummaryItem) return;
      const state = summaryState(asks);
      const item = items.get(workspaceId);
      if (item) item.update(state);
      else items.set(workspaceId, host.addWorkspaceSummaryItem({ id: "asks", workspaceId, title: "Asks", EntryComponent, ...state }));
    },
    workspaceIds(): string[] {
      return [...items.keys()];
    },
    clear() {
      for (const item of items.values()) item.remove();
      items.clear();
    },
  };
}
