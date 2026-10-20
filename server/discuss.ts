import type { PaseoApi } from "@getpaseo/client";
import type { McpServerConfig } from "@getpaseo/protocol/agent-types";
import type { Ask } from "../shared/asks";
import type { AskStore } from "./store";

const ASK_TOOLS = ["ask_create", "ask_update", "ask_resolve", "ask_list"];
const READ_ONLY_MODE = /^(plan|read[-_ ]?only)$/i;
const OWNER_CONTEXT_CHARS = 4000;

export interface DiscussDeps {
  paseo: PaseoApi;
  store: AskStore;
  mcp: McpServerConfig;
  /** The owner's most recent reply, if the plugin saw one. */
  lastOutput(agentId: string): string | undefined;
}

/**
 * Opens a read-only side chat, a child of the ask's owner, seeded with the ask and the owner's latest
 * reply. Reuses the existing one while it is alive. It ends by calling ask_resolve, which the owner hears.
 */
export async function discuss(deps: DiscussDeps, ask: Ask): Promise<{ agentId: string; created: boolean }> {
  const { paseo, store } = deps;
  if (ask.discussionAgentId) {
    const existing = paseo.agents.ref(ask.discussionAgentId);
    const found = await existing.refresh().catch(() => null);
    if (found && !existing.archivedAt) return { agentId: existing.id, created: false };
  }

  const owner = paseo.agents.ref(ask.ownerAgentId);
  const found = await owner.refresh();
  const snapshot = owner.current();
  if (!found || !snapshot) throw new Error(`The agent that raised ${ask.id} is gone; nobody to discuss it with`);
  const model = snapshot.model ?? snapshot.runtimeInfo?.model;
  if (!model) throw new Error(`Cannot tell which model ${ask.ownerAgentId} runs, so cannot start a side chat like it`);
  const mode = (snapshot.availableModes ?? []).find((candidate) => READ_ONLY_MODE.test(candidate.id));
  if (!mode) throw new Error(`${snapshot.provider} offers no read-only mode, so a side chat could edit the worktree`);

  const handle = await paseo.workspaces.ref(ask.workspaceId).agents.create({
    config: {
      provider: `${snapshot.provider}/${model}`,
      modeId: mode.id,
      mcpServers: { asks: deps.mcp },
      toolPolicy: { preapproved: ASK_TOOLS.map((tool) => ({ kind: "mcp" as const, server: "asks", tool })) },
    },
    parent: ask.ownerAgentId,
    title: `Discuss ${ask.id}: ${ask.title}`.slice(0, 60),
    labels: { "asks.discussion": `${ask.workspaceId}/${ask.id}` },
    prompt: seedPrompt(ask, deps.lastOutput(ask.ownerAgentId)),
  });
  await store.update(ask.workspaceId, ask.id, { discussionAgentId: handle.id }, { touch: false });
  return { agentId: handle.id, created: true };
}

export function seedPrompt(ask: Ask, ownerOutput: string | undefined): string {
  const options = ask.actions
    .filter((action) => action.kind === "resolve")
    .map((action) => `- actionId ${action.id}: ${action.label}${action.recommended ? " (the main agent recommends this)" : ""}`);
  const other = ask.actions
    .filter((action) => action.kind !== "resolve")
    .map((action) => `- ${action.label}${action.prompt ? `: ${action.prompt}` : ""}${action.url ? ` (${action.url})` : ""}`);
  const context = ownerOutput ? ownerOutput.slice(-OWNER_CONTEXT_CHARS) : undefined;
  return [
    `You are a side chat the human opened to talk through ask ${ask.id} before deciding it.`,
    `Another agent (the main agent) raised it and is the only one who changes this worktree. Do not edit files or run anything with side effects. Reading files, git log/diff, and gh views are fine when they help answer a question.`,
    `When the human settles it, call ask_resolve with id "${ask.id}"${options.length ? ", the actionId they chose," : ""} and a note: the decision plus anything the main agent must know to act on it. That note is delivered to the main agent. If the human decides nothing should happen, use ask_update with status "dropped" and explain in your reply.`,
    "",
    `## ${ask.id} · ${ask.kind}: ${ask.title}`,
    ask.body ?? "(no body)",
    options.length ? `\nOptions:\n${options.join("\n")}` : "",
    other.length ? `\nOther actions the main agent offered:\n${other.join("\n")}` : "",
    ask.links.length ? `\nLinks:\n${ask.links.map((link) => `- ${link.label}: ${link.url}`).join("\n")}` : "",
    context ? `\n## The main agent's latest reply (context)\n${context}` : "",
    "",
    "Start with a short brief: what is at stake, the options, and your honest view, in five lines or fewer. Then wait for the human.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
