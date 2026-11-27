import { afterEach, describe, expect, it, vi } from "vitest";
import { asksChanged, onAsksChanged, watchAskChanges } from "../client/changes";
import { pushAskChanges } from "../server/changes";

describe("asks changed signal", () => {
  it("tells listeners until they stop listening", () => {
    let calls = 0;
    const stop = onAsksChanged(() => calls++);
    asksChanged();
    stop();
    asksChanged();
    expect(calls).toBe(1);
  });
});

/** A store's change feed, driven by hand. */
function fakeFeed() {
  const listeners = new Set<(workspaceId: string) => void>();
  return {
    onChange(listener: (workspaceId: string) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change(workspaceId: string) {
      for (const listener of listeners) listener(workspaceId);
    },
    get listening() {
      return listeners.size;
    },
  };
}

describe("pushing ask changes to clients", () => {
  afterEach(() => vi.useRealTimers());

  it("pushes one event per burst of writes, naming every workspace that changed", async () => {
    vi.useFakeTimers();
    const feed = fakeFeed();
    const push = vi.fn(async () => undefined);
    const abort = new AbortController();
    pushAskChanges(feed, push, abort.signal);
    feed.change("wks_1");
    feed.change("wks_2");
    feed.change("wks_1");
    expect(push).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ type: "changed", workspaceIds: ["wks_1", "wks_2"] });
    feed.change("wks_3");
    await vi.runAllTimersAsync();
    expect(push).toHaveBeenLastCalledWith({ type: "changed", workspaceIds: ["wks_3"] });
  });

  it("stops listening when the client lets go", async () => {
    vi.useFakeTimers();
    const feed = fakeFeed();
    const push = vi.fn(async () => undefined);
    const abort = new AbortController();
    pushAskChanges(feed, push, abort.signal);
    feed.change("wks_1");
    abort.abort();
    await vi.runAllTimersAsync();
    expect(push).not.toHaveBeenCalled();
    expect(feed.listening).toBe(0);
  });
});

describe("watching ask changes from a client", () => {
  it("signals asks changed for each pushed event", () => {
    let deliver: ((event: { type: "changed"; workspaceIds: string[] }) => void) | undefined;
    const stop = vi.fn();
    const client = {
      subscribe: vi.fn((_contract: unknown, _input: unknown, onEvent: NonNullable<typeof deliver>) => {
        deliver = onEvent;
        return stop;
      }),
    };
    let calls = 0;
    const stopListening = onAsksChanged(() => calls++);
    const stopWatching = watchAskChanges(client);
    deliver?.({ type: "changed", workspaceIds: ["wks_1"] });
    deliver?.({ type: "changed", workspaceIds: ["wks_2"] });
    stopWatching();
    stopListening();
    expect(calls).toBe(2);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does nothing on hosts without plugin subscriptions, leaving the poll", () => {
    expect(() => watchAskChanges({})()).not.toThrow();
  });
});
