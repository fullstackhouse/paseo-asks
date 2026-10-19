import { z } from "zod";
import { ACTION_KINDS, ASK_KINDS, ASK_STATUSES, OPEN_STATUSES, type Ask } from "../shared/asks";
import type { Outbox } from "./outbox";
import type { AskStore, NewAsk } from "./store";

export const INSTRUCTIONS = `Asks are the human's list of what you need from them, shown in Paseo outside this chat, with buttons that answer you.
- Whenever you need the human — a PR to review or merge, a decision, approval of a follow-up, a manual step you cannot do (an OAuth click, a vendor console), or an answer — call ask_create, then refer to it by id in chat ("see A3"). Do not leave it only in the chat.
- One item per ask. title: the question or the move, one line. body (markdown): what is at stake, the facts, the options, your recommendation.
- Decisions: one "resolve" action per option (2-4), mark one recommended. PRs and follow-ups: "send" actions whose prompt is the exact instruction you want back ("Merge PR #30 with squash"); put the PR URL in links.
- Answers arrive as messages starting with [asks]. Act on them. After finishing work a send action gave you, call ask_resolve.
- Keep asks true: ask_update when facts change, ask_resolve or status "dropped" when the human is no longer needed. Check ask_list before creating a duplicate.
- Your own to-do list stays in your task tool. Asks are only for things whose next move is the human's.`;

const ActionInput = z.object({
  label: z.string().min(1).max(60),
  kind: z.enum(ACTION_KINDS),
  prompt: z.string().optional(),
  url: z.string().url().optional(),
  recommended: z.boolean().optional(),
});
const LinkInput = z.object({ label: z.string(), url: z.string().url() });

const CreateInput = z.object({
  kind: z.enum(ASK_KINDS),
  title: z.string().min(1).max(200),
  body: z.string().optional(),
  actions: z.array(ActionInput).max(8).default([]),
  links: z.array(LinkInput).default([]),
});
const UpdateInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().optional(),
  actions: z.array(ActionInput).max(8).optional(),
  links: z.array(LinkInput).optional(),
  status: z.enum(ASK_STATUSES).optional(),
});
const ResolveInput = z.object({ id: z.string(), actionId: z.string().optional(), note: z.string().optional() });
const ListInput = z.object({
  status: z.enum(["open", "all"]).default("open"),
  scope: z.enum(["workspace", "mine"]).default("workspace"),
});

