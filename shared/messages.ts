import { z } from "zod";
import { NUDGE, REFRESH } from "./prompts";

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
