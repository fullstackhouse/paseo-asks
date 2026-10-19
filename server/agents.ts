import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
