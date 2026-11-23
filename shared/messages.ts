import { z } from "zod";
import { NUDGE, REFRESH, parseStuckReminder } from "./prompts";
import { PR_BUTTON_LABELS } from "./prs";
import { DROPPED_LATER, LATER_ANSWER_HEAD } from "./questions";

/** The plugin timeline item that stands in for an `[asks]` message sent to the agent: what the human did, without the agent's instructions. */
export const ASKS_MESSAGE = { kind: "asks-message", version: 1 } as const;

export const AsksMessageSchema = z.object({
  askId: z.string().optional(),
  title: z.string().optional(),
  /** What happened, as a short phrase: "replied", "chose “Merge”", "PR #30 merged". */
  event: z.string(),
  /** The human's own words, or a side chat's summary. */
  note: z.string().optional(),
});
export type AsksMessage = z.infer<typeof AsksMessageSchema>;

// Each pattern mirrors a message built in server/service.ts or server/watcher.ts; test/messages.test.ts drives the server to keep them in step.
// Titles can hold anything, so each pattern anchors on the text that follows the title.
const NOTE = String.raw`(?: Note from the human: "([\s\S]*)")?`;
const PATTERNS: { re: RegExp; view: (m: RegExpMatchArray) => Omit<AsksMessage, "askId" | "title"> }[] = [
  {
    re: new RegExp(String.raw`^\((.*?)\) reply from the human: "([\s\S]*)"\. Update or resolve A\d+ accordingly\.$`),
    view: (m) => ({ event: "replied", note: m[2] }),
  },
  {
    re: new RegExp(String.raw`^\((.*?)\) answered by the human: "([\s\S]*)"\. A\d+ is done; act on the answer without resolving it\.$`),
    view: (m) => ({ event: "replied", note: m[2] }),
  },
  {
    re: new RegExp(String.raw`^\((.*?)\) resolved: ([\s\S]*?)\.${NOTE}$`),
    view: (m) => ({ event: `chose “${m[2]}”`, note: m[3] }),
  },
  {
    re: new RegExp(String.raw`^\((.*?)\) marked done by the human\.${NOTE}$`),
    view: (m) => ({ event: "marked done", note: m[2] }),
  },
  {
    re: new RegExp(String.raw`^\((.*?)\) dropped by the human; do not pursue it\.${NOTE}$`),
    view: (m) => ({ event: "dropped", note: m[2] }),
  },
  {
    re: /^\((.*?)\) resolved in a side chat(?:: ([\s\S]*?))?\.(?: Summary: ([\s\S]*))?$/,
    view: (m) => ({ event: m[2] ? `resolved in a side chat: “${m[2]}”` : "resolved in a side chat", note: m[3] }),
  },
  {
    re: /^\((.*?)\) marked ([a-z ]+) in a side chat\.$/,
    view: (m) => ({ event: `marked ${m[2]} in a side chat` }),
  },
  {
    re: /^\((.*?)\) (PR #\d+ [^.]*)\.$/,
    view: (m) => ({ event: m[2] }),
  },
  {
    re: new RegExp(String.raw`^\((.*?)\) "([^"]*)": [\s\S]*?\.${NOTE} When it is done, call ask_resolve for A\d+\.`),
    view: (m) => ({ event: `chose “${m[2]}”`, note: m[3] }),
  },
];

/** The readable view of an `[asks]` message, or undefined for any other text. */
export function parseAsksMessage(text: string): AsksMessage | undefined {
  if (text === NUDGE) return { event: "Reminded the agent to record what it needs from you as asks" };
  if (text === REFRESH) return { event: "Asked the agent to bring its asks up to date" };
  if (text.startsWith(LATER_ANSWER_HEAD))
    return { event: "Answered a question you put off", note: text.slice(LATER_ANSWER_HEAD.length).trim() };
  if (text.startsWith(DROPPED_LATER))
    return { event: "Dismissed a question you put off", note: text.slice(DROPPED_LATER.length).trim() };
  const stuck = parseStuckReminder(text);
  if (stuck?.length === 1) return { askId: stuck[0].id, title: stuck[0].title, event: "Left in progress; asked the agent to hand it back or resolve it" };
  if (stuck?.length) return { event: `Left ${stuck.map((ask) => ask.id).join(", ")} in progress; asked the agent to hand them back or resolve them` };
  const pr = parsePrMessage(text);
  if (pr) return pr;
  const head = text.match(/^\[asks\] (A\d+) ([\s\S]*)$/);
  if (!head) return undefined;
  const [, askId, rest] = head;
  for (const { re, view } of PATTERNS) {
    const match = rest.match(re);
    // Timeline item data must be JSON-compatible, so absent parts are left out rather than undefined.
    if (match) return JSON.parse(JSON.stringify({ askId, title: match[1], ...view(match) })) as AsksMessage;
  }
  return undefined;
}

const PR_BUTTON = new RegExp(`^\\[asks\\] (${Object.values(PR_BUTTON_LABELS).join("|")}): [\\s\\S]*?\\bPR #(\\d+)\\b`);

/** A PR card's button press ("[asks] Merge: Merge PR #30 …") or a PR change ("[asks] PR #30 merged."), as the human reads it. */
function parsePrMessage(text: string): AsksMessage | undefined {
  const button = text.match(PR_BUTTON);
  if (button) {
    const note = text.match(/ Note from the human: "([\s\S]*)"$/)?.[1];
    return JSON.parse(JSON.stringify({ title: `PR #${button[2]}`, event: `chose “${button[1]}”`, note })) as AsksMessage;
  }
  const change = text.match(/^\[asks\] PR #(\d+) ([\s\S]*)\.$/);
  if (!change) return undefined;
  // "checks failing: fix them and push; merged" reads "checks failing, merged": the instructions are for the agent.
  const event = change[2].split("; ").map((part) => part.split(":")[0]).join(", ");
  return { title: `PR #${change[1]}`, event };
}
