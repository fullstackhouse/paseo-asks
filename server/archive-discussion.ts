import type { Ask } from "../shared/asks";
import { OPEN_STATUSES } from "../shared/asks";
import type { AsksService } from "./service";
import type { AskStore } from "./store";

/** What archiving an explainer's workspace needs from the daemon. */
export interface ArchiveHost {
  /** Null when the workspace is already archived or deleted. */
  workspace(workspaceId: string): Promise<{ directory?: string; working: boolean; terminals: number } | null>;
  uncommittedFiles(directory: string): Promise<string[] | null>;
  archive(workspaceId: string): Promise<{ error?: string | null }>;
}

export type ArchiveOutcome = { archived: true } | { archived: false; reason: string };

const LISTED_FILES = 3;

/**
 * The human pressed "Archive explainer workspace" on a settled ask. Archiving stops every agent and terminal there
 * and force-removes the worktree, so this refuses, saying why, while anything there would be lost or is still going
 * on; Paseo's own Archive (which asks first) stays available for that. Ends the discussion either way it goes away.
 */
export async function archiveDiscussion(deps: { store: AskStore; service: AsksService; host: ArchiveHost }, ask: Ask): Promise<ArchiveOutcome> {
  const { store, service, host } = deps;
  const workspaceId = ask.discussionWorkspaceId;
  const agentId = ask.discussionAgentId;
  if (!workspaceId || !agentId) return { archived: false, reason: `${ask.id} has no explainer workspace` };
  if (OPEN_STATUSES.includes(ask.status)) return { archived: false, reason: `${ask.id} still waits on you; settle it first` };
  const waiting = store.list(workspaceId).filter((own) => OPEN_STATUSES.includes(own.status));
  if (waiting.length) return { archived: false, reason: `${waiting.map((own) => own.id).join(", ")} there still ${waiting.length > 1 ? "wait" : "waits"} on you` };
  const workspace = await host.workspace(workspaceId);
  if (!workspace) {
    await service.endDiscussion(agentId);
    return { archived: true };
  }
  if (workspace.working) return { archived: false, reason: "an agent there is still working" };
  if (workspace.terminals) return { archived: false, reason: `${workspace.terminals} terminal${workspace.terminals > 1 ? "s are" : " is"} open there` };
  const files = workspace.directory ? await host.uncommittedFiles(workspace.directory) : null;
  if (!files) return { archived: false, reason: "can't tell whether its worktree has uncommitted files; archive it from Paseo's sidebar" };
  if (files.length) {
    const shown = files.slice(0, LISTED_FILES).join(", ") + (files.length > LISTED_FILES ? ` and ${files.length - LISTED_FILES} more` : "");
    return { archived: false, reason: `its worktree has uncommitted files (${shown}); archive it from Paseo's sidebar to confirm losing them` };
  }
  const result = await host.archive(workspaceId);
  if (result.error) return { archived: false, reason: result.error };
  await service.endDiscussion(agentId);
  return { archived: true };
}
