import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

import { parseAsksMessage } from "../shared/messages";
import { NUDGE, REFRESH, parseStuckReminder } from "../shared/prompts";

/** How many of an agent's latest human messages the nudge classifier sees. */
const KEEP = 3;
// Pasted logs and diffs usually come first and the instruction last, so keep both ends.
const HEAD_CHARS = 1_000;
const TAIL_CHARS = 3_000;

/**
 * Each agent's latest messages from the human, across turns, so the nudge classifier can tell a reply that restates
 * what the human already decided ("no PR until I've tested it", said a turn earlier) from a new follow-up.
 */
export class HumanMessages {
  private readonly path: string;
  private readonly byAgent: Record<string, string[]>;

  constructor(root: string) {
    this.path = join(root, "human-messages.json");
    this.byAgent = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }

  get(agentId: string): string[] {
    return this.byAgent[agentId] ?? [];
  }

  /** Adds the human's messages from a finished turn and returns the agent's latest ones, oldest first. */
  record(agentId: string, turn: readonly AgentTimelineItem[]): string[] {
    const added = turn.flatMap((item) => (item.type === "user_message" ? humanText(item.text) : []));
    if (!added.length) return this.get(agentId);
    const kept = [...this.get(agentId), ...added].slice(-KEEP);
    this.byAgent[agentId] = kept;
    writeFileSync(this.path, JSON.stringify(this.byAgent));
    return kept;
  }
}

/**
 * What the human said in a user message, or nothing when the plugin or another agent wrote it. An `[asks]` answer
 * becomes what the human did with the ask ("A3 (Merge PR #30): chose “Merge”"); reminders and PR updates are dropped.
 */
export function humanText(text: string): string[] {
  if (text.includes(NUDGE) || text.startsWith(REFRESH) || parseStuckReminder(text)) return [];
  // Messages from other agents (a side chat's explainer, a parent) arrive wrapped by the host.
  if (text.trimStart().startsWith("<paseo-system")) return [];
  if (!text.startsWith("[asks]")) return [clip(text)];
  const asks = parseAsksMessage(text);
  if (!asks) return [clip(text)];
  if (asks.event.startsWith("PR #")) return [];
  const what = `${asks.askId} (${asks.title}): ${asks.event}${asks.note ? `: ${asks.note}` : ""}`;
  return [clip(what)];
}

export function clip(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n[…]\n${text.slice(-TAIL_CHARS)}`;
}
