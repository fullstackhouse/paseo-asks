import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PrStateSchema, type Deployment, type PrState } from "../shared/asks";
import {
  DONE_KEPT_MS,
  PrPressSchema,
  describeCardChange,
  prFingerprint,
  prPrompt,
  prRules,
  type PrButtonId,
  type PrCard,
} from "../shared/prs";
import { RateLimited } from "./gh";

const EntrySchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  agentId: z.string().nullable(),
  pr: PrStateSchema,
  pressed: PrPressSchema.optional(),
  /** When preview deployments were last read; unset until the first read. */
  deploymentsAt: z.string().optional(),
  /** When the PR was first seen merged or closed: done cards fold away a day later. */
  doneAt: z.string().optional(),
  updatedAt: z.string(),
});
type Entry = z.infer<typeof EntrySchema>;

/** A workspace's PR as the daemon reports it this pass; null when its branch has none. */
export interface WorkspacePr {
  workspaceId: string;
  pr: (PrState & { title: string }) | null;
}

export interface BoardAgent {
  id: string;
  workspaceId?: string | null;
  status: string;
  archivedAt?: string | null;
  updatedAt: string;
  lastUserMessageAt?: string | null;
}

export interface PrBoardDeps {
  /** Preview deployments of the PR's head commit (1 GraphQL point); null when gh is missing. */
  fetchDeployments: ((url: string) => Promise<Deployment[]>) | null;
  /** Queue a message for an agent through the outbox (held while it waits on a question, steered or sent at turn end). */
  message(agentId: string, workspaceId: string, text: string): void;
  /** Send what is queued for the agent now if it can take it; true when nothing is left waiting. */
  flush(agentId: string): Promise<boolean>;
  /** An agent that owns an open PR ask for this PR, the old way: it is the PR's agent. */
  legacyOwner(url: string): string | undefined;
  /** An open, subscribed PR ask links this PR: the old watcher tells its owner already. */
  legacySubscribed(url: string): boolean;
  now?: () => Date;
}

// Deployments are the only GitHub reads here. Read them when the PR's state changes (often a new commit), every
// minute while one deploys, and otherwise every 10 minutes: an open PR costs about 6 GraphQL points an hour.
const DEPLOYING_EVERY_MS = 60_000;
const DEPLOYMENTS_EVERY_MS = 10 * 60_000;

/**
 * Every visible workspace's PR, on disk, with what the human last pressed. The daemon's own PR polling is the source:
 * `sync` takes its snapshot each pass, tells the PR's agent what it must act on, and keeps preview deployments fresh.
 */
export class PrBoard {
  private readonly path: string;
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => Date;

  constructor(
    root: string,
    private readonly deps: PrBoardDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.path = join(root, "prs.json");
    const saved = existsSync(this.path) ? z.array(EntrySchema).safeParse(JSON.parse(readFileSync(this.path, "utf8"))) : null;
    for (const entry of saved?.success ? saved.data : []) this.entries.set(entry.url, entry);
  }

  /**
   * One pass over the visible workspaces. Workspaces missing from `workspaces` are archived or background: their
   * cards go. `actOnReviewChanges` off holds requested changes for the human instead of telling the agent.
   */
  async sync(workspaces: readonly WorkspacePr[], agents: readonly BoardAgent[], actOnReviewChanges: boolean): Promise<void> {
    const at = this.now().toISOString();
    const seen = new Set<string>();
    const refresh: Entry[] = [];
    for (const { workspaceId, pr } of workspaces) {
      if (!pr) continue;
      seen.add(pr.url);
      const before = this.entries.get(pr.url);
      const { title, ...state } = pr;
      const agentId = this.agentFor(pr.url, workspaceId, before?.agentId ?? null, agents);
      const entry: Entry = {
        url: pr.url,
        workspaceId,
        title,
        agentId,
        // The daemon's snapshot has no deployments; keep the last ones read.
        pr: { ...state, deployments: before?.pr.deployments },
        pressed: before?.pressed,
        deploymentsAt: before?.deploymentsAt,
        doneAt: state.state === "OPEN" ? undefined : (before?.doneAt ?? at),
        updatedAt: before && prFingerprint(before.pr) === prFingerprint(state) && before.title === title ? before.updatedAt : at,
      };
      this.entries.set(pr.url, entry);
      if (before && agentId && !this.deps.legacySubscribed(pr.url)) {
        const change = describeCardChange(before.pr, entry.pr, { review: actOnReviewChanges });
        if (change) this.deps.message(agentId, workspaceId, change);
      }
      if (this.deploymentsDue(entry, before)) refresh.push(entry);
    }
    for (const url of [...this.entries.keys()]) if (!seen.has(url)) this.entries.delete(url);
    this.save();
    for (const entry of refresh) {
      if (!this.deps.fetchDeployments) break;
      try {
        const deployments = await this.deps.fetchDeployments(entry.url);
        const current = this.entries.get(entry.url);
        if (current) Object.assign(current, { pr: { ...current.pr, deployments }, deploymentsAt: this.now().toISOString() });
      } catch (error) {
        // A spent quota fails the rest of the pass the same way; the next pass after the reset picks them up.
        if (error instanceof RateLimited) break;
        console.error(`[asks] deployments lookup failed for ${entry.url}`, error instanceof Error ? error.message : error);
      }
    }
    if (refresh.length) this.save();
  }

