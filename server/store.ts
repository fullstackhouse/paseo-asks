import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Action, Ask } from "../shared/asks";

interface WorkspaceFile {
  nextId: number;
  asks: Ask[];
}

export type NewAsk = Pick<Ask, "workspaceId" | "ownerAgentId" | "kind" | "title" | "body" | "links" | "subscribe"> & {
  actions: Omit<Action, "id">[];
};

export type AskPatch = Partial<
  Pick<Ask, "title" | "body" | "links" | "status" | "outcome" | "orphaned" | "ownerAgentId" | "subscribe" | "pr" | "discussionAgentId">
> & {
  actions?: Omit<Action, "id">[];
};

/** One JSON file per workspace. Single writer (the plugin process), so a per-file promise chain is enough. */
export class AskStore {
  private readonly dir: string;
  private readonly cache = new Map<string, WorkspaceFile>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string, private readonly now: () => Date = () => new Date()) {
    this.dir = join(root, "workspaces");
    mkdirSync(this.dir, { recursive: true });
  }

  list(workspaceId?: string): Ask[] {
    const ids = workspaceId ? [workspaceId] : this.workspaceIds();
    return ids.flatMap((id) => this.read(id).asks);
  }

  get(workspaceId: string, id: string): Ask | undefined {
    return this.read(workspaceId).asks.find((ask) => ask.id === id);
  }

  create(input: NewAsk): Promise<Ask> {
    return this.mutate(input.workspaceId, (file) => {
      const at = this.now().toISOString();
      const ask: Ask = {
        ...input,
        id: `A${file.nextId++}`,
        actions: withIds(input.actions),
        status: "open",
        createdAt: at,
        updatedAt: at,
      };
      file.asks.push(ask);
      return ask;
    });
  }

  /** `touch: false` for bookkeeping (a PR snapshot) that should not count as the ask changing. */
  update(workspaceId: string, id: string, patch: AskPatch, { touch = true } = {}): Promise<Ask> {
    return this.mutate(workspaceId, (file) => {
      const index = file.asks.findIndex((ask) => ask.id === id);
      if (index < 0) throw new Error(`No ask ${id} in this workspace`);
      const current = file.asks[index]!;
      const next: Ask = {
        ...current,
        ...patch,
        actions: patch.actions ? withIds(patch.actions) : current.actions,
        updatedAt: touch ? this.now().toISOString() : current.updatedAt,
      };
      file.asks[index] = next;
      return next;
    });
  }

  private workspaceIds(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => decodeURIComponent(name.slice(0, -".json".length)));
  }

  private path(workspaceId: string): string {
    return join(this.dir, `${encodeURIComponent(workspaceId)}.json`);
  }

  private read(workspaceId: string): WorkspaceFile {
    const cached = this.cache.get(workspaceId);
    if (cached) return cached;
    const path = this.path(workspaceId);
    const file: WorkspaceFile = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { nextId: 1, asks: [] };
    this.cache.set(workspaceId, file);
    return file;
  }

  private mutate<T>(workspaceId: string, change: (file: WorkspaceFile) => T): Promise<T> {
    const run = async () => {
      const draft: WorkspaceFile = structuredClone(this.read(workspaceId));
      const result = change(draft);
      const path = this.path(workspaceId);
      writeFileSync(`${path}.tmp`, JSON.stringify(draft, null, 2));
      renameSync(`${path}.tmp`, path);
      this.cache.set(workspaceId, draft);
      return result;
    };
    const next = (this.locks.get(workspaceId) ?? Promise.resolve()).then(run, run);
    this.locks.set(workspaceId, next.catch(() => undefined));
    return next;
  }
}

function withIds(actions: Omit<Action, "id">[]): Action[] {
  return actions.map((action, index) => ({ ...action, id: `a${index + 1}` }));
}
