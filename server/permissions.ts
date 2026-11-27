import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

/**
 * A prompt to run one of the asks tools. `tool` is the host's provider-neutral name for it
 * (fullstackhouse/paseo#288); without it, Claude names the tool and Codex asks to approve the server's call.
 */
export function isAsksPermission(
  request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">,
  tool?: { server: string },
): boolean {
  if (request.kind !== "tool") return false;
  if (tool) return tool.server === "asks";
  // COMPAT(pluginToolGrants): hosts before #288 send no `tool`. Remove after 2027-05-31.
  if (request.name.startsWith("mcp__asks__")) return true;
  return request.name === "CodexMcpElicitation" && request.metadata?.serverName === "asks";
}
