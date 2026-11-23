import { describe, expect, it } from "vitest";
import { asksChanged, onAsksChanged } from "../client/changes";

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
