import { describe, expect, it } from "vitest";
import { toolGrantSupport } from "../server/tool-grants";

describe("toolGrantSupport", () => {
  it("follows the host's supportsToolPolicy, including providers outside the fallback list", async () => {
    const support = toolGrantSupport(async () => ({
      entries: [
        { provider: "claude", supportsToolPolicy: true },
        { provider: "copilot", supportsToolPolicy: false },
        { provider: "my-plugin-agent", supportsToolPolicy: true },
      ],
    }));
    expect(await support("claude/opus")).toBe(true);
    expect(await support("copilot")).toBe(false);
    expect(await support("my-plugin-agent")).toBe(true);
  });

  it("falls back to Claude, Codex and OpenCode on hosts that don't report it", async () => {
    const support = toolGrantSupport(async () => ({ entries: [{ provider: "claude" }, { provider: "pi" }] }));
    expect(await support("claude")).toBe(true);
    expect(await support("codex")).toBe(true);
    expect(await support("pi")).toBe(false);
    expect(await support("my-plugin-agent")).toBe(false);
  });

  it("falls back when the snapshot can't be read, and reads it at most once per TTL", async () => {
    let reads = 0;
    let time = 0;
    const support = toolGrantSupport(
      async () => {
        reads += 1;
        if (reads === 1) throw new Error("not connected");
        return { entries: [{ provider: "pi", supportsToolPolicy: true }] };
      },
      () => time,
      1_000,
    );
    expect(await support("pi")).toBe(false);
    expect(await support("pi")).toBe(false);
    expect(reads).toBe(1);
    time = 1_000;
    expect(await support("pi")).toBe(true);
    expect(reads).toBe(2);
  });
});
