import type { PluginClientContext } from "@getpaseo/plugin/client";

// COMPAT(workspaceSummaryItem): FSH hosts from fullstackhouse/paseo#83 have addWorkspaceSummaryItem, but the npm SDK
// pin doesn't type it yet. Older hosts lack it; Asks then only shows its pills.
export interface WorkspaceSummaryState {
  label?: string;
  count?: number;
  needsYou?: boolean;
  key?: string;
  panelId?: string;
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

/** Tells the host how many asks wait in each workspace, so entering one can open the Asks panel. */
export function createWorkspaceSummaries(client: PluginClientContext) {
  const host = client as PluginClientContext & SummaryHost;
  const items = new Map<string, WorkspaceSummaryRegistration>();
  return {
    set(workspaceId: string, waiting: { count: number; newestId: string } | undefined) {
      if (!host.addWorkspaceSummaryItem) return;
      const state: WorkspaceSummaryState = {
        label: waiting ? `${waiting.count} waiting on you` : "Nothing waiting",
        count: waiting?.count ?? 0,
        needsYou: Boolean(waiting),
        key: waiting?.newestId,
        panelId: "asks",
      };
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
