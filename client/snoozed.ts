import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { applyWorkspaceChange, snoozedIds } from "../shared/snooze";

let current: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(next: ReadonlySet<string>) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ids of workspaces the user has snoozed, kept live while the plugin runs. Empty on hosts without snooze. */
export function useSnoozedWorkspaceIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => current);
}

/** Observes workspaces so counters can leave snoozed ones out. Call from `contribute`; returns the cleanup. */
export function observeSnoozedWorkspaces(client: PluginClientContext, tag: string): () => void {
  let stopped = false;
  let release: (() => void) | undefined;
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      const unsubscribe = subscription.subscribe({
        snapshot: ({ entries }) => publish(snoozedIds(entries)),
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          publish(
            applyWorkspaceChange(
              current,
              update.kind === "upsert"
                ? { kind: "upsert", workspace: update.workspace }
                : { kind: "remove", id: update.id },
            ),
          );
        },
      });
      release = () => {
        unsubscribe();
        void subscription.release().catch(() => undefined);
      };
      if (stopped) release();
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error(`[${tag}] workspace observation failed`, error);
    });
  return () => {
    stopped = true;
    release?.();
    publish(new Set());
  };
}
