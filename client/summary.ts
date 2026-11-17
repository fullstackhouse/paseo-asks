import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { AskEntry, WorkspaceAsks } from "../shared/asks";

// COMPAT(workspaceSummaryItem): FSH hosts from fullstackhouse/paseo#83 have addWorkspaceSummaryItem, and FSH hosts
// with Overview v2 read `entries`, but the npm SDK pin types neither yet. Older hosts lack the item (Asks then only
// shows its pills) or drop `entries`.
export interface WorkspaceSummaryState {
  label?: string;
  count?: number;
  needsYou?: boolean;
  key?: string;
  panelId?: string;
  /** Things in this workspace that wait on the human, one Overview row each (the host shows up to 5). */
  entries?: AskEntry[];
}
export interface WorkspaceSummaryRegistration {
  update(patch: WorkspaceSummaryState): void;
  remove(): void;
}
type SummaryHost = {
  addWorkspaceSummaryItem?: (
    contribution: WorkspaceSummaryState & { id: string; workspaceId: string; title: string },
  ) => WorkspaceSummaryRegistration;
};

/** The summary item for a workspace's asks; nothing waiting reads 0, not absent. */
export function summaryState(asks: WorkspaceAsks | undefined): WorkspaceSummaryState {
  const count = asks?.count ?? 0;
  return {
    label: count > 0 ? `${count} waiting on you` : "Nothing waiting",
    count,
    needsYou: count > 0,
    key: asks?.newestId,
    panelId: "asks",
    entries: asks?.entries ?? [],
  };
}

/** Tells the host what waits in each workspace, so entering one can open the Asks panel and Overview can list the asks. */
export function createWorkspaceSummaries(client: PluginClientContext) {
  const host = client as PluginClientContext & SummaryHost;
  const items = new Map<string, WorkspaceSummaryRegistration>();
  return {
    set(workspaceId: string, asks: WorkspaceAsks | undefined) {
      if (!host.addWorkspaceSummaryItem) return;
      const state = summaryState(asks);
      const item = items.get(workspaceId);
      if (item) item.update(state);
      else items.set(workspaceId, host.addWorkspaceSummaryItem({ id: "asks", workspaceId, title: "Asks", ...state }));
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
