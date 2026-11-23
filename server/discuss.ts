import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { McpServerConfig } from "@getpaseo/protocol/agent-types";
import { discussionTitle, type Ask } from "../shared/asks";
import type { AskStore } from "./store";

const ASK_TOOLS = ["ask_create", "ask_update", "ask_resolve", "ask_list"];
const READ_ONLY_MODE = /^(plan|read[-_ ]?only)$/i;
const OWNER_CONTEXT_CHARS = 4000;

export interface DiscussDeps {
  paseo: Pick<PaseoApi, "agents" | "workspaces">;
  store: AskStore;
  mcp: McpServerConfig;
  /** The owner's most recent reply, if the plugin saw one. */
  lastOutput(agentId: string): string | undefined;
  /** Why the explainer's workspace could not be made, before falling back to a side chat. */
  log?(message: string, error: unknown): void;
}

export interface Discussion {
  agentId: string;
  /** Where the discussion runs: the explainer's own workspace, or the ask's for a side chat. */
  workspaceId: string;
  created: boolean;
}

/**
 * Opens the discussion of an ask: an explainer agent in a new worktree workspace of the owner's repo, seeded with
 * the ask and the owner's latest reply. If that workspace can't be made (the owner is not in a git repo, say), a
 * read-only side chat in the ask's workspace instead. Reuses the live one. Either ends by calling ask_resolve, which
 * the owner hears. A note the human typed opens the chat (new) or is sent to it (existing).
 */
export async function discuss(deps: DiscussDeps, ask: Ask, note?: string): Promise<Discussion> {
  const { paseo, store } = deps;
  const message = note?.trim() || undefined;
  if (ask.discussionAgentId) {
    const existing = paseo.agents.ref(ask.discussionAgentId);
    const found = await existing.refresh().catch(() => null);
    if (found && !existing.archivedAt) {
      if (message) await existing.send(message, { activeTurnBehavior: "steer" });
      return { agentId: existing.id, workspaceId: ask.discussionWorkspaceId ?? ask.workspaceId, created: false };
    }
  }

  const owner = paseo.agents.ref(ask.ownerAgentId);
  const found = await owner.refresh();
  const snapshot = owner.current();
  if (!found || !snapshot) throw new Error(`The agent that raised ${ask.id} is gone; nobody to discuss it with`);
  const model = snapshot.model ?? snapshot.runtimeInfo?.model;
  if (!model) throw new Error(`Cannot tell which model ${ask.ownerAgentId} runs, so cannot start a discussion like it`);
  const ownerOutput = deps.lastOutput(ask.ownerAgentId);

  let workspace: Awaited<ReturnType<PaseoApi["workspaces"]["create"]>> | null = null;
  try {
    workspace = await paseo.workspaces.create({
      source: { kind: "worktree", cwd: snapshot.cwd, action: "branch-off", worktreeSlug: worktreeSlug(ask) },
      title: discussionTitle(ask),
    });
  } catch (error) {
    deps.log?.(`[asks] no workspace for discussing ${ask.workspaceId}/${ask.id}; opening a side chat`, error);
  }
  if (workspace) {
    const handle = await workspace.agents
      .create({
        config: { ...agentConfig(deps, snapshot, model), ...writingMode(snapshot) },
        title: discussionTitle(ask),
        labels: { "asks.discussion": `${ask.workspaceId}/${ask.id}` },
        prompt: explainerPrompt(ask, snapshot.cwd, ownerOutput, message),
      })
      .catch(async (error: unknown) => {
        // An empty workspace would only clutter the sidebar.
        await workspace.archive().catch(() => undefined);
        throw error;
      });
    // Its Asks tab shows this ask next to the explainer's own; their ids must differ.
    await store.reserveAfter(workspace.id, ask.id);
    await store.update(ask.workspaceId, ask.id, { discussionAgentId: handle.id, discussionWorkspaceId: workspace.id }, { touch: false });
    return { agentId: handle.id, workspaceId: workspace.id, created: true };
  }

  const mode = (snapshot.availableModes ?? []).find((candidate) => READ_ONLY_MODE.test(candidate.id));
  if (!mode) throw new Error(`${snapshot.provider} offers no read-only mode, so a side chat could edit the worktree`);
  const handle = await paseo.workspaces.ref(ask.workspaceId).agents.create({
    config: { ...agentConfig(deps, snapshot, model), modeId: mode.id },
    parent: ask.ownerAgentId,
    title: `Discuss ${ask.id}: ${ask.title}`.slice(0, 60),
    labels: { "asks.discussion": `${ask.workspaceId}/${ask.id}` },
    prompt: seedPrompt(ask, ownerOutput, message),
  });
  // A stale explainer workspace from an earlier discussion no longer applies.
  await store.update(ask.workspaceId, ask.id, { discussionAgentId: handle.id, discussionWorkspaceId: undefined }, { touch: false });
  return { agentId: handle.id, workspaceId: ask.workspaceId, created: true };
}

