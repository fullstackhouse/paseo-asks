import type { PaseoApi } from "@getpaseo/client";
import type { Deployment, PrState } from "../shared/asks";
import { summarizeDeployments } from "./deployments";
import { PrReadFailed, PrReadsPaused, PrReadsUnavailable, prStateOf, type FetchPrs } from "./github";
import type { HostChangeRequestRead, HostDeployment, HostSubscription } from "./host-sdk";

interface Entry {
  subscription: Promise<HostSubscription | null>;
  read: HostChangeRequestRead | null;
}

/** The host's deployments in the shape `summarizeDeployments` reads (it was written for GitHub's GraphQL nodes). */
export function deploymentsOf(deployments: readonly HostDeployment[]): Deployment[] {
  return summarizeDeployments(
    deployments.map((deployment) => ({
      environment: deployment.environment,
      createdAt: deployment.createdAt,
      latestStatus: { state: deployment.state, logUrl: deployment.logUrl ?? null },
      statuses: { nodes: deployment.url ? [{ environmentUrl: deployment.url }] : [] },
    })),
  );
}

/**
 * PR state for PR asks from the host's PR service (`paseo.changeRequests.subscribe`, fullstackhouse/paseo#285): one
 * subscription per watched PR, with its deployments. The host reads each PR once for every subscriber in the daemon, at
 * the pace it needs, and pushes changes; `onChange` tells the watcher which PRs changed so it compares and notifies at
 * once. Nothing here polls GitHub.
 */
export class PrFeed {
  private readonly entries = new Map<string, Entry>();
  private warned = false;

  constructor(
    private readonly paseo: () => PaseoApi | null,
    private readonly onChange: (urls: string[]) => void = () => undefined,
  ) {}

  /** Each URL's PR state, following any not followed yet. `previous` keeps deployments a read without them lacks. */
  readonly fetch: FetchPrs = async (urls, previous) => {
    const subscribe = this.subscriber();
    if (!subscribe) throw new PrReadsUnavailable("Host lacks changeRequests.subscribe");
    await Promise.all(urls.map((url) => this.follow(url, subscribe)));
    const reads = urls.map((url) => this.entries.get(url)?.read ?? null);
    const paused = reads.find((read) => read && !read.ok && read.reason === "paused");
    if (paused && !paused.ok) throw new PrReadsPaused(paused.retryAt);
    const results = new Map<string, PrState | Error>();
    urls.forEach((url, index) => {
      const read = reads[index];
      if (!read) return void results.set(url, new PrReadFailed("the host returned no result"));
      if (!read.ok) return void results.set(url, new PrReadFailed(read.error));
      const state: PrState = { ...prStateOf(read), headSha: read.headSha };
      if (read.deployments) return void results.set(url, { ...state, deployments: deploymentsOf(read.deployments), deploymentsAt: state.fetchedAt });
      // No deployments in this read (a host that doesn't send them): the last ones stand while the head commit does.
      const before = previous.get(url);
      const kept = before?.headSha === read.headSha ? before : undefined;
      results.set(url, kept?.deployments ? { ...state, deployments: kept.deployments, deploymentsAt: kept.deploymentsAt } : state);
    });
    return results;
  };

  /** Unsubscribes PRs no open ask watches any more. */
  async retain(urls: Iterable<string>): Promise<void> {
    const keep = new Set(urls);
    const done: Promise<unknown>[] = [];
    for (const [url, entry] of this.entries) {
      if (keep.has(url)) continue;
      this.entries.delete(url);
      done.push(entry.subscription.then((subscription) => subscription?.unsubscribe()).catch(() => undefined));
    }
    await Promise.all(done);
  }

  async close(): Promise<void> {
    await this.retain([]);
  }

  private async follow(url: string, subscribe: Subscribe): Promise<void> {
    const existing = this.entries.get(url);
    if (existing) return void (await existing.subscription);
    const entry: Entry = { subscription: Promise.resolve(null), read: null };
    entry.subscription = subscribe({ urls: [url], priority: "background", include: ["deployments"] }, (update) => {
      const read = update.results.find((result) => result.url === url) ?? update.results[0];
      if (!read) return;
      entry.read = read;
      this.onChange([url]);
    }).then(
      (subscription) => {
        entry.read = subscription.initial.results[0] ?? null;
        return subscription;
      },
      (error: unknown) => {
        // Not kept: the next pass subscribes again.
        if (this.entries.get(url) === entry) this.entries.delete(url);
        console.error(`[asks] following ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      },
    );
    this.entries.set(url, entry);
    await entry.subscription;
  }

  private subscriber(): Subscribe | null {
    const api = this.paseo();
    const changeRequests = api?.changeRequests;
    // COMPAT(changeRequestSubscriptions): hosts before fullstackhouse/paseo#285 have no subscribe.
    if (changeRequests?.subscribe) return changeRequests.subscribe.bind(changeRequests);
    if (api && !this.warned) {
      this.warned = true;
      console.error("[asks] this Paseo can't follow pull requests for plugins; update it for live PR status on asks");
    }
    return null;
  }
}

type Subscribe = NonNullable<NonNullable<PaseoApi["changeRequests"]>["subscribe"]>;
