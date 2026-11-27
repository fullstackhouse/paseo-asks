import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { actOnAsk, UNDO_WINDOW_MS, type ActVerb, type Ask } from "../shared/asks";
import { asksChanged } from "./changes";
import { writeDraft } from "./drafts";

/** A toast button; FSH hosts from fullstackhouse/paseo#311 draw it, older ones show the message alone. Typed locally until the npm SDK has it. */
type ToastWithAction = {
  show(
    message: string,
    options?: { variant?: "default" | "warning"; durationMs?: number; action?: { label: string; onPress(): void } },
  ): (() => void) | void;
  error(message: string): void;
};

export type DoneVerb = Exclude<ActVerb, "undo">;

function doneMessage(ask: Ask, verb: DoneVerb, actionId: string | undefined, notified: boolean): string {
  const label = ask.actions.find((action) => action.id === actionId)?.label;
  const what = {
    action: `Chose “${label ?? "?"}”`,
    done: "Marked done",
    drop: "Dropped",
    reply: "Replied",
    reopen: "Taken over",
    remind: "Reminded the agent",
  }[verb];
  return notified ? `${what} on ${ask.id}.` : `${what} on ${ask.id}; its agent is gone, so nobody was told.`;
}

/**
 * After an act lands: a toast saying what you did, with Undo while the act's message to the agent still waits
 * (`UNDO_HOLD_MS` on the server). Undo puts the ask back as it was, and the agent never hears of it.
 */
export interface Done {
  actionId?: string;
  /** The text sent with the act; Undo puts it back in the reply box. */
  note?: string;
  notified: boolean;
}

export function useUndoToast(): (ask: Ask, verb: DoneVerb, done: Done) => void {
  const act = useRpc(actOnAsk);
  const queryClient = useQueryClient();
  const toast = useToast() as ToastWithAction;
  return useCallback(
    (ask, verb, { actionId, note, notified }) => {
      const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: ["asks"] });
        asksChanged();
      };
      const undo = () =>
        void act({ workspaceId: ask.workspaceId, id: ask.id, verb: "undo" }).then(
          () => {
            if (note) writeDraft(ask.workspaceId, ask.id, note);
            refresh();
            toast.show(`Undone: ${ask.id} is as it was.`);
          },
          (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
        );
      toast.show(doneMessage(ask, verb, actionId, notified), {
        variant: notified ? "default" : "warning",
        durationMs: UNDO_WINDOW_MS,
        action: { label: "Undo", onPress: undo },
      });
    },
    [act, queryClient, toast],
  );
}
