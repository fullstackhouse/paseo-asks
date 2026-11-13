import { createContext } from "react";

/**
 * paseo-inbox's review screen, opened by PR link: it shows that PR's newest review, or offers to start one.
 * Needs a host whose cards and popovers get `navigation.openPluginScreen` (the FSH build). @getpaseo/plugin 0.15
 * has no type for it yet, hence the local one; drop it once the SDK ships `openPluginScreen`.
 */
interface ScreenNavigation {
  openPluginScreen?(input: { pluginId: string; screenId: string; params?: Record<string, string> }): void;
  hasPluginScreen?(input: { pluginId: string; screenId: string }): boolean;
}

export type OpenPr = (prUrl: string) => void;

const REVIEW = { pluginId: "paseo-inbox", screenId: "review" } as const;

/** Opens a PR in the Inbox, or undefined when the host or the Inbox can't. */
export function inboxReview(props: object): OpenPr | undefined {
  const navigation = (props as { navigation?: ScreenNavigation }).navigation;
  const open = navigation?.openPluginScreen;
  if (!open || !navigation.hasPluginScreen?.(REVIEW)) return undefined;
  return (prUrl) => open({ ...REVIEW, params: { pr: prUrl } });
}

/** Set by each entry point from its own `navigation`, so every ask card below it can open its PR. */
export const OpenPrContext = createContext<OpenPr | undefined>(undefined);
