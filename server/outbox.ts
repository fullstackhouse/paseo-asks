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
  /** Held until then, so the human can undo the act that queued it. */
  notBefore?: string;
  state: "pending" | "sent" | "failed";
  attempts: number;
  error?: string;
}

/** `steerable`: mid-turn, on a provider that takes a steer into the running turn instead of interrupting it. */
export type AgentState = "idle" | "steerable" | "running" | "gone";

/** Mid-turn, whether or not a message can join the turn. */
export const isWorking = (state: AgentState): boolean => state === "running" || state === "steerable";

export interface Courier {
  state(agentId: string): Promise<AgentState>;
  send(agentId: string, text: string, messageId: string): Promise<void>;
}

const MAX_ATTEMPTS = 5;

/** Why messages were given up on: the agent is gone, or every attempt to reach it failed. */
export type UndeliverableReason = "gone" | "failed";
const KEEP_DELIVERED = 200;

/**
 * Messages to agents, written to disk before any send. A message goes out batched, steered into a
 * running turn when the provider allows it. Otherwise it waits for the turn to end, since a send
 * mid-turn would interrupt it.
 */
export class Outbox {
  private readonly path: string;
  private entries: Delivery[];
  private flushing: Promise<void> = Promise.resolve();
  private seq = 0;
  /** Ids on their way to the agent: too late to cancel. */
  private readonly sending = new Set<string>();

  constructor(
    root: string,
    private readonly courier: Courier,
    private readonly onUndeliverable: (deliveries: Delivery[], reason: UndeliverableReason) => Promise<void> = async () => {},
    private readonly now: () => Date = () => new Date(),
    /** How long `enqueue(…, { hold: true })` holds a message. */
    readonly holdMs = 0,
  ) {
    this.path = join(root, "outbox.json");
    this.entries = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : [];
    for (const entry of this.pending()) if (entry.notBefore) this.flushAt(entry);
  }

  pending(agentId?: string): Delivery[] {
    return this.entries.filter((entry) => entry.state === "pending" && (!agentId || entry.agentId === agentId));
  }

  /** `hold`: keep it back for `holdMs`, so `cancel` can still take it back. */
  enqueue(input: Pick<Delivery, "agentId" | "workspaceId" | "askId" | "text">, { hold = false } = {}): Delivery {
    const now = this.now();
    const delivery: Delivery = {
      ...input,
      id: `${now.getTime().toString(36)}-${(this.seq++).toString(36)}`,
      createdAt: now.toISOString(),
      ...(hold && this.holdMs > 0 && { notBefore: new Date(now.getTime() + this.holdMs).toISOString() }),
      state: "pending",
      attempts: 0,
    };
    this.entries.push(delivery);
    this.save();
    if (delivery.notBefore) this.flushAt(delivery);
    return delivery;
  }

  /** Takes back messages that have not gone out. All or nothing: false, and nothing changes, if any has gone. */
  cancel(ids: readonly string[]): boolean {
    const entries = ids.map((id) => this.entries.find((entry) => entry.id === id));
    if (entries.some((entry) => entry?.state !== "pending" || this.sending.has(entry.id))) return false;
    this.entries = this.entries.filter((entry) => !ids.includes(entry.id));
    this.save();
    return true;
  }

  private flushAt(delivery: Delivery): void {
    const wait = Math.max(0, Date.parse(delivery.notBefore!) - this.now().getTime());
    setTimeout(() => void this.flush(delivery.agentId), wait).unref?.();
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
    const now = this.now().toISOString();
    for (const entry of this.pending(agentId)) {
      if (entry.notBefore && entry.notBefore > now) continue;
      byAgent.set(entry.agentId, [...(byAgent.get(entry.agentId) ?? []), entry]);
    }
    for (const [target, queued] of byAgent) {
      const state = await this.courier.state(target).catch(() => "idle" as const);
      // Cancelled while the state was read.
      const batch = queued.filter((entry) => this.entries.includes(entry));
      if (state === "running" || !batch.length) continue;
      if (state === "gone") {
        for (const entry of batch) Object.assign(entry, { state: "failed", error: "agent is gone" });
        this.save();
        await this.onUndeliverable(batch, "gone");
        continue;
      }
      for (const entry of batch) this.sending.add(entry.id);
      try {
        await this.courier.send(target, batch.map((entry) => entry.text).join("\n"), batch[0]!.id);
        for (const entry of batch) entry.state = "sent";
      } catch (error) {
        for (const entry of batch) {
          entry.attempts += 1;
          entry.error = error instanceof Error ? error.message : String(error);
          if (entry.attempts >= MAX_ATTEMPTS) entry.state = "failed";
        }
        this.save();
        const failed = batch.filter((entry) => entry.state === "failed");
        if (failed.length) await this.onUndeliverable(failed, "failed");
        continue;
      } finally {
        for (const entry of batch) this.sending.delete(entry.id);
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
