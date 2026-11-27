import type { Deployment } from "../shared/asks";

/** One deployment of the PR's head commit, in GitHub's GraphQL shape (`pr-feed.ts` maps the host's deployments into it). */
export interface DeploymentNode {
  environment?: string | null;
  createdAt: string;
  latestStatus?: { state?: string | null; logUrl?: string | null } | null;
  statuses?: { nodes?: ({ environmentUrl?: string | null } | null)[] | null } | null;
}

const STATES: Record<string, Deployment["state"]> = {
  SUCCESS: "ready",
  IN_PROGRESS: "deploying",
  QUEUED: "deploying",
  PENDING: "deploying",
  WAITING: "deploying",
  FAILURE: "failed",
  ERROR: "failed",
};

/** One entry per preview URL, newest deployment wins; URL-less ones only surface while deploying. */
export function summarizeDeployments(nodes: readonly DeploymentNode[]): Deployment[] {
  const newestFirst = [...nodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const seen = new Set<string>();
  const entries: Deployment[] = [];
  let deployingWithoutUrl: Deployment | undefined;
  for (const node of newestFirst) {
    const url = node.statuses?.nodes?.find((status) => status?.environmentUrl)?.environmentUrl ?? undefined;
    const state = STATES[node.latestStatus?.state ?? ""];
    const logUrl = node.latestStatus?.logUrl || undefined;
    if (!url) {
      if (state === "deploying") deployingWithoutUrl ??= { label: "Deploying", state, link: logUrl };
      continue;
    }
    // The newest deployment owns the URL even when inactive, so an older one doesn't resurface.
    if (seen.has(url)) continue;
    seen.add(url);
    if (state) entries.push({ label: hostOf(url), state, url, link: state === "ready" ? url : (logUrl ?? url) });
  }
  return deployingWithoutUrl ? [...entries, deployingWithoutUrl] : entries;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
