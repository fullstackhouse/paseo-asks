import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

/** A prompt to run one of the asks tools: Claude names the tool, Codex asks to approve the MCP server's call. */
export function isAsksPermission(request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">): boolean {
  if (request.kind !== "tool") return false;
  if (request.name.startsWith("mcp__asks__")) return true;
  return request.name === "CodexMcpElicitation" && request.metadata?.serverName === "asks";
}
