import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Delivery {
  id: string;
  agentId: string;
  workspaceId: string;
  /** Absent for messages about asks in general, such as the nudge or a refresh. */
  askId?: string;
  text: string;
  createdAt: string;
  state: "pending" | "sent" | "failed";
  attempts: number;
  error?: string;
}

export type AgentState = "idle" | "running" | "gone";

export interface Courier {
  state(agentId: string): Promise<AgentState>;
  send(agentId: string, text: string, messageId: string): Promise<void>;
}

const MAX_ATTEMPTS = 5;
const KEEP_DELIVERED = 200;

/**
 * Messages to agents, written to disk before any send. A message waits while its agent runs a
 * turn (a send mid-turn would interrupt it) and goes out batched once the agent is idle.
 */
export class Outbox {
  private readonly path: string;
  private entries: Delivery[];
  private flushing: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(
    root: string,
    private readonly courier: Courier,
    private readonly onGone: (deliveries: Delivery[]) => Promise<void> = async () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(root, "outbox.json");
    this.entries = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : [];
  }

  pending(agentId?: string): Delivery[] {
    return this.entries.filter((entry) => entry.state === "pending" && (!agentId || entry.agentId === agentId));
  }

  enqueue(input: Pick<Delivery, "agentId" | "workspaceId" | "askId" | "text">): Delivery {
    const delivery: Delivery = {
      ...input,
      id: `${this.now().getTime().toString(36)}-${(this.seq++).toString(36)}`,
      createdAt: this.now().toISOString(),
      state: "pending",
      attempts: 0,
    };
    this.entries.push(delivery);
    this.save();
    return delivery;
  }

  /** Delivers what can be delivered now. Calls are serialized so nothing is sent twice. */
  flush(agentId?: string): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow(agentId)).catch((error) => {
      console.error("[asks] outbox flush failed", error);
    });
    return this.flushing;
  }

  private async flushNow(agentId?: string): Promise<void> {
    const byAgent = new Map<string, Delivery[]>();
    for (const entry of this.pending(agentId)) {
      byAgent.set(entry.agentId, [...(byAgent.get(entry.agentId) ?? []), entry]);
    }
    for (const [target, batch] of byAgent) {
      const state = await this.courier.state(target).catch(() => "idle" as const);
      if (state === "running") continue;
      if (state === "gone") {
        for (const entry of batch) Object.assign(entry, { state: "failed", error: "agent is gone" });
        this.save();
        await this.onGone(batch);
        continue;
      }
      try {
        await this.courier.send(target, batch.map((entry) => entry.text).join("\n"), batch[0]!.id);
        for (const entry of batch) entry.state = "sent";
      } catch (error) {
        for (const entry of batch) {
          entry.attempts += 1;
          entry.error = error instanceof Error ? error.message : String(error);
          if (entry.attempts >= MAX_ATTEMPTS) entry.state = "failed";
        }
      }
      this.save();
    }
  }

  private save(): void {
    const pending = this.entries.filter((entry) => entry.state === "pending");
    const settled = this.entries.filter((entry) => entry.state !== "pending").slice(-KEEP_DELIVERED);
    this.entries = [...settled, ...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.entries, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
