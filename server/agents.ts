import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** agentId → workspaceId, learned from lifecycle hooks and kept on disk, with a daemon lookup as fallback. */
export class AgentDirectory {
  private readonly path: string;
  private readonly known: Record<string, string>;

  constructor(root: string, private readonly lookup: (agentId: string) => Promise<string | null>) {
    this.path = join(root, "agents.json");
    this.known = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }

  remember(agentId: string, workspaceId: string): void {
    if (this.known[agentId] === workspaceId) return;
    this.known[agentId] = workspaceId;
    writeFileSync(this.path, JSON.stringify(this.known, null, 2));
  }

  async workspaceOf(agentId: string): Promise<string | null> {
    const known = this.known[agentId];
    if (known) return known;
    const found = await this.lookup(agentId);
    if (found) this.remember(agentId, found);
    return found;
  }
}

export interface CallerCandidate {
  id: string;
  cwd: string;
  status: string;
  archivedAt?: string | null;
}

/**
 * Codex starts MCP servers without the agent's environment, so its bridge has no PASEO_AGENT_ID, only
 * its working directory. The caller is the live agent there that is mid-turn; null when that is ambiguous.
 */
export function pickCaller(agents: readonly CallerCandidate[], cwd: string): string | null {
  const dir = absolute(cwd);
  const here = agents.filter((agent) => !agent.archivedAt && absolute(agent.cwd) === dir);
  const running = here.filter((agent) => agent.status === "running");
  if (running.length === 1) return running[0]!.id;
  return here.length === 1 ? here[0]!.id : null;
}

const absolute = (path: string) => resolve(path.replace(/^~(?=\/|$)/, homedir()));
