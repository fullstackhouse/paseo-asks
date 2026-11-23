import { z } from "zod";
import { ASK_KINDS, ASK_STATUSES } from "./asks";

/**
 * The plugin timeline item that stands in for an asks tool call. The newest call on an ask shows the ask live, so it
 * can be answered in place; older ones show the ask as that call left it.
 */
export const ASK_CARD = { kind: "ask-card", version: 1 } as const;

const VERBS = ["create", "update", "resolve"] as const;
type Verb = (typeof VERBS)[number];

/** The ask as one tool call left it, read from the call's own input and result. Fields the call didn't show are absent. */
export const AskSnapshotSchema = z.object({
  kind: z.enum(ASK_KINDS).optional(),
  title: z.string().optional(),
  status: z.enum(ASK_STATUSES).optional(),
  body: z.string().optional(),
  actions: z.array(z.object({ label: z.string(), recommended: z.boolean().optional() })).optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
  /** resolve: the option the agent picked, and its note. */
  choice: z.string().optional(),
  note: z.string().optional(),
});
export type AskSnapshot = z.infer<typeof AskSnapshotSchema>;

export const AskCardSchema = z.object({
  askId: z.string(),
  verb: z.enum(VERBS),
  /** callKey() of the call; the card is live while it matches the ask's `lastCall`. */
  call: z.string(),
  snapshot: AskSnapshotSchema,
  /** update: what the call set ("title", "body", "options", "links", "status"). */
  changed: z.array(z.string()),
});
export type AskCard = z.infer<typeof AskCardSchema>;

/** The parts of a `tool_call` timeline item this reads. */
export interface ToolCallLike {
  name: string;
  status: string;
  detail: { type: string; input?: unknown; output?: unknown };
}

// Claude names it mcp__asks__ask_create; other providers join server and tool differently.
const TOOL = /asks.*ask_(create|update|resolve)$/;
// The tool result starts with the summary line, e.g. "A3 [open] decision: …", then "actions: a1 send "Merge", …"
// (see render() in server/service.ts).
const SUMMARY = /\b(A\d+) \[(\w+)\] (\w+): (.*)/;
const ACTION = /\b(a\d+) \w+ "([^"]*)"/g;

/**
 * Identifies one agent call on an ask: the verb and its arguments, key order ignored. The server stores it on the ask
 * as `lastCall`; the chat card computes it from the timeline's copy of the same arguments.
 */
export function callKey(verb: string, input: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of `${verb}:${canonical(parseInput(input))}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** The card to show instead of an asks tool call, or undefined to keep the row as it is (running, failed, other tools). */
export function askCardFor(item: ToolCallLike): AskCard | undefined {
  const verb = item.name.match(TOOL)?.[1] as Verb | undefined;
  if (!verb || item.status !== "completed") return undefined;
  const input = record(parseInput(item.detail.input));
  const text = outputText(item.detail.output);
  const summary = text.match(SUMMARY);
  const askId = verb === "create" ? summary?.[1] : typeof input.id === "string" ? input.id : undefined;
  if (!askId) return undefined;

  const snapshot: AskSnapshot = {};
  if (summary?.[1] === askId) {
    const [, , status, kind, title] = summary;
    if (isOneOf(ASK_STATUSES, status)) snapshot.status = status;
    if (isOneOf(ASK_KINDS, kind)) snapshot.kind = kind;
    snapshot.title = title!.trim();
  }
  const changed: string[] = [];
  if (verb === "resolve") {
    const labels = new Map([...text.matchAll(ACTION)].map(([, id, label]) => [id!, label!]));
    if (typeof input.actionId === "string") snapshot.choice = labels.get(input.actionId) ?? input.actionId;
    if (typeof input.note === "string" && input.note.trim()) snapshot.note = input.note;
  } else {
    if (typeof input.title === "string") changed.push("title");
    if (typeof input.body === "string") {
      snapshot.body = input.body;
      changed.push("body");
    }
    const actions = actionsOf(input.actions);
    if (actions) {
      snapshot.actions = actions;
      changed.push("options");
    }
    const links = linksOf(input.links);
    if (links) {
      snapshot.links = links;
      changed.push("links");
    }
    if (typeof input.status === "string") changed.push("status");
  }
  // Timeline item data must be JSON-compatible: absent fields are left out, never undefined.
  return { askId, verb, call: callKey(verb, item.detail.input), snapshot, changed: verb === "update" ? changed : [] };
}

/** Some providers hand the arguments over as a JSON string. */
function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The result text, however the provider wrapped it: a string (sometimes JSON), an MCP content array, or an object
 * holding either under a provider-specific key. Every string inside counts.
 */
function outputText(output: unknown): string {
  if (typeof output === "string") {
    const parsed = /^\s*[[{]/.test(output) ? parseInput(output) : output;
    return typeof parsed === "string" ? parsed : outputText(parsed);
  }
  if (Array.isArray(output)) return output.map(outputText).filter(Boolean).join("\n");
  if (output !== null && typeof output === "object") return outputText(Object.values(output));
  return "";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function actionsOf(value: unknown): AskSnapshot["actions"] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const { label, recommended } = record(entry);
    if (typeof label !== "string") return [];
    return recommended === true ? [{ label, recommended }] : [{ label }];
  });
}

function linksOf(value: unknown): AskSnapshot["links"] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const { label, url } = record(entry);
    return typeof label === "string" && typeof url === "string" ? [{ label, url }] : [];
  });
}

function isOneOf<T extends string>(values: readonly T[], value: string | undefined): value is T {
  return values.includes(value as T);
}
