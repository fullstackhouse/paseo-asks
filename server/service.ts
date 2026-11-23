import { z } from "zod";
import { ACTION_KINDS, ASK_KINDS, ASK_STATUSES, OPEN_STATUSES, prUrlOf, type Ask, type PrState } from "../shared/asks";
import { REFRESH } from "./nudge";
import { stuckReminder } from "../shared/prompts";
import { isStale, needsReminder } from "./stuck";
import { checkNotBundled } from "./bundle";
import { callKey } from "../shared/timeline";
import type { Outbox } from "./outbox";
import type { AskStore, NewAsk } from "./store";
import type { PathCheck } from "./file-paths";

const ADDRESS_REVIEW = `  - "CHANGES_REQUESTED": address the comments, or report what you will not change, and push. Then ask_update the same ask with a send action to re-request the review, not a Merge action.`;
const HOLD_REVIEW = `  - "CHANGES_REQUESTED": the human decides when the review is worked. Do not start on it yourself: Paseo raises an "Address review comments on PR #N" ask, and its button sends you the work. Do not give your own asks an action that starts the review; that ask carries it. When its prompt arrives, address the comments, or report what you will not change, push, and ask_update the PR ask with a send action to re-request the review, not a Merge action. Comments on an approved PR raise no such ask: list them in the PR ask's body and add an "Address review comments" send action next to Merge.`;

