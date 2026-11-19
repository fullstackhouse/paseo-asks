import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ASK_KINDS = ["decision", "review", "pr", "followup", "action", "question"] as const;
export const ASK_STATUSES = ["open", "in_progress", "done", "dropped"] as const;
export const ACTION_KINDS = ["send", "resolve", "open"] as const;

export const ActionSchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(60),
  kind: z.enum(ACTION_KINDS),
  prompt: z.string().optional(),
  url: z.string().url().optional(),
  recommended: z.boolean().optional(),
});
export type Action = z.infer<typeof ActionSchema>;

export const LinkSchema = z.object({ label: z.string(), url: z.string().url() });

export const OutcomeSchema = z.object({
  actionId: z.string().optional(),
  label: z.string().optional(),
  note: z.string().optional(),
  by: z.enum(["human", "agent"]),
  at: z.string(),
});

/** A preview deployment of the PR's head commit, one per URL. `link` is where tapping it goes. */
export const DeploymentSchema = z.object({
  label: z.string(),
  state: z.enum(["ready", "deploying", "failed"]),
  url: z.string().optional(),
  link: z.string().optional(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export const PrStateSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  mergeable: z.string(),
  /** Unset when the deployments lookup failed or predates this field; empty when the head commit has none. */
  deployments: z.array(DeploymentSchema).optional(),
  fetchedAt: z.string(),
});
export type PrState = z.infer<typeof PrStateSchema>;

export const AskSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ownerAgentId: z.string(),
  kind: z.enum(ASK_KINDS),
  title: z.string(),
  body: z.string().optional(),
  actions: z.array(ActionSchema),
  links: z.array(LinkSchema),
  status: z.enum(ASK_STATUSES),
  outcome: OutcomeSchema.optional(),
  /** The owning agent is gone; nobody will hear about a resolution. */
  orphaned: z.boolean().optional(),
  /** Tell the owner when the linked PR changes (merged, closed, checks, review). */
  subscribe: z.boolean().optional(),
  /** Raised by the plugin for requested changes the human holds back; its PR is not polled for it. */
  heldReview: z.boolean().optional(),
  /** Live state of the first GitHub PR in links, refreshed by the plugin. */
  pr: PrStateSchema.optional(),
  /** When the owner was last reminded that this ask sat in progress at the end of its turn. */
  remindedAt: z.string().optional(),
  /** The side chat opened to talk this ask through. */
  discussionAgentId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ask = z.infer<typeof AskSchema>;

export const OPEN_STATUSES: readonly Ask["status"][] = ["open", "in_progress"];

/** Waits on the human: open. A linked PR's state says nothing about it; the owner closes the ask when its work is done. */
export function awaitsYou(ask: Pick<Ask, "status">): boolean {
  return ask.status === "open";
}

/** The sidebar counter: asks waiting on you, leaving out workspaces you snoozed. */
export function waitingCount(
  asks: readonly Pick<Ask, "status" | "workspaceId">[],
  snoozed: ReadonlySet<string>,
): number {
  return asks.filter((ask) => awaitsYou(ask) && !snoozed.has(ask.workspaceId)).length;
}

/** Per workspace: how many asks wait on you and the newest one's id, which changes when a new ask arrives. */
export function waitingByWorkspace(
  asks: readonly Pick<Ask, "id" | "status" | "workspaceId" | "createdAt">[],
): Map<string, { count: number; newestId: string }> {
  const result = new Map<string, { count: number; newestId: string; newestAt: string }>();
  for (const ask of asks) {
    if (!awaitsYou(ask)) continue;
    const entry = result.get(ask.workspaceId);
    if (!entry) result.set(ask.workspaceId, { count: 1, newestId: ask.id, newestAt: ask.createdAt });
    else {
      entry.count++;
      if (ask.createdAt > entry.newestAt) Object.assign(entry, { newestId: ask.id, newestAt: ask.createdAt });
    }
  }
  return new Map([...result].map(([id, { count, newestId }]) => [id, { count, newestId }]));
}

/** Asks wait in a queue: the one waiting longest comes first, and updates don't move an ask. */
export function oldestFirst(a: Pick<Ask, "createdAt">, b: Pick<Ask, "createdAt">): number {
  return a.createdAt.localeCompare(b.createdAt);
}

/** One waiting ask as the host's Overview lists it. */
export interface AskEntry {
  id: string;
  title: string;
  detail?: string;
}

/** A workspace's asks as the host summary shows them: what waits on you, oldest first, as the Asks panel orders them. */
export interface WorkspaceAsks {
  count: number;
  newestId?: string;
  entries: AskEntry[];
}

const KIND_LABELS: Record<Ask["kind"], string> = {
  decision: "Decision",
  review: "Review",
  pr: "PR",
  followup: "Follow-up",
  action: "Action",
  question: "Question",
};

/** A short facts line for an ask, e.g. "Decision · 2 options" or "PR #30". */
export function askDetail(ask: Pick<Ask, "kind" | "actions" | "pr" | "orphaned">): string {
  const options = ask.actions.filter((action) => action.kind === "resolve").length;
  const parts = [
    ask.kind === "pr" && ask.pr ? `PR #${ask.pr.number}` : KIND_LABELS[ask.kind],
    ask.kind === "decision" && options > 0 ? `${options} option${options === 1 ? "" : "s"}` : "",
    ask.orphaned ? "agent archived" : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Every workspace with any ask (any status), so one with nothing waiting reports 0 instead of nothing.
 * Like `waitingCount`, asks in snoozed workspaces don't wait on you.
 */
export function workspaceAsks(
  asks: readonly Pick<Ask, "id" | "title" | "kind" | "actions" | "pr" | "orphaned" | "status" | "workspaceId" | "createdAt">[],
  snoozed: ReadonlySet<string>,
): Map<string, WorkspaceAsks> {
  const result = new Map<string, WorkspaceAsks>();
  for (const ask of [...asks].sort(oldestFirst)) {
    let workspace = result.get(ask.workspaceId);
    if (!workspace) result.set(ask.workspaceId, (workspace = { count: 0, entries: [] }));
    if (!awaitsYou(ask) || snoozed.has(ask.workspaceId)) continue;
    workspace.count++;
    workspace.newestId = ask.id;
    workspace.entries.push({ id: ask.id, title: ask.title, detail: askDetail(ask) });
  }
  return result;
}

export const listAsks = defineRpc({
  name: "asks.list",
  input: z.object({ workspaceId: z.string().optional(), includeClosed: z.boolean().optional() }),
  output: z.object({
    asks: z.array(AskSchema),
    /** Workspace id → display name, filled when listing every workspace. */
    workspaceNames: z.record(z.string(), z.string()).optional(),
  }),
});

/** A human disposes of an ask: run one of its actions, mark it done, or drop it. */
export const actOnAsk = defineRpc({
  name: "asks.act",
  input: z.object({
    workspaceId: z.string(),
    id: z.string(),
    verb: z.enum(["action", "done", "drop", "reply"]),
    actionId: z.string().optional(),
    note: z.string().optional(),
  }),
  output: z.object({ ask: AskSchema, notified: z.boolean() }),
});

/** Open (or reopen) a read-only side chat about one ask; `note` is the human's first message to it. */
export const discussAsk = defineRpc({
  name: "asks.discuss",
  input: z.object({ workspaceId: z.string(), id: z.string(), note: z.string().optional() }),
  output: z.object({ agentId: z.string(), created: z.boolean() }),
});

/** Ask an agent to bring its asks up to date. Sent now if it is idle or can take a steer, otherwise when its turn ends. */
export const refreshAsks = defineRpc({
  name: "asks.refresh",
  input: z.object({ agentId: z.string() }),
  output: z.object({ sent: z.boolean() }),
});

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/** A GitHub PR's URL without trailing parts (`/files`, `#discussion…`), or undefined for any other link. */
export function prLinkOf(url: string): string | undefined {
  return url.match(PR_URL)?.[0];
}

/** The PR to preview in Paseo when this link is opened: only a bare PR URL. A comment, file or commit link opens on GitHub, since the preview can't show it. */
export function prPreviewOf(url: string): string | undefined {
  const pr = prLinkOf(url);
  return pr && /^\/?$/.test(url.slice(pr.length)) ? pr : undefined;
}

export function prUrlOf(ask: Pick<Ask, "links">): string | undefined {
  return ask.links.map((link) => prLinkOf(link.url)).find(Boolean);
}
