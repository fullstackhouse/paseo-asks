import { existsSync } from "node:fs";
import { execCommand } from "@getpaseo/plugin/server";
import { OPEN_STATUSES, prUrlOf, type Ask, type PrState } from "../shared/asks";

// The daemon is often launched from the Dock with a bare PATH, so look where gh usually lives.
const GH_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

export function findGh(): string | null {
  return GH_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

interface CheckItem {
  status?: string;
  conclusion?: string;
  state?: string;
}

export type FetchPr = (url: string) => Promise<PrState>;

export function ghFetcher(gh: string): FetchPr {
  return async (url) => {
    const { stdout } = await execCommand(
      gh,
      ["pr", "view", url, "--json", "number,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup"],
      { timeout: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
    );
    const pr = JSON.parse(stdout);
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      isDraft: Boolean(pr.isDraft),
      reviewDecision: pr.reviewDecision || null,
      mergeable: pr.mergeable ?? "UNKNOWN",
      checks: summarizeChecks(pr.statusCheckRollup ?? []),
      fetchedAt: new Date().toISOString(),
    };
  };
}

export function summarizeChecks(items: CheckItem[]): PrState["checks"] {
  if (items.length === 0) return "none";
  const failed = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  if (items.some((item) => failed.includes(item.conclusion ?? "") || failed.includes(item.state ?? ""))) return "failing";
  if (items.some((item) => (item.status && item.status !== "COMPLETED") || item.state === "PENDING" || item.state === "EXPECTED")) {
    return "pending";
  }
  return "passing";
}

/** What changed between two snapshots, in words an agent can act on; null when nothing it cares about did. */
export function describePrChange(before: PrState, after: PrState): string | null {
  const changes: string[] = [];
  if (before.state !== after.state) changes.push(after.state === "MERGED" ? "merged" : after.state === "CLOSED" ? "closed without merging" : "reopened");
  if (before.checks !== after.checks && (after.checks === "failing" || after.checks === "passing")) changes.push(`checks ${after.checks}`);
  if (before.reviewDecision !== after.reviewDecision && after.reviewDecision) {
    changes.push(`review: ${after.reviewDecision.toLowerCase().replace(/_/g, " ")}`);
  }
  return changes.length ? `PR #${after.number} ${changes.join(", ")}` : null;
}

export function watchedAsks(asks: readonly Ask[]): Ask[] {
  return asks.filter((ask) => OPEN_STATUSES.includes(ask.status) && prUrlOf(ask));
}