function agentConfig(deps: DiscussDeps, owner: PaseoAgent, model: string) {
  return {
    provider: `${owner.provider}/${model}`,
    mcpServers: { asks: deps.mcp },
    toolPolicy: { preapproved: ASK_TOOLS.map((tool) => ({ kind: "mcp" as const, server: "asks", tool })) },
  };
}

/** The owner's mode when it can write; an owner in plan mode leaves the explainer on the provider's default. */
function writingMode(owner: PaseoAgent): { modeId?: string } {
  return owner.currentModeId && !READ_ONLY_MODE.test(owner.currentModeId) ? { modeId: owner.currentModeId } : {};
}

/** Unique per discussion: the branch of an earlier one for the same ask may still exist. */
function worktreeSlug(ask: Ask): string {
  return `explain-${ask.id.toLowerCase()}-${Date.now().toString(36)}`;
}

function askBrief(ask: Ask, ownerOutput: string | undefined): string[] {
  const options = ask.actions
    .filter((action) => action.kind === "resolve")
    .map((action) => `- actionId ${action.id}: ${action.label}${action.recommended ? " (the main agent recommends this)" : ""}`);
  const other = ask.actions
    .filter((action) => action.kind !== "resolve")
    .map((action) => `- ${action.label}${action.prompt ? `: ${action.prompt}` : ""}${action.url ? ` (${action.url})` : ""}`);
  const context = ownerOutput ? ownerOutput.slice(-OWNER_CONTEXT_CHARS) : undefined;
  return [
    `## ${ask.id} · ${ask.kind}: ${ask.title}`,
    ask.body ?? "(no body)",
    options.length ? `\nOptions:\n${options.join("\n")}` : "",
    other.length ? `\nOther actions the main agent offered:\n${other.join("\n")}` : "",
    ask.links.length ? `\nLinks:\n${ask.links.map((link) => `- ${link.label}: ${link.url}`).join("\n")}` : "",
    context ? `\n## The main agent's latest reply (context)\n${context}` : "",
  ];
}

function settle(ask: Ask): string {
  const choice = ask.actions.some((action) => action.kind === "resolve") ? ", the actionId they chose," : "";
  return [
    `The human sees ${ask.id} with its buttons in this chat's Asks too, and a click there answers it; never send them elsewhere to answer it. While you wait on their choice, name ${ask.id} in your reply.`,
    `When the human settles it with you, call ask_resolve with id "${ask.id}"${choice} and a note: the decision plus anything the main agent must know to act on it. That note is delivered to the main agent. If the human decides nothing should happen, use ask_update with status "dropped" and explain in your reply.`,
    `For anything else you need from the human (a message to send for them, a follow-up), call ask_create as usual.`,
  ].join(" ");
}

function opening(message: string | undefined, brief: string): string {
  return message ? `The human opened this chat with:\n\n${message}\n\nAnswer them directly; keep it short.` : brief;
}

/** The explainer, in a worktree of its own: it may write there, never in the owner's checkout. */
export function explainerPrompt(ask: Ask, ownerCwd: string, ownerOutput: string | undefined, message?: string): string {
  return [
    `You explain ask ${ask.id} to the human so they can decide it. Another agent (the main agent) raised it and owns that work; it changes its own checkout, ${ownerCwd}. You may read that checkout, never change it.`,
    `This workspace is a fresh worktree of the same repo, branched off its default branch, and it is yours: write notes, EXPLAIN.md or figures here when they help. Do not commit, push or open pull requests.`,
    settle(ask),
    "",
    ...askBrief(ask, ownerOutput),
    "",
    opening(
      message,
      "Start by running the explain skill (/explain) on this ask. Without that skill, explain it the same way: the short version first, in plain words with a concrete example, what each option would lead to, and your recommendation; details only when the human asks. Then take their questions.",
    ),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The fallback side chat, read-only in the ask's own workspace. */
export function seedPrompt(ask: Ask, ownerOutput: string | undefined, message?: string): string {
  return [
    `You are a side chat the human opened to talk through ask ${ask.id} before deciding it.`,
    `Another agent (the main agent) raised it and is the only one who changes this worktree. Do not edit files or run anything with side effects. Reading files, git log/diff, and gh views are fine when they help answer a question.`,
    settle(ask),
    "",
    ...askBrief(ask, ownerOutput),
    "",
    opening(message, "Start with a short brief: what is at stake, the options, and your honest view, in five lines or fewer. Then wait for the human."),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
