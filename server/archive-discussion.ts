import type { PaseoApi } from "@getpaseo/client";
import type { Ask } from "../shared/asks";
import type { AsksService } from "./service";
import type { AskStore } from "./store";
import { uncommittedFiles } from "./worktree";

/** What archiving an explainer's workspace needs from the daemon. */
export interface ArchiveHost {
  /**
   * Null when the workspace is gone. `archiving`: an archive is already under way. `agents`: its agents that are not
   * archived, with whether each is at work.
   */
  workspace(workspaceId: string): Promise<{
    directory?: string;
    archiving: boolean;
    agents: { id: string; title: string | null; working: boolean }[];
    terminals: number;
  } | null>;
  uncommittedFiles(directory: string): Promise<string[] | null>;
  archive(workspaceId: string): Promise<{ error?: string | null }>;
}

/** `files`: what archiving would delete, so the human can confirm it with `discardFiles`. */
export type ArchiveOutcome = { archived: true } | { archived: false; reason: string; files?: string[] };

const LISTED_FILES = 3;
const PAGE = 200;

/**
 * The human pressed "Archive explainer workspace" on a settled ask. Archiving stops every agent and terminal there
 * and force-removes the worktree (its branch stays), so this refuses, saying why, while anything there is still going
 * on or belongs to someone else. Uncommitted and untracked files (the explainer's notes, usually) are listed back for
 * the human to confirm with `discardFiles`; files git ignores go with the worktree unasked. A workspace that is
 * already gone just ends the discussion.
 */
export async function archiveDiscussion(
  deps: { store: AskStore; service: AsksService; host: ArchiveHost },
  ask: Ask,
  { discardFiles = false } = {},
): Promise<ArchiveOutcome> {
  const { store, service, host } = deps;
  const workspaceId = ask.discussionWorkspaceId;
  const agentId = ask.discussionAgentId;
  if (!workspaceId || !agentId) return { archived: false, reason: `${ask.id} has no explainer workspace` };
  // Old or broken data must never point this at the workspace the ask itself lives in.
  if (workspaceId === ask.workspaceId) return { archived: false, reason: `${ask.id} was discussed in its own workspace` };
  if (ask.status === "open") return { archived: false, reason: `${ask.id} still waits on you; settle it first` };
  if (ask.status === "in_progress") return { archived: false, reason: `${ask.id} is still being worked on` };
  const pending = store.list(workspaceId).filter((own) => own.status === "open" || own.status === "in_progress");
  if (pending.length) return { archived: false, reason: `${pending.map((own) => own.id).join(", ")} there ${pending.length > 1 ? "are" : "is"} still open` };

  const workspace = await host.workspace(workspaceId);
  if (!workspace) {
    await service.endDiscussion(agentId);
    return { archived: true };
  }
  if (workspace.archiving) return { archived: false, reason: "it is already being archived" };
  if (workspace.agents.some((agent) => agent.working)) return { archived: false, reason: "an agent there is still working" };
  const others = workspace.agents.filter((agent) => agent.id !== agentId);
  if (others.length) {
    const names = others.map((agent) => agent.title ?? agent.id).join(", ");
    return { archived: false, reason: `other agents use it too (${names}); archive it from Paseo, which asks first` };
  }
  if (workspace.terminals) return { archived: false, reason: `${workspace.terminals} terminal${workspace.terminals > 1 ? "s are" : " is"} open there` };
  const files = workspace.directory ? await host.uncommittedFiles(workspace.directory) : null;
  if (!files) return { archived: false, reason: "can't tell whether its worktree has uncommitted files; archive it from Paseo, which asks first" };
  if (files.length && !discardFiles) {
    const shown = files.slice(0, LISTED_FILES).join(", ") + (files.length > LISTED_FILES ? ` and ${files.length - LISTED_FILES} more` : "");
    return { archived: false, reason: `its worktree has uncommitted files (${shown})`, files };
  }
  // Checks above took a moment (git status); the window to a turn starting there is accepted, not closed.
  const result = await host.archive(workspaceId);
  if (result.error) return { archived: false, reason: result.error };
  await service.endDiscussion(agentId);
  return { archived: true };
}

/** The daemon behind `archiveDiscussion`. Agents are read one by one: the workspace status can show "failed" over a running one. */
export function paseoArchiveHost(api: Pick<PaseoApi, "agents" | "workspaces">): ArchiveHost {
  return {
    async workspace(workspaceId) {
      const handle = api.workspaces.ref(workspaceId);
      const workspace = await handle.refresh();
      if (!workspace) return null;
      const agents: { id: string; title: string | null; working: boolean }[] = [];
      let cursor: string | undefined;
      do {
        const { entries, pageInfo } = await api.agents.list({
          filter: { includeBackground: true },
          includeBackground: true,
          page: { limit: PAGE, ...(cursor ? { cursor } : {}) },
        });
        for (const { agent } of entries) {
          if (agent.workspaceId !== workspaceId || agent.archivedAt) continue;
          agents.push({ id: agent.id, title: agent.title, working: agent.status === "running" || agent.status === "initializing" });
        }
        cursor = pageInfo.hasMore ? (pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor);
      const { entries: terminals } = await handle.terminals.list();
      return { directory: workspace.workspaceDirectory, archiving: Boolean(workspace.archivingAt), agents, terminals: terminals.length };
    },
    uncommittedFiles,
    archive: (workspaceId) => api.workspaces.archive(workspaceId),
  };
}
