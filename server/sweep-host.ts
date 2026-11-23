import type { PaseoApi } from "@getpaseo/client";
import type { SweepHost } from "./service";
import { isCleanWorktree } from "./worktree";

/** Workspace states where nothing is going on: every agent finished (or failed) and none waits on the human. */
const IDLE = new Set(["done", "failed"]);

/** The daemon behind the discussion sweep. Its workspace status sums up every agent in the workspace. */
export function sweepHost(api: Pick<PaseoApi, "workspaces">, log: (line: string) => void): SweepHost {
  return {
    async workspace(workspaceId) {
      const handle = api.workspaces.ref(workspaceId);
      const workspace = await handle.refresh();
      if (!workspace || workspace.archivingAt) return null;
      const terminals = await handle.terminals.list();
      return {
        idle: IDLE.has(workspace.status) && terminals.entries.length === 0,
        lastActiveAt: workspace.statusEnteredAt ?? undefined,
        clean: workspace.workspaceDirectory ? await isCleanWorktree(workspace.workspaceDirectory) : false,
      };
    },
    archive: (workspaceId) => api.workspaces.archive(workspaceId),
    log,
  };
}
