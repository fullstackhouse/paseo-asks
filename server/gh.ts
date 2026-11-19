import { execCommand } from "@getpaseo/plugin/server";

// A spent quota without a reset time to wait for (a secondary limit, or `gh api rate_limit` failed).
const BACKOFF_MS = 5 * 60_000;

/** Thrown instead of calling gh while GitHub's rate limit is spent. */
export class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`GitHub rate limit: gh calls paused until ${new Date(until).toISOString()}`);
  }
}

/**
 * gh reports a spent limit on stderr: "GraphQL: API rate limit already exceeded …", "HTTP 403: API rate limit exceeded …",
 * "HTTP 403: You have exceeded a secondary rate limit", "HTTP 429: …". Stdout is not searched: it can hold PR titles.
 */
export function isRateLimit(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && /rate limit|HTTP 429/i.test(stderr);
}

export type GhExec = (args: string[]) => Promise<string>;

export function ghExec(path: string): GhExec {
  return async (args) => {
    const { stdout } = await execCommand(path, args, { timeout: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    return stdout;
  };
}

/**
 * Every gh call of the plugin. The quota is shared with every other gh user on the machine, so once GitHub says it is
 * spent, calls fail fast with `RateLimited` until it resets instead of every poll retrying into the limit.
 */
export class Gh {
  private until = 0;

  constructor(
    private readonly exec: GhExec,
    private readonly now: () => number = Date.now,
  ) {}

  async run(args: string[]): Promise<string> {
    if (this.now() < this.until) throw new RateLimited(this.until);
    try {
      return await this.exec(args);
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      // Calls in flight when the limit hit fail too; only the first one pauses.
      if (this.now() >= this.until) await this.pause();
      throw new RateLimited(this.until);
    }
  }

  private async pause(): Promise<void> {
    this.until = this.now() + BACKOFF_MS;
    console.error("[asks] GitHub rate limit hit; gh calls paused");
    // `gh api rate_limit` costs no quota. A spent GraphQL quota is back at its reset; any other limit keeps the backoff.
    const out = await this.exec(["api", "rate_limit", "--jq", '.resources.graphql | "\\(.remaining) \\(.reset)"']).catch(() => null);
    if (out == null) return;
    const [remaining, reset] = out.trim().split(" ").map(Number);
    if (remaining === 0 && reset) this.until = reset * 1000;
  }
}
