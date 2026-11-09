import { z } from "zod";
import { ACTION_KINDS, ASK_KINDS, ASK_STATUSES, OPEN_STATUSES, prUrlOf, type Ask, type PrState } from "../shared/asks";
import { REFRESH } from "./nudge";
import type { Outbox } from "./outbox";
import type { AskStore, NewAsk } from "./store";

const ADDRESS_REVIEW = `  - "CHANGES_REQUESTED": address the comments, or report what you will not change, and push. Then ask_update the same ask with a send action to re-request the review, not a Merge action.`;
const HOLD_REVIEW = `  - "CHANGES_REQUESTED": the human decides when the review is worked. Do not start on it yourself: Paseo raises an "Address review comments on PR #N" ask, and its button sends you the work. Do not give your own asks an action that starts the review; that ask carries it. When its prompt arrives, address the comments, or report what you will not change, push, and ask_update the PR ask with a send action to re-request the review, not a Merge action.`;

/** The agent's standing rules. With review changes held, an agent that sees CHANGES_REQUESTED itself must wait for the human too. */
export const instructions = ({ actOnReviewChanges = true } = {}) => `Asks are the human's list of what you need from them, shown in Paseo outside this chat, with buttons that answer you.
- Rule: never end a turn with a question, a choice or a request for the human in chat alone. Record it with ask_create and point to it ("see A3").
- Whenever you need the human — reviewers or a merge for a PR, a decision, approval of a follow-up, a manual step you cannot do (an OAuth click, a vendor console), or an answer — call ask_create, then refer to it by id in chat ("see A3"). Do not leave it only in the chat.
- Follow-ups count even when nothing blocks you: work you recommend or defer ("worth doing next time", "out of scope here") gets a followup ask with a send action whose prompt starts that work, or it is lost when this chat is archived. Instructions against offering more work in your reply do not apply: the ask replaces the offer. Skip it only if you would advise against doing the work at all.
- Call ask_create as the last step of your turn: write your summary and explanation in chat first, then create the ask, then add at most one short line ("See A3."). The ask and its buttons appear in the chat where you call it, so this puts them right below what the human just read.
- One item per ask. title: the question or the move, one line. body (markdown): what is at stake, the facts, the options, your recommendation.
- Decisions: one "resolve" action per option (2-4), mark one recommended. PRs and follow-ups: "send" actions whose prompt is the exact instruction you want back ("Merge PR #30 with squash"); put the PR URL in links. Set subscribe: true on a PR ask to be told when it is merged or closed, its checks pass or fail, or its review decision changes.
- Clicking an action is the human acting, not you. Anything you were told to leave to the human (merge, deploy, delete, publish, spend) belongs in an ask as a send action, not left out: "the human merges" means they click it.
- PRs: one subscribed ask per PR, shaped by gh pr view --json reviewDecision,statusCheckRollup. No Merge action while checks are pending or failing.
  - Empty or "APPROVED", checks passing: the PR is ready. A "Merge" send action, and no review ask.
  - "REVIEW_REQUIRED": the human's move is choosing who reviews it. Title it "Request review on PR #N", with one send action per candidate reviewer (2-4, from CODEOWNERS, recent reviewers of the touched files, or collaborators; recommend one), each prompt naming who ("Request review on PR #30 from alice"). If the human can merge past the review (gh api graphql -f query='{repository(owner:"OWNER",name:"REPO"){pullRequest(number:N){viewerCanMergeAsAdmin}}}' is true), add a send action "Merge with --admin" next to them.
${actOnReviewChanges ? ADDRESS_REVIEW : HOLD_REVIEW}
  - Request or re-request a review only when the human clicks. Doing it does not finish the ask: keep it in progress, not resolved, so its subscription tells you about the review. Once the review is approved and checks pass, ask_update the same ask to a "Merge" send action.
- The human may talk an ask through in a side chat; its outcome reaches you as an [asks] message like any other answer.
- Answers arrive as messages starting with [asks]. Act on them. After finishing work a send action gave you, call ask_resolve (a requested PR review is not finished until it is approved; see PRs).
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
  subscribe: z.boolean().optional(),
});
const UpdateInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().optional(),
  actions: z.array(ActionInput).max(8).optional(),
  links: z.array(LinkInput).optional(),
  status: z.enum(ASK_STATUSES).optional(),
  subscribe: z.boolean().optional(),
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
          const ask = this.require(workspaceId, id);
          checkActions(patch.actions ?? []);
          // Fresh options on an ask the agent was working on hand it back to the human; the UI shows buttons only on open asks.
          if (patch.actions?.length && !patch.status && ask.status === "in_progress") patch.status = "open";
          const updated = await this.store.update(workspaceId, id, patch);
          if (agentId !== ask.ownerAgentId && !ask.orphaned && patch.status && patch.status !== ask.status) {
            this.notify(ask, `[asks] ${ask.id} (${ask.title}) marked ${patch.status.replace("_", " ")} in a side chat.`);
          }
          return render(updated);
        }
        case "ask_resolve": {
          const { id, actionId, note } = ResolveInput.parse(args);
          const ask = this.require(workspaceId, id);
          const label = actionId ? ask.actions.find((action) => action.id === actionId)?.label : undefined;
          const outcome = { actionId, label, note, by: "agent" as const, at: new Date().toISOString() };
          const resolved = await this.store.update(workspaceId, id, { status: "done", outcome });
          // A side chat (or any other agent) closing someone else's ask: the owner must hear about it.
          if (agentId !== ask.ownerAgentId && !ask.orphaned) {
            const choice = label ? `: ${label}` : "";
            const summary = note ? ` Summary: ${note}` : "";
            this.notify(ask, `[asks] ${ask.id} (${ask.title}) resolved in a side chat${choice}.${summary}`);
          }
          return render(resolved);
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
          // Resolving drops the ask from the PR watcher, so a review request resolved here would never hear the approval.
          const watched = ask.subscribe && prUrlOf(ask) ? " If the PR still waits on the human after it (a review requested, not yet approved), leave the ask in progress instead: resolving it ends its PR updates." : "";
          message = `${head} "${action.label}": ${action.prompt ?? action.label}.${noted} When it is done, call ask_resolve for ${ask.id}.${watched}`;
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
    this.notify(ask, message);
    return { ask: next, notified: true };
  }

  /** Queue a message for the ask's owner; it goes out once the owner is between turns. */
  notify(ask: Ask, text: string): void {
    this.outbox.enqueue({ agentId: ask.ownerAgentId, workspaceId: ask.workspaceId, askId: ask.id, text });
    void this.outbox.flush(ask.ownerAgentId);
  }

  /** Queue a message about asks in general. The same text already waiting is not queued twice. */
  message(agentId: string, workspaceId: string, text: string): void {
    if (this.outbox.pending(agentId).some((entry) => entry.text === text)) return;
    this.outbox.enqueue({ agentId, workspaceId, text });
  }

  /** The human asks an agent to bring its asks up to date. Returns whether it went out now or waits for the turn to end. */
  async refresh(agentId: string): Promise<{ sent: boolean }> {
    const workspaceId = await this.workspaceOf(agentId);
    if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
    this.message(agentId, workspaceId, REFRESH);
    await this.outbox.flush(agentId);
    return { sent: this.outbox.pending(agentId).length === 0 };
  }

  /** Requested changes the human holds back: an ask whose button starts the work, owned by the PR ask's agent. */
  async raiseReview(prAsk: Ask, pr: PrState): Promise<Ask> {
    const title = `Address review comments on PR #${pr.number}`;
    const open = this.store
      .list(prAsk.workspaceId)
      .find(
        (ask) =>
          // Another or a gone owner's ask can't take the work, so the button must reach this owner.
          ask.ownerAgentId === prAsk.ownerAgentId &&
          !ask.orphaned &&
          OPEN_STATUSES.includes(ask.status) &&
          ask.title === title &&
          prUrlOf(ask) === pr.url,
      );
    if (open) return open;
    return this.store.create({
      workspaceId: prAsk.workspaceId,
      ownerAgentId: prAsk.ownerAgentId,
      kind: "followup",
      title,
      body: `A reviewer requested changes on PR #${pr.number}. The agent has not been told: it starts on them when you press **Address review comments**.`,
      links: [{ label: `PR #${pr.number}`, url: pr.url }],
      actions: [{ label: "Address review comments", kind: "send", prompt: `Address the review comments on PR #${pr.number} (${pr.url}) and push` }],
    });
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