/** The agent's standing rules. With review changes held, an agent that sees CHANGES_REQUESTED itself must wait for the human too. */
export const instructions = ({ actOnReviewChanges = true } = {}) => `Asks are the human's list of what you need from them, shown in Paseo outside this chat, with buttons that answer you.
- Rule: never end a turn with a question, a choice or a request for the human in chat alone. Record it with ask_create.
- Whenever you need the human — reviewers or a merge for a PR, a decision, approval of a follow-up, a manual step you cannot do (an OAuth click, a vendor console), or an answer — call ask_create. Do not leave it only in the chat. When a reply mentions an ask from an earlier turn, name it by id ("still waiting on A3").
- Follow-ups count even when nothing blocks you: work you recommend or defer ("worth doing next time", "out of scope here") gets a followup ask with a send action whose prompt starts that work, or it is lost when this chat is archived. Instructions against offering more work in your reply do not apply: the ask replaces the offer. Skip it only if you would advise against doing the work at all.
- Create or update your asks before your final reply, then end the turn with that reply: your summary and explanation, naming the ask by id where it helps ("A3 has the options"). The ask and its buttons appear in the chat where you call it. A collapsed turn shows only its last message, so the turn must end on your answer, not on the ask or a line pointing to it.
- One item per ask. title: the question or the move, one line. body (markdown): what is at stake, the facts, the options, your recommendation.
- Write for someone who hasn't seen the work: open the body with "Simply put:" and a concrete example, and keep file paths and internal codes (ticket or spec ids) out of titles; PR numbers are fine. When the decision is about structure or flow, add a mermaid diagram.
- Several open questions (a spec's open questions, a list of decisions) are several asks: create one per question, each with its own options, so the human answers them one by one. Never bundle them into one ask with "Accept all" or "answer in chat"; put the shared context in each body in a line or two.
- Decisions: one "resolve" action per option (2-4), mark one recommended. PRs and follow-ups: "send" actions whose prompt is the exact instruction you want back ("Merge PR #30 with squash"); put the PR URL in links. Set subscribe: true on a PR ask to be told when it is merged or closed, its checks pass or fail, or its review decision changes.
- Action labels: a short verb and its object ("Merge (squash)", "Request review from alice"). Leave out the PR number and the ask id: the card shows them. Mark the one you recommend with recommended: true, not with a star in the label.
- Clicking an action is the human acting, not you. Anything you were told to leave to the human (merge, deploy, delete, publish, spend) belongs in an ask as a send action, not left out: "the human merges" means they click it.
- Never make the human wait to click. When the move depends on something you can watch (a merge, a release, CI, another agent), offer it now as a conditional approval ("Start once #12 is merged and released", not "Start (#12 merged and released)"); on the click, keep the ask in progress, wait yourself, then act.
- PRs: one subscribed ask per PR, shaped by gh pr view --json reviewDecision,statusCheckRollup. While checks are pending, offer each Merge action below as "… when green" with a prompt saying so ("Merge PR #30 with squash once checks pass"); on that click, keep the ask in progress and merge when your subscription reports the checks passing. While checks fail, offer no Merge action: fix them and push.
  - Before any Merge action, read every review body and comment from people, approvals included; skip bot status comments (CI summaries, preview-deploy notices). Use gh pr view N --json reviews,comments for review bodies and top-level comments, and gh api --paginate repos/OWNER/REPO/pulls/N/comments for inline ones. Resolved threads don't count (reviewThreads { isResolved } through gh api graphql tells which). An approval often carries suggestions, questions or "fix before merging": handle them like requested changes (see "CHANGES_REQUESTED"), except that afterwards you offer Merge, naming what changed in the ask body, not a re-review, unless the reviewer asked to look again. Quote any you leave unaddressed in the ask body, with why.
  - Empty or "APPROVED", checks passing or pending, every comment read: the PR is ready. A "Merge" send action, and no review ask.
  - "REVIEW_REQUIRED": the human's move is choosing who reviews it. Title it "Request review on PR #N", with one send action per candidate reviewer (2-4, from CODEOWNERS, recent reviewers of the touched files, or collaborators; recommend one), each prompt naming who ("Request review on PR #30 from alice"). If the human can merge past the review (gh api graphql -f query='{repository(owner:"OWNER",name:"REPO"){pullRequest(number:N){viewerCanMergeAsAdmin}}}' is true), add a send action "Merge with --admin" next to them.
${actOnReviewChanges ? ADDRESS_REVIEW : HOLD_REVIEW}
  - Request or re-request a review only when the human clicks. Doing it does not finish the ask: keep it in progress, not resolved, so its subscription tells you about the review. Once the review is approved and checks pass, read the review and its comments as above, then ask_update the same ask to a "Merge" send action.
- The human may talk an ask through in a side chat; its outcome reaches you as an [asks] message like any other answer.
- Answers arrive as messages starting with [asks]. Act on them. After finishing work a send action gave you, call ask_resolve (a requested PR review is not finished until it is approved; see PRs).
- Status says whose move it is. open: the human's; the ask shows its buttons and counts as waiting on them. in_progress: yours, after the human acted; buttons are hidden. When the next move is the human's again (a merge, a review, a label, an answer), ask_update it with the action they need, which sets it back to open; never point them to a button on an in-progress ask. In chat, use these names: "waiting on you" for open, "in progress" for in_progress.
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
  status: z.enum(["active", "all"]).default("active"),
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
    description: "List asks in your workspace (or only yours). Defaults to active ones: open (waiting on the human) or in_progress (yours).",
    inputSchema: z.toJSONSchema(ListInput, { io: "input" }),
  },
];

export interface ToolResult {
  text: string;
  isError?: boolean;
  /** The ask the call created or changed. */
  ask?: Pick<Ask, "workspaceId" | "id">;
}

/** What an agent in a background workspace gets back instead of an ask. */
export const BACKGROUND_SKIP =
  "Skipped: this workspace runs in the background (an automated run hidden from the sidebar), so nobody reads asks here. Put what you have in your final reply. Asks work again once the human opens this chat.";

export class AsksService {
  constructor(
    private readonly store: AskStore,
    private readonly outbox: Outbox,
    private readonly workspaceOf: (agentId: string) => Promise<string | null>,
    /**
     * Background workspaces (hidden from the sidebar, e.g. Inbox review runs) get no asks: nobody watches them, and
     * whatever the run produced already shows where it was started from. The tool stays, since an agent's tools are
     * fixed when it is created and the human may take the run over later.
     */
    private readonly isBackground: (workspaceId: string) => Promise<boolean> = async () => false,
    /** Makes file paths in a body open from the workspace; see file-paths.ts. */
    private readonly checkPaths: (workspaceId: string, body: string) => Promise<PathCheck> = async (_, body) => ({ body, notes: [] }),
  ) {}

  async callTool(agentId: string | null, name: string, args: unknown): Promise<ToolResult> {
    try {
      if (!agentId) throw new Error("PASEO_AGENT_ID is not set for this agent, so the ask has no owner");
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
      if (await this.isBackground(workspaceId)) return { text: BACKGROUND_SKIP };
      switch (name) {
        case "ask_create": {
          const input = CreateInput.parse(args);
          const paths = await this.paths(workspaceId, input.body);
          const lastCall = callKey("create", args);
          return render(await this.create(workspaceId, agentId, { ...input, body: paths.body }, lastCall), paths.notes);
        }
        case "ask_update": {
          const { id, ...patch } = UpdateInput.parse(args);
          this.checkStillWaiting(this.find(workspaceId, agentId, id), agentId);
          const paths = await this.paths(this.find(workspaceId, agentId, id).workspaceId, patch.body);
          patch.body = paths.body;
          // Read again after the path check (git, seconds): a human click meanwhile must not be overwritten.
          const ask = this.find(workspaceId, agentId, id);
          this.checkStillWaiting(ask, agentId);
          checkActions(patch.actions ?? []);
          if (patch.title !== undefined || patch.actions) {
            checkNotBundled(patch.title ?? ask.title, (patch.actions ?? ask.actions).map((action) => action.label));
          }
          // Fresh options hand the ask back to the human: the UI shows buttons only on open asks, so actions on an
          // in-progress ask can't be clicked. Applies even when the agent asks for in_progress explicitly. Except while
          // the human's answer still waits in the outbox: the agent is editing options it doesn't know were clicked.
          const unseenAnswer = this.outbox.pending(ask.ownerAgentId).some((entry) => entry.askId === ask.id);
          if (patch.actions?.length && (patch.status ?? ask.status) === "in_progress" && !unseenAnswer) {
            patch.status = "open";
          }
          // Reopened by its owner: the old discussion was about what it asked then. Discuss starts a new one.
          const reopened = !OPEN_STATUSES.includes(ask.status) && patch.status !== undefined && OPEN_STATUSES.includes(patch.status);
          const unlink = reopened && ask.discussionAgentId ? { discussionAgentId: undefined, discussionWorkspaceId: undefined } : {};
          const updated = await this.store.update(ask.workspaceId, id, { ...patch, ...unlink, lastCall: callKey("update", args) });
          if (agentId !== ask.ownerAgentId && !ask.orphaned && patch.status && patch.status !== ask.status) {
            this.notify(ask, `[asks] ${ask.id} (${ask.title}) marked ${patch.status.replace("_", " ")} in a side chat.`);
          }
          return render(updated, paths.notes);
        }
        case "ask_resolve": {
          const { id, actionId, note } = ResolveInput.parse(args);
          const ask = this.find(workspaceId, agentId, id);
          this.checkStillWaiting(ask, agentId);
          const label = actionId ? ask.actions.find((action) => action.id === actionId)?.label : undefined;
          const outcome = { actionId, label, note, by: "agent" as const, at: new Date().toISOString() };
          const resolved = await this.store.update(ask.workspaceId, id, { status: "done", outcome, lastCall: callKey("resolve", args) });
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
          // An explainer in its own workspace also sees the ask it discusses.
          const linked = this.discussing(agentId).filter((ask) => ask.workspaceId !== workspaceId);
          const asks = [...linked, ...this.store.list(workspaceId)]
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
          // The card shows what you chose while the agent works on it.
          const outcome = { actionId: action.id, label: action.label, note, by: "human" as const, at };
          next = await this.store.update(ask.workspaceId, ask.id, { status: "in_progress", outcome });
          // Resolving drops the ask from the PR watcher, so a review request resolved here would never hear the approval.
          const watched = ask.subscribe && prUrlOf(ask) ? " If the PR then waits on someone other than the human (CI, a reviewer you requested), keep the ask in progress instead of resolving it: resolving ends its PR updates. If it waits on the human (a label, an approval, a merge only they can do), ask_update it with the action they need, which sets it back to open." : "";
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
    this.tellDiscussion(ask, input.verb, input.actionId);
    if (ask.orphaned) return { ask: next, notified: false };
    this.notify(ask, message);
    return { ask: next, notified: true };
  }

  /**
   * The human answered with a button, which may be in the explainer's workspace: the agent discussing the ask must
   * know, or it settles the ask a second time. No askId, so an explainer that is gone leaves the ask alone.
   */
  private tellDiscussion(ask: Ask, verb: "action" | "done" | "drop" | "reply", actionId?: string): void {
    const agentId = ask.discussionAgentId;
    if (!agentId || agentId === ask.ownerAgentId || verb === "reply") return;
    const action = ask.actions.find((candidate) => candidate.id === actionId);
    const what = verb === "done" ? "marked it done" : verb === "drop" ? "dropped it" : `chose "${action?.label ?? actionId}"`;
    const told = ask.orphaned ? "Nobody else was told: the agent that raised it is gone." : "The main agent has been told.";
    this.message(
      agentId,
      ask.discussionWorkspaceId ?? ask.workspaceId,
      `[asks] The human answered ${ask.id} (${ask.title}) with its buttons: they ${what}. ${told} Do not resolve or update ${ask.id}. Reply in one line.`,
    );
    void this.outbox.flush(agentId);
  }

  /**
   * A discussion settles an ask only while it waits on the human. Once the human answered (a choice, or work handed
   * to the owner), another settle would overwrite the answer, tell the owner twice, or end the owner's PR updates.
   */
  private checkStillWaiting(ask: Ask, agentId: string): void {
    if (agentId !== ask.discussionAgentId || agentId === ask.ownerAgentId || ask.status === "open") return;
    const outcome = ask.outcome?.label ? `: ${ask.outcome.label}` : "";
    const holder = ask.orphaned ? "its agent is gone" : "the main agent has it";
    throw new Error(`${ask.id} no longer waits on the human (${ask.status.replace("_", " ")}${outcome}); ${holder}. Leave it as it is.`);
  }

  /** Queue a message for the ask's owner; it goes out once the owner is between turns. */
  notify(ask: Ask, text: string): void {
    this.outbox.enqueue({ agentId: ask.ownerAgentId, workspaceId: ask.workspaceId, askId: ask.id, text });
    void this.outbox.flush(ask.ownerAgentId);
  }

  /** The owner ended a turn holding in-progress asks that wait on nobody else: one reminder per change of each. */
  async remindStuck(agentId: string, workspaceId: string): Promise<void> {
    const stuck = this.store.list(workspaceId).filter((ask) => ask.ownerAgentId === agentId && needsReminder(ask));
    if (!stuck.length) return;
    const at = new Date().toISOString();
    for (const ask of stuck) await this.store.update(workspaceId, ask.id, { remindedAt: at }, { touch: false });
    this.message(agentId, workspaceId, stuckReminder(stuck));
  }

  /** Hand the owner's in-progress asks back to the human: it is gone, so nobody is working on them. */
  async releaseOwner(agentId: string): Promise<Ask[]> {
    const held = this.store.list().filter((ask) => ask.ownerAgentId === agentId && ask.status === "in_progress");
    return Promise.all(held.map((ask) => this.store.update(ask.workspaceId, ask.id, { status: "open" })));
  }

  /** Reopen in-progress asks whose owner is not running and has left them untouched for a day. */
  async reopenStale(isRunning: (agentId: string) => Promise<boolean>, now = new Date()): Promise<Ask[]> {
    const running = new Map<string, boolean>();
    const reopened: Ask[] = [];
    for (const ask of this.store.list()) {
      if (ask.status !== "in_progress") continue;
      if (!running.has(ask.ownerAgentId)) running.set(ask.ownerAgentId, await isRunning(ask.ownerAgentId).catch(() => true));
      if (isStale(ask, now, running.get(ask.ownerAgentId)!))
        reopened.push(await this.store.update(ask.workspaceId, ask.id, { status: "open" }));
    }
    return reopened;
  }

  /** Queue a message about asks in general. The same text already waiting is not queued twice. */
  message(agentId: string, workspaceId: string, text: string): void {
    if (this.outbox.pending(agentId).some((entry) => entry.text === text)) return;
    this.outbox.enqueue({ agentId, workspaceId, text });
  }

  /** The human asks an agent to bring its asks up to date. Returns whether it went out now (steered into a running turn when possible) or waits for the turn to end. */
  async refresh(agentId: string): Promise<{ sent: boolean }> {
    const workspaceId = await this.workspaceOf(agentId);
    if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
    this.message(agentId, workspaceId, REFRESH);
    await this.outbox.flush(agentId);
    return { sent: this.outbox.pending(agentId).length === 0 };
  }

  /**
   * Requested changes the human holds back: an ask whose button starts the work, owned by the PR ask's agent.
   * One per round: a closed one comes back only when `newRound` (the review moved into changes requested again).
   */
  async raiseReview(prAsk: Ask, pr: PrState, { newRound }: { newRound: boolean }): Promise<Ask | null> {
    const raised = this.store
      .list(prAsk.workspaceId)
      // Another or a gone owner's ask can't take the work, so the button must reach this owner.
      .filter((ask) => ask.heldReview && ask.ownerAgentId === prAsk.ownerAgentId && !ask.orphaned && prUrlOf(ask) === pr.url);
    const open = raised.find((ask) => OPEN_STATUSES.includes(ask.status));
    if (open) return open;
    if (raised.length && !newRound) return null;
    const title = `Address review comments on PR #${pr.number}`;
    return this.store.create({
      heldReview: true,
      workspaceId: prAsk.workspaceId,
      ownerAgentId: prAsk.ownerAgentId,
      kind: "followup",
      title,
      body: `A reviewer requested changes on PR #${pr.number}. The agent has not been told: it starts on them when you press **Address review comments**.`,
      links: [{ label: `PR #${pr.number}`, url: pr.url }],
      actions: [{ label: "Address review comments", kind: "send", prompt: `Address the review comments on PR #${pr.number} (${pr.url}) and push` }],
    });
  }

  private async create(workspaceId: string, agentId: string, input: z.output<typeof CreateInput>, lastCall: string): Promise<Ask> {
    checkActions(input.actions);
    checkNotBundled(input.title, input.actions.map((action) => action.label));
    if (input.kind === "decision" && input.actions.filter((action) => action.kind === "resolve").length < 2) {
      throw new Error('A decision needs at least two "resolve" actions, one per option');
    }
    const ask: NewAsk = { ...input, workspaceId, ownerAgentId: agentId, lastCall };
    return this.store.create(ask);
  }

  /** A failed check never blocks the ask: the body goes through as written. */
  private async paths(workspaceId: string, body: string | undefined): Promise<{ body: string | undefined; notes: string[] }> {
    if (!body) return { body, notes: [] };
    try {
      return await this.checkPaths(workspaceId, body);
    } catch (error) {
      console.error("[asks] could not check file paths", error);
      return { body, notes: [] };
    }
  }

  /** Ids a reply may name to show its wait is recorded: the workspace's open asks, and the open ask the agent explains. */
  openAskIds(agentId: string, workspaceId: string): Set<string> {
    return new Set(
      [...this.store.list(workspaceId), ...this.discussing(agentId)]
        .filter((ask) => OPEN_STATUSES.includes(ask.status))
        .map((ask) => ask.id),
    );
  }

  /** The discussion agent is archived: its asks drop the link, so their cards stop pointing at it and Discuss starts afresh. */
  async endDiscussion(agentId: string): Promise<Ask[]> {
    return Promise.all(
      this.discussing(agentId).map((ask) =>
        this.store.update(ask.workspaceId, ask.id, { discussionAgentId: undefined, discussionWorkspaceId: undefined }, { touch: false }),
      ),
    );
  }

  /** Asks this agent was opened to discuss, in any workspace. */
  discussing(agentId: string): Ask[] {
    return this.store.list().filter((ask) => ask.discussionAgentId === agentId);
  }

  /**
   * The ask an agent's call names. The one it was opened to discuss comes first, wherever it lives: an explainer works
   * from a workspace of its own. Only that link reaches across workspaces.
   */
  private find(workspaceId: string, agentId: string, id: string): Ask {
    return this.discussing(agentId).find((ask) => ask.id === id) ?? this.require(workspaceId, id);
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

function render(ask: Ask, notes: string[] = []): ToolResult {
  const actions = ask.actions.map((action) => `${action.id} ${action.kind} "${action.label}"`).join(", ");
  const paths = notes.length ? `\nfile paths: ${notes.join(" ")}` : "";
  return { text: `${summary(ask)}${actions ? `\nactions: ${actions}` : ""}${paths}`, ask: { workspaceId: ask.workspaceId, id: ask.id } };
}
