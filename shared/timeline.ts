import { z } from "zod";

/** The plugin timeline item that stands in for an asks tool call: the ask itself, live. */
export const ASK_CARD = { kind: "ask-card", version: 1 } as const;

export const AskCardSchema = z.object({ askId: z.string(), verb: z.enum(["create", "update", "resolve"]) });
export type AskCard = z.infer<typeof AskCardSchema>;

/** The parts of a `tool_call` timeline item this reads. */
export interface ToolCallLike {
  name: string;
  status: string;
  detail: { type: string; input?: unknown; output?: unknown };
}

// Claude names it mcp__asks__ask_create; other providers join server and tool differently.
const TOOL = /asks.*ask_(create|update|resolve)$/;
// The tool result starts with the summary line, e.g. "A3 [open] decision: …" (see render() in server/service.ts).
const CREATED_ID = /\b(A\d+) \[/;

/** The card to show instead of an asks tool call, or undefined to keep the row as it is (running, failed, other tools). */
export function askCardFor(item: ToolCallLike): AskCard | undefined {
  const verb = item.name.match(TOOL)?.[1] as AskCard["verb"] | undefined;
  if (!verb || item.status !== "completed") return undefined;
  const { input, output } = item.detail;
  if (verb !== "create") {
    const id = (input as { id?: unknown } | undefined)?.id;
    return typeof id === "string" ? { askId: id, verb } : undefined;
  }
  // The output is a string or an MCP content array depending on the provider; search it as text.
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const id = text.match(CREATED_ID)?.[1];
  return id ? { askId: id, verb } : undefined;
}
