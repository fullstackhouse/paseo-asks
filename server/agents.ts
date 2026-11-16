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
  provider?: string;
  archivedAt?: string | null;
}

/** Providers whose MCP servers inherit PASEO_AGENT_ID, so their bridge never asks to be guessed. */
const SENDS_OWN_ID = new Set(["claude", "opencode"]);

/**
 * COMPAT(codex-agent-id): Paseo hosts before fullstackhouse/paseo#98 start Codex MCP servers without
 * PASEO_AGENT_ID, so their bridge sends only its working directory. Newer hosts forward the ID and never
 * reach this; remove it after 2027-03-01, once hosts without #98 are gone.
 * The caller is the live agent there that is mid-turn, among agents that can't identify themselves;
 * null when that is ambiguous.
 */
export function pickCaller(agents: readonly CallerCandidate[], cwd: string): string | null {
  const dir = absolute(cwd);
  const here = agents.filter(
    (agent) => !agent.archivedAt && !SENDS_OWN_ID.has(agent.provider ?? "") && absolute(agent.cwd) === dir,
  );
  const running = here.filter((agent) => agent.status === "running");
  if (running.length === 1) return running[0]!.id;
  return here.length === 1 ? here[0]!.id : null;
}

const absolute = (path: string) => resolve(path.replace(/^~(?=\/|$)/, homedir()));
