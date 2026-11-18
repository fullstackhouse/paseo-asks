import { describe, expect, it } from "vitest";
import type { PrState } from "../shared/asks";
import { summarizeDeployments, type DeploymentNode } from "../server/deployments";
import { describePrChange } from "../server/github";

const node = (createdAt: string, state: string | null, environmentUrl: string | null, logUrl = `https://ci.example.com/${createdAt}`): DeploymentNode => ({
  environment: "preview",
  createdAt,
  latestStatus: state ? { state, logUrl } : null,
  statuses: { nodes: [{ environmentUrl: null }, { environmentUrl }] },
});

const APP = "https://pr-7.example.dev";
const DOCS = "https://docs-pr-7.example.dev";

describe("summarizeDeployments", () => {
  it("keeps one entry per URL, the newest deployment's, labelled by host", () => {
    expect(
      summarizeDeployments([
        node("2026-11-18T10:00:00Z", "FAILURE", APP),
        node("2026-11-18T11:00:00Z", "SUCCESS", APP),
        node("2026-11-18T11:00:01Z", "IN_PROGRESS", DOCS),
      ]),
    ).toEqual([
      { label: "docs-pr-7.example.dev", state: "deploying", url: DOCS, link: "https://ci.example.com/2026-11-18T11:00:01Z" },
      { label: "pr-7.example.dev", state: "ready", url: APP, link: APP },
    ]);
  });

  it("maps states, links failures to their logs, and skips inactive or status-less ones", () => {
    expect(summarizeDeployments([node("1", "ERROR", APP)])).toEqual([
      { label: "pr-7.example.dev", state: "failed", url: APP, link: "https://ci.example.com/1" },
    ]);
    expect(summarizeDeployments([node("1", "QUEUED", APP, "")])[0]).toMatchObject({ state: "deploying", link: APP });
    expect(summarizeDeployments([node("1", "SUCCESS", APP), node("2", "INACTIVE", APP)])).toEqual([]);
    expect(summarizeDeployments([node("1", null, APP)])).toEqual([]);
  });

  it("shows URL-less deployments only while one deploys, as a single entry", () => {
    expect(summarizeDeployments([node("1", "SUCCESS", null), node("2", "FAILURE", null)])).toEqual([]);
    expect(
      summarizeDeployments([node("1", "PENDING", null), node("2", "IN_PROGRESS", null), node("3", "SUCCESS", APP)]),
    ).toEqual([
      { label: "pr-7.example.dev", state: "ready", url: APP, link: APP },
      { label: "Deploying", state: "deploying", link: "https://ci.example.com/2" },
    ]);
  });

  it("returns nothing without deployments", () => {
    expect(summarizeDeployments([])).toEqual([]);
  });
});

describe("describePrChange with deployments", () => {
  const pr = (deployments?: PrState["deployments"]): PrState => ({
    number: 7,
    url: "https://github.com/o/r/pull/7",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    checks: "pending",
    mergeable: "MERGEABLE",
    deployments,
    fetchedAt: "2026-11-18T00:00:00Z",
  });
  const ready = { label: "pr-7.example.dev", state: "ready" as const, url: APP, link: APP };
  const deploying = { ...ready, state: "deploying" as const, link: "https://ci.example.com/1" };

  it("reports a preview that became ready, once", () => {
    expect(describePrChange(pr([deploying]), pr([ready]))).toBe(`PR #7 preview ready: ${APP}`);
    expect(describePrChange(pr([]), pr([ready]))).toBe(`PR #7 preview ready: ${APP}`);
    expect(describePrChange(pr([ready]), pr([ready]))).toBeNull();
  });

  it("stays quiet when the earlier snapshot had no deployments lookup", () => {
    expect(describePrChange(pr(), pr([ready]))).toBeNull();
  });
});
