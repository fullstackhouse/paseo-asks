import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const displaySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ foldChatBodies: z.boolean().default(false) }),
});

export const reviewSettings = defineSettings({
  id: "reviews",
  scope: "host",
  version: 1,
  // Off: "changes requested" on a subscribed PR raises an ask instead of telling the agent.
  schema: z.object({ actOnReviewChanges: z.boolean().default(true) }),
});
