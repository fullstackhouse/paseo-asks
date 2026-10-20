import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { execCommand } from "@getpaseo/plugin/server";

/** Sent once when a turn ends on a question to the human that no ask records. */
export const NUDGE =
  '[asks] Your last reply asks the human something, but no ask records it, so it is easy to miss. If you are waiting on them, call ask_create now (one per item) and reply with just the id. If you are not, reply "no ask" and nothing else.';

/** Sent when the human presses Refresh on an agent's asks. */
export const REFRESH =
  "[asks] The human wants your asks up to date. Run ask_list with scope mine. Create an ask for anything you are waiting on them for that has none, and ask_update or ask_resolve the ones that are out of date. Then reply in one line.";

const ASK_TOOL = /(^|[_.])ask_(create|update|resolve|list)$/;
const ASK_ID = /\bA\d+\b/;

/** Decides whether a reply leaves something for the human. */
export type Classify = (reply: string) => Promise<boolean>;

/**
 * The final reply of a finished turn that never touched asks, or null when there is nothing to check.
 * Turns that answer the nudge itself are never checked.
 */
export function unrecordedReply(timeline: readonly AgentTimelineItem[]): string | null {
  const reply: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message") {
      if (item.text.includes(NUDGE)) return null;
      break;
    }
    if (item.type === "tool_call" && ASK_TOOL.test(item.name)) return null;
    if (item.type === "assistant_message") reply.unshift(item.text);
  }
  const text = reply.join("").trim();
  return text && !ASK_ID.test(text) ? text : null;
}

/** Whether a finished turn left something for the human and never recorded it. Falls back to a question mark check when the classifier fails. */
export async function shouldNudge(timeline: readonly AgentTimelineItem[], classify?: Classify): Promise<boolean> {
  const reply = unrecordedReply(timeline);
  if (!reply) return false;
  if (!classify) return endsWithQuestion(reply);
  try {
    return await classify(reply);
  } catch {
    return endsWithQuestion(reply);
  }
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

// The daemon is often launched from the Dock with a bare PATH, so look where claude usually lives.
const CLAUDE_CANDIDATES = [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

export function findClaude(): string | null {
  return CLAUDE_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

const CLASSIFIER_PROMPT =
  'You read the final reply a coding agent sent to its human. Answer "yes" if the reply leaves anything for the human to do or decide: a question, a choice, a decision, an approval, a review, a merge, or a manual step. Answer "no" if it only reports. Answer with one word.';
// Long replies: the request for the human is almost always near the end.
const MAX_REPLY_CHARS = 8_000;

/** Asks Haiku through the Claude Code CLI, which reuses the user's login. Throws when it cannot answer. */
export function claudeClassifier(claude: string): Classify {
  return async (reply) => {
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    const { stdout } = await execCommand(
      claude,
      [
        "-p",
        "--model",
        "haiku",
        "--system-prompt",
        CLASSIFIER_PROMPT,
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--",
        reply.slice(-MAX_REPLY_CHARS),
      ],
      { timeout: 60_000, env, cwd: homedir() },
    );
    const answer = stdout.trim().toLowerCase();
    if (answer.startsWith("yes")) return true;
    if (answer.startsWith("no")) return false;
    throw new Error(`Unexpected classifier answer: ${stdout}`);
  };
}