  /** Cards to show, with whose move it is now. Done PRs fold away a day after they merged or closed. */
  cards(agentStates: ReadonlyMap<string, "running" | "idle">, actOnReviewChanges: boolean, workspaceId?: string): PrCard[] {
    const now = this.now().getTime();
    return [...this.entries.values()]
      .filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
      .filter((entry) => !entry.doneAt || now - Date.parse(entry.doneAt) < DONE_KEPT_MS)
      .map((entry) => this.card(entry, agentStates, actOnReviewChanges))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  /** The human pressed a button: the PR's agent gets the instruction, and the card stops waiting until the PR changes. */
  async press(
    url: string,
    button: PrButtonId,
    note: string | undefined,
    agentStates: ReadonlyMap<string, "running" | "idle">,
    actOnReviewChanges: boolean,
  ): Promise<{ card: PrCard; sent: boolean }> {
    const entry = this.entries.get(url);
    if (!entry) throw new Error(`No PR card for ${url}`);
    const card = this.card(entry, agentStates, actOnReviewChanges);
    const offered = card.buttons.find((candidate) => candidate.id === button);
    if (!offered) throw new Error(`PR #${entry.pr.number} doesn't offer ${button} now; refresh and try again`);
    if (!entry.agentId) throw new Error(`No agent left in this workspace to act on PR #${entry.pr.number}`);
    const trimmed = note?.trim() || undefined;
    this.deps.message(entry.agentId, entry.workspaceId, prPrompt(button, entry.pr, trimmed));
    entry.pressed = { id: button, label: offered.label, note: trimmed, at: this.now().toISOString(), fingerprint: prFingerprint(entry.pr) };
    this.save();
    const sent = await this.deps.flush(entry.agentId);
    return { card: this.card(entry, agentStates, actOnReviewChanges), sent };
  }

  private card(entry: Entry, agentStates: ReadonlyMap<string, "running" | "idle">, actOnReviewChanges: boolean): PrCard {
    const agentState = entry.agentId ? (agentStates.get(entry.agentId) ?? "gone") : "gone";
    const rules = prRules({ pr: entry.pr, agentState, pressed: entry.pressed, actOnReviewChanges });
    return {
      url: entry.url,
      number: entry.pr.number,
      title: entry.title,
      workspaceId: entry.workspaceId,
      agentId: entry.agentId,
      agentState,
      pr: entry.pr,
      ...(entry.pressed ? { pressed: entry.pressed } : {}),
      ...rules,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * The PR's agent: the one already linked while it stays in the workspace, else the owner of an old PR ask for it,
   * else the workspace's most recently used agent. Neither the host nor gh says which agent opened or pushed a PR.
   */
  private agentFor(url: string, workspaceId: string, linked: string | null, agents: readonly BoardAgent[]): string | null {
    const here = agents.filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt);
    const alive = (id: string | null | undefined) => (id && here.some((agent) => agent.id === id) ? id : null);
    const recent = [...here].sort((a, b) => lastUsed(b).localeCompare(lastUsed(a)))[0];
    return alive(linked) ?? alive(this.deps.legacyOwner(url)) ?? recent?.id ?? null;
  }

  private deploymentsDue(entry: Entry, before: Entry | undefined): boolean {
    if (entry.pr.state !== "OPEN" || !this.deps.fetchDeployments) return false;
    if (!entry.deploymentsAt || !before || prFingerprint(before.pr) !== prFingerprint(entry.pr)) return true;
    const age = this.now().getTime() - Date.parse(entry.deploymentsAt);
    const deploying = entry.pr.deployments?.some((deployment) => deployment.state === "deploying");
    return age >= (deploying ? DEPLOYING_EVERY_MS : DEPLOYMENTS_EVERY_MS);
  }

  private save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 2));
    renameSync(tmp, this.path);
  }
}

function lastUsed(agent: BoardAgent): string {
  return agent.lastUserMessageAt ?? agent.updatedAt;
}
