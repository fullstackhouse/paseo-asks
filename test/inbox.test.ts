import { describe, expect, it, vi } from "vitest";
import { inboxReview } from "../client/inbox";

describe("inboxReview", () => {
  it("opens the Inbox review screen for a PR link", () => {
    const openPluginScreen = vi.fn();
    const hasPluginScreen = vi.fn(() => true);
    inboxReview({ navigation: { openPluginScreen, hasPluginScreen } })!("https://github.com/acme/shop/pull/7");
    expect(hasPluginScreen).toHaveBeenCalledWith({ pluginId: "paseo-inbox", screenId: "review" });
    expect(openPluginScreen).toHaveBeenCalledWith({
      pluginId: "paseo-inbox",
      screenId: "review",
      params: { pr: "https://github.com/acme/shop/pull/7" },
    });
  });

  it("is undefined without the Inbox or on a host that can't open another plugin's screen", () => {
    expect(inboxReview({ navigation: { openPluginScreen: vi.fn(), hasPluginScreen: () => false } })).toBeUndefined();
    expect(inboxReview({ navigation: { openAgent: vi.fn() } })).toBeUndefined();
    expect(inboxReview({})).toBeUndefined();
  });

  it("opens the review as a tab in the workspace the props name", () => {
    const openPluginScreen = vi.fn();
    const navigation = { openPluginScreen, hasPluginScreen: () => true };
    inboxReview({ navigation, workspaceId: "ws-1" })!("acme/shop#7");
    expect(openPluginScreen).toHaveBeenCalledWith({
      pluginId: "paseo-inbox",
      screenId: "review",
      params: { pr: "acme/shop#7" },
      workspaceId: "ws-1",
    });
  });
});
