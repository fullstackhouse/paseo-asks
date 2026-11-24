import * as hostUi from "@getpaseo/plugin/client/ui";
import type { View } from "react-native";

type Reveal = (target: View | null) => void;

// COMPAT(hostReveal): FSH hosts from fullstackhouse/paseo `useRevealInScroll` scroll the nearest host scroll
// container (the Asks sheet, side panel, popover or an SDK ScrollView) to a view; typed locally until the npm
// SDK has it. Older hosts leave the scroll where it is. Remove the fallback after 2027-03-01.
const noop: Reveal = () => {};
const hostReveal = (hostUi as { useRevealInScroll?: () => Reveal }).useRevealInScroll;
export const useRevealInScroll: () => Reveal = hostReveal ?? (() => noop);
