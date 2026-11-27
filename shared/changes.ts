import { z } from "zod";

export const AskChangesEventSchema = z.object({
  type: z.literal("changed"),
  /** Workspaces whose asks changed since the last event. */
  workspaceIds: z.array(z.string()),
});
export type AskChangesEvent = z.infer<typeof AskChangesEventSchema>;

/**
 * Pushes an event whenever an ask changes on the server, so clients re-read the asks at once instead of on their poll.
 * COMPAT(pluginSubscriptions): hosts from Paseo 0.15 serve a contract with `event` as a subscription, but the npm SDK
 * pin has no `defineSubscription`, so the contract is written out as the plain object that function returns. Clients
 * on hosts without `subscribe` keep polling.
 */
export const askChanges = {
  name: "asks.changes",
  input: z.object({}),
  event: AskChangesEventSchema,
} as const;
