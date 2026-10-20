import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

/** Sent once when a turn ends on a question to the human that no ask records. */
export const NUDGE =
  '[asks] Your last reply asks the human something, but no ask records it, so it is easy to miss. If you are waiting on them, call ask_create now (one per item) and reply with just the id. If you are not, reply "no ask" and nothing else.';

/** Sent when the human presses Refresh on an agent's asks. */
export const REFRESH =
  "[asks] The human wants your asks up to date. Run ask_list with scope mine. Create an ask for anything you are waiting on them for that has none, and ask_update or ask_resolve the ones that are out of date. Then reply in one line.";

const ASK_TOOL = /(^|[_.])ask_(create|update|resolve|list)$/;
const ASK_ID = /\bA\d+\b/;

/**
 * Whether a finished turn ended with a question to the human and never touched asks.
 * Turns that answer the nudge itself are never nudged again.
 */
export function shouldNudge(timeline: readonly AgentTimelineItem[]): boolean {
  const reply: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message") {
      if (item.text.includes(NUDGE)) return false;
      break;
    }
    if (item.type === "tool_call" && ASK_TOOL.test(item.name)) return false;
    if (item.type === "assistant_message") reply.unshift(item.text);
  }
  const text = reply.join("");
  return !ASK_ID.test(text) && endsWithQuestion(text);
}

/** The last paragraph has a question mark outside code and links. */
export function endsWithQuestion(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  const last = prose.split(/\n\s*\n/).pop() ?? "";
  return last.includes("?");
}
