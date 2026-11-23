import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { TimelinePosition } from "../shared/asks";

/** Opens an agent's chat; with a position, scrolled to that timeline entry. */
export type OpenAgent = (agentId: string, position?: TimelinePosition) => void;

type Navigation = NonNullable<PluginScreenProps["navigation"]>;

// COMPAT(openAgentTimelinePosition): FSH hosts scroll the chat to `timelinePosition`; the npm SDK has no type for it,
// and older hosts ignore it and open the chat at its end. Drop the cast when the SDK pin includes it.
type OpenAgentWithPosition = (input: { agentId: string; timelinePosition?: TimelinePosition }) => void;

export function agentOpenerFor(navigation: Navigation): OpenAgent {
  return (agentId, position) =>
    (navigation.openAgent as OpenAgentWithPosition)(position ? { agentId, timelinePosition: position } : { agentId });
}
