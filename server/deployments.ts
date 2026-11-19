import type { Deployment } from "../shared/asks";
import type { Gh } from "./gh";

/** One GitHub deployment of the PR's head commit, as the GraphQL query below returns it. */
export interface DeploymentNode {
  environment?: string | null;
  createdAt: string;
  latestStatus?: { state?: string | null; logUrl?: string | null } | null;
  statuses?: { nodes?: ({ environmentUrl?: string | null } | null)[] | null } | null;
}

// `gh pr view --json` has no deployments. Costs 1 GraphQL point; statuses carry the URL, which the latest one may lack.
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { commits(last: 1) { nodes { commit {
    deployments(last: 20) { nodes {
      environment createdAt latestStatus { state logUrl } statuses(first: 10) { nodes { environmentUrl } }
    } }
  } } } } }
}`;

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

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export async function fetchDeployments(gh: Gh, prUrl: string): Promise<Deployment[]> {
  const match = PR_URL.exec(prUrl);
  if (!match) return [];
  const [, owner, name, number] = match;
  const stdout = await gh.run(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]);
  const commit = JSON.parse(stdout).data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
  return summarizeDeployments(commit?.deployments?.nodes ?? []);
}