export const TOOLS = [
  {
    name: "ask_create",
    description: "Record something you need from the human (review, decision, approval, manual step, answer). Returns its id, e.g. A3.",
    inputSchema: z.toJSONSchema(CreateInput, { io: "input" }),
  },
  {
    name: "ask_update",
    description: "Change an ask you created: facts, options, links, or status (open, in_progress, done, dropped).",
    inputSchema: z.toJSONSchema(UpdateInput, { io: "input" }),
  },
  {
    name: "ask_resolve",
    description: "Close an ask once it no longer needs the human, e.g. after doing the work a send action gave you.",
    inputSchema: z.toJSONSchema(ResolveInput, { io: "input" }),
  },
  {
    name: "ask_list",
    description: "List asks in your workspace (or only yours). Defaults to open ones.",
    inputSchema: z.toJSONSchema(ListInput, { io: "input" }),
  },
];

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export class AsksService {
  constructor(
    private readonly store: AskStore,
    private readonly outbox: Outbox,
    private readonly workspaceOf: (agentId: string) => Promise<string | null>,
  ) {}

  async callTool(agentId: string | null, name: string, args: unknown): Promise<ToolResult> {
    try {
      if (!agentId) throw new Error("PASEO_AGENT_ID is not set for this agent, so the ask has no owner");
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
      switch (name) {
        case "ask_create":
          return render(await this.create(workspaceId, agentId, CreateInput.parse(args)));
        case "ask_update": {
          const { id, ...patch } = UpdateInput.parse(args);
          this.require(workspaceId, id);
          checkActions(patch.actions ?? []);
          return render(await this.store.update(workspaceId, id, patch));
        }
        case "ask_resolve": {
          const { id, actionId, note } = ResolveInput.parse(args);
          const ask = this.require(workspaceId, id);
          const label = actionId ? ask.actions.find((action) => action.id === actionId)?.label : undefined;
          const outcome = { actionId, label, note, by: "agent" as const, at: new Date().toISOString() };
          return render(await this.store.update(workspaceId, id, { status: "done", outcome }));
        }
        case "ask_list": {
          const { status, scope } = ListInput.parse(args);
          const asks = this.store
            .list(workspaceId)
            .filter((ask) => status === "all" || OPEN_STATUSES.includes(ask.status))
            .filter((ask) => scope === "workspace" || ask.ownerAgentId === agentId);
          return { text: asks.length ? asks.map(summary).join("\n") : "No asks." };
        }
        default:
          throw new Error(`Unknown tool ${name}`);
      }
    } catch (error) {
      const text = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
      return { text, isError: true };
    }
  }

  /** A human disposes of an ask from the UI. Returns whether the owning agent will be told. */
  async act(input: {
    workspaceId: string;
    id: string;
    verb: "action" | "done" | "drop" | "reply";
    actionId?: string;
    note?: string;
  }): Promise<{ ask: Ask; notified: boolean }> {
    const ask = this.require(input.workspaceId, input.id);
    const note = input.note?.trim() || undefined;
    const at = new Date().toISOString();
    const head = `[asks] ${ask.id} (${ask.title})`;
    const noted = note ? ` Note from the human: "${note}"` : "";
    let next: Ask;
    let message: string;
    switch (input.verb) {
      case "action": {
        const action = ask.actions.find((candidate) => candidate.id === input.actionId);
        if (!action) throw new Error(`Ask ${ask.id} has no action ${input.actionId}`);
        if (action.kind === "open") throw new Error("Open actions run on the client");
        if (action.kind === "send") {
          next = await this.store.update(ask.workspaceId, ask.id, { status: "in_progress" });
          message = `${head} "${action.label}": ${action.prompt ?? action.label}.${noted} When it is done, call ask_resolve for ${ask.id}.`;
        } else {
          const outcome = { actionId: action.id, label: action.label, note, by: "human" as const, at };
          next = await this.store.update(ask.workspaceId, ask.id, { status: "done", outcome });
          message = `${head} resolved: ${action.label}.${noted}`;
        }
        break;
      }
      case "done":
        next = await this.store.update(ask.workspaceId, ask.id, { status: "done", outcome: { note, by: "human", at } });
        message = `${head} marked done by the human.${noted}`;
        break;
      case "drop":
        next = await this.store.update(ask.workspaceId, ask.id, { status: "dropped", outcome: { note, by: "human", at } });
        message = `${head} dropped by the human; do not pursue it.${noted}`;
        break;
      case "reply":
        if (!note) throw new Error("A reply needs text");
        next = await this.store.update(ask.workspaceId, ask.id, {});
        message = `${head} reply from the human: "${note}". Update or resolve ${ask.id} accordingly.`;
        break;
    }
    if (ask.orphaned) return { ask: next, notified: false };
    this.outbox.enqueue({ agentId: ask.ownerAgentId, workspaceId: ask.workspaceId, askId: ask.id, text: message });
    void this.outbox.flush(ask.ownerAgentId);
    return { ask: next, notified: true };
  }

  private async create(workspaceId: string, agentId: string, input: z.output<typeof CreateInput>): Promise<Ask> {
    checkActions(input.actions);
    if (input.kind === "decision" && input.actions.filter((action) => action.kind === "resolve").length < 2) {
      throw new Error('A decision needs at least two "resolve" actions, one per option');
    }
    const ask: NewAsk = { ...input, workspaceId, ownerAgentId: agentId };
    return this.store.create(ask);
  }

  private require(workspaceId: string, id: string): Ask {
    const ask = this.store.get(workspaceId, id);
    if (!ask) throw new Error(`No ask ${id} in this workspace`);
    return ask;
  }
}

function checkActions(actions: z.output<typeof ActionInput>[]): void {
  for (const action of actions) {
    if (action.kind === "open" && !action.url) throw new Error(`Action "${action.label}" is "open" but has no url`);
  }
  if (actions.filter((action) => action.recommended).length > 1) throw new Error("Recommend at most one action");
}

function summary(ask: Ask): string {
  return `${ask.id} [${ask.status}] ${ask.kind}: ${ask.title}`;
}

function render(ask: Ask): ToolResult {
  const actions = ask.actions.map((action) => `${action.id} ${action.kind} "${action.label}"`).join(", ");
  return { text: `${summary(ask)}${actions ? `\nactions: ${actions}` : ""}` };
}
