import { describe, expect, it } from "vitest";
import { Gh, isRateLimit, RateLimited } from "../server/gh";

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const RESET_SECONDS = NOW / 1000 + 1800;

const spent = Object.assign(new Error("Command failed"), { stderr: "GraphQL: API rate limit already exceeded for user ID 1." });

describe("Gh", () => {
  it("recognises gh's rate-limit messages on stderr only", () => {
    expect(isRateLimit(spent)).toBe(true);
    expect(isRateLimit({ stderr: "HTTP 429: Too Many Requests" })).toBe(true);
    expect(isRateLimit({ stderr: "HTTP 404: Not Found" })).toBe(false);
    expect(isRateLimit({ stdout: "rate limit", stderr: "" })).toBe(false);
  });

  it("pauses calls until the GraphQL quota resets once GitHub reports it spent", async () => {
    let now = NOW;
    const calls: string[][] = [];
    const gh = new Gh(async (args) => {
      calls.push(args);
      if (args[1] === "rate_limit") return `0 ${RESET_SECONDS}\n`;
      throw spent;
    }, () => now);

    await expect(gh.run(["pr", "view", "1"])).rejects.toEqual(new RateLimited(RESET_SECONDS * 1000));
    await expect(gh.run(["pr", "view", "2"])).rejects.toBeInstanceOf(RateLimited);
    expect(calls.map((args) => args.slice(0, 2))).toEqual([["pr", "view"], ["api", "rate_limit"]]);

    now = RESET_SECONDS * 1000;
    await expect(gh.run(["pr", "view", "3"])).rejects.toBeInstanceOf(RateLimited);
    expect(calls.at(-2)).toEqual(["pr", "view", "3"]);
  });

  it("falls back to a five-minute pause when the reset time cannot be read", async () => {
    const gh = new Gh(async (args) => {
      if (args[1] === "rate_limit") throw new Error("offline");
      throw spent;
    }, () => NOW);
    await expect(gh.run(["pr", "view", "1"])).rejects.toEqual(new RateLimited(NOW + 5 * 60_000));
  });

  it("passes other failures through without pausing", async () => {
    let fail = true;
    const gh = new Gh(async () => {
      if (fail) throw Object.assign(new Error("not found"), { stderr: "HTTP 404" });
      return "ok";
    }, () => NOW);
    await expect(gh.run(["pr", "view", "1"])).rejects.toThrow("not found");
    fail = false;
    expect(await gh.run(["pr", "view", "1"])).toBe("ok");
  });
});
