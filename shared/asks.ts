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

export const PrStateSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  mergeable: z.string(),
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
  /** Live state of the first GitHub PR in links, refreshed by the plugin. */
  pr: PrStateSchema.optional(),
  /** The side chat opened to talk this ask through. */
  discussionAgentId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ask = z.infer<typeof AskSchema>;

export const OPEN_STATUSES: readonly Ask["status"][] = ["open", "in_progress"];

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

/** Ask an agent to bring its asks up to date. Sent now if it is idle, otherwise when its turn ends. */
export const refreshAsks = defineRpc({
  name: "asks.refresh",
  input: z.object({ agentId: z.string() }),
  output: z.object({ sent: z.boolean() }),
});

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

export function prUrlOf(ask: Pick<Ask, "links">): string | undefined {
  return ask.links.map((link) => link.url).find((url) => PR_URL.test(url))?.match(PR_URL)?.[0];
}
