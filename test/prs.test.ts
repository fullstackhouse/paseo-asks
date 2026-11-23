import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Deployment, PrState } from "../shared/asks";
import { describeCardChange, fromHost, prFingerprint, prPrompt, prRules, waitingPrsByWorkspace, type PrCard } from "../shared/prs";
import { githubRepoOf } from "../server/github";
import { PrBoard, type BoardAgent, type WorkspacePr } from "../server/prs";
import { RateLimited } from "../server/gh";
import { parseAsksMessage } from "../shared/messages";

const URL = "https://github.com/acme/shop/pull/30";

function pr(patch: Partial<PrState> = {}): PrState & { title: string } {
  return {
    number: 30,
    url: URL,
    title: "Cache carts in Postgres",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    checks: "passing",
    mergeable: "MERGEABLE",
    fetchedAt: "2026-11-23T10:00:00.000Z",
    ...patch,
  };
}

const rule = (patch: Partial<PrState>, extra: Partial<Parameters<typeof prRules>[0]> = {}) => {
  const { buttons, phase, reason } = prRules({ pr: pr(patch), agentState: "idle", actOnReviewChanges: true, ...extra });
  return { buttons: buttons.map((button) => button.id), phase, reason };
};

describe("which buttons a PR card offers, and whether it waits on you", () => {
  it.each([
    ["green, no review required", {}, ["merge", "request_review"], "waiting"],
    ["approved and green", { reviewDecision: "APPROVED" }, ["merge"], "waiting"],
    ["checks running", { checks: "pending" as const }, ["merge_when_green"], "working"],
    ["no checks at all", { checks: "none" as const }, ["merge", "request_review"], "waiting"],
    ["review required", { reviewDecision: "REVIEW_REQUIRED" }, ["request_review"], "waiting"],
    ["review required while checks run", { reviewDecision: "REVIEW_REQUIRED", checks: "pending" as const }, ["request_review"], "waiting"],
    ["checks failing", { checks: "failing" as const }, ["fix_checks"], "working"],
    ["conflicts", { mergeable: "CONFLICTING" }, ["resolve_conflicts"], "working"],
    ["changes requested, agent told", { reviewDecision: "CHANGES_REQUESTED" }, ["address_review"], "working"],
    ["draft", { isDraft: true }, [], "working"],
    ["merged", { state: "MERGED" as const }, [], "done"],
    ["closed", { state: "CLOSED" as const }, [], "done"],
  ])("%s", (_name, patch, buttons, phase) => {
    expect(rule(patch as Partial<PrState>)).toMatchObject({ buttons, phase });
  });

  it("waits on you for requested changes the setting holds back", () => {
    expect(rule({ reviewDecision: "CHANGES_REQUESTED" }, { actOnReviewChanges: false })).toMatchObject({
      buttons: ["address_review"],
      phase: "waiting",
    });
  });

  it("marks the first button primary", () => {
    const { buttons } = prRules({ pr: pr(), agentState: "idle", actOnReviewChanges: true });
    expect(buttons.map((button) => Boolean(button.primary))).toEqual([true, false]);
  });

  it("does not wait while its agent runs, and keeps the buttons", () => {
    expect(rule({}, { agentState: "running" })).toMatchObject({ buttons: ["merge", "request_review"], phase: "working", reason: "The agent is working" });
  });

  it("offers nothing when the workspace has no agent left", () => {
    expect(rule({}, { agentState: "gone" })).toMatchObject({ buttons: [], phase: "working" });
  });

  it("stops waiting after a press, until the PR changes", () => {
    const pressed = { id: "merge" as const, label: "Merge", at: "2026-11-23T10:00:00.000Z", fingerprint: prFingerprint(pr()) };
    expect(rule({}, { pressed })).toMatchObject({ phase: "working", reason: "You chose Merge" });
    // The merge didn't happen and a review is now required: the human's move again.
    expect(rule({ reviewDecision: "REVIEW_REQUIRED" }, { pressed })).toMatchObject({ phase: "waiting", buttons: ["request_review"] });
  });

  it("counts waiting cards per workspace, leaving snoozed ones out", () => {
    const card = (workspaceId: string, phase: PrCard["phase"]) => ({ workspaceId, phase }) as PrCard;
    const counts = waitingPrsByWorkspace([card("w1", "waiting"), card("w1", "working"), card("w2", "waiting"), card("w3", "waiting")], new Set(["w3"]));
    expect([...counts].map(([id, cards]) => [id, cards.length])).toEqual([
      ["w1", 1],
      ["w2", 1],
    ]);
  });
});

describe("PR state from the daemon's workspace snapshot", () => {
  it("maps the host's lower-case state to the plugin's", () => {
    const at = "2026-11-23T10:00:00.000Z";
    const host = { url: URL, title: "t", state: "open", isMerged: false, checksStatus: "failure" as const, reviewDecision: "pending" as const, mergeable: "CONFLICTING" };
    expect(fromHost(host, at)).toMatchObject({ number: 30, state: "OPEN", checks: "failing", reviewDecision: "REVIEW_REQUIRED", mergeable: "CONFLICTING" });
    expect(fromHost({ ...host, state: "merged", isMerged: true }, at)?.state).toBe("MERGED");
    expect(fromHost({ ...host, state: "closed" }, at)?.state).toBe("CLOSED");
    expect(fromHost({ ...host, checksStatus: undefined, reviewDecision: null }, at)).toMatchObject({ checks: "none", reviewDecision: null });
  });

  it("reads owner/name from GitHub remotes only", () => {
    expect(githubRepoOf("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(githubRepoOf("https://github.com/acme/shop")).toBe("acme/shop");
    expect(githubRepoOf("https://gitlab.com/acme/shop.git")).toBeNull();
  });
});

describe("what a PR tells its agent", () => {
  it("names merged, closed, failing checks and requested changes", () => {
    expect(describeCardChange(pr(), pr({ state: "MERGED" }), { review: true })).toBe("[asks] PR #30 merged.");
    expect(describeCardChange(pr(), pr({ state: "CLOSED" }), { review: true })).toBe("[asks] PR #30 closed without merging.");
    expect(describeCardChange(pr({ checks: "pending" }), pr({ checks: "failing" }), { review: true })).toBe("[asks] PR #30 checks failing: fix them and push.");
    expect(describeCardChange(pr(), pr({ reviewDecision: "CHANGES_REQUESTED" }), { review: true })).toMatch(/^\[asks\] PR #30 changes requested: /);
  });

  it("stays quiet about green checks, approvals and held reviews", () => {
    expect(describeCardChange(pr({ checks: "pending" }), pr(), { review: true })).toBeNull();
    expect(describeCardChange(pr(), pr({ reviewDecision: "APPROVED" }), { review: true })).toBeNull();
    expect(describeCardChange(pr(), pr({ reviewDecision: "CHANGES_REQUESTED" }), { review: false })).toBeNull();
  });

  it("sends a button's instruction with the human's note", () => {
    expect(prPrompt("merge_when_green", pr(), "squash it")).toMatch(
      /^\[asks\] Merge when green: Merge PR #30 \(https:\/\/github\.com\/acme\/shop\/pull\/30\) once its checks pass: .* Note from the human: "squash it"$/,
    );
  });
});

describe("PrBoard", () => {
  let dir: string;
  let sent: { agentId: string; workspaceId: string; text: string }[];
  let deploymentReads: string[];
  let deployments: Deployment[];
  let rateLimited: boolean;
  let legacy: { owner?: string; subscribed: boolean };
  let now: Date;
  const agents: BoardAgent[] = [
    { id: "old", workspaceId: "w1", status: "idle", updatedAt: "2026-11-20T10:00:00.000Z", lastUserMessageAt: "2026-11-20T10:00:00.000Z" },
    { id: "recent", workspaceId: "w1", status: "idle", updatedAt: "2026-11-22T10:00:00.000Z", lastUserMessageAt: "2026-11-22T10:00:00.000Z" },
    { id: "archived", workspaceId: "w1", status: "idle", updatedAt: "2026-11-23T10:00:00.000Z", archivedAt: "2026-11-23T11:00:00.000Z" },
  ];
  const states = new Map([
    ["old", "idle" as const],
    ["recent", "idle" as const],
  ]);
  const board = () =>
    new PrBoard(dir, {
      fetchDeployments: async (url) => {
        if (rateLimited) throw new RateLimited(Date.now() + 60_000);
        deploymentReads.push(url);
        return deployments;
      },
      message: (agentId, workspaceId, text) => void sent.push({ agentId, workspaceId, text }),
      flush: async () => true,
      legacyOwner: () => legacy.owner,
      legacySubscribed: () => legacy.subscribed,
      now: () => now,
    });
  const at = (patch: Partial<PrState> = {}): WorkspacePr[] => [{ workspaceId: "w1", pr: pr(patch) }];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "asks-prs-"));
    sent = [];
    deploymentReads = [];
    deployments = [{ label: "shop.vercel.app", state: "ready", url: "https://shop.vercel.app", link: "https://shop.vercel.app" }];
    rateLimited = false;
    legacy = { subscribed: false };
    now = new Date("2026-11-23T12:00:00.000Z");
  });

  it("shows a workspace's PR, owned by its most recently used live agent", async () => {
    const prs = board();
    await prs.sync(at(), agents, true);
    const [card] = prs.cards(states, true);
    expect(card).toMatchObject({ url: URL, title: "Cache carts in Postgres", agentId: "recent", phase: "waiting", reason: "Green; no review required" });
    expect(card!.pr.deployments).toEqual(deployments);
  });

  it("prefers the owner of an old PR ask for the same PR, then keeps the link", async () => {
    legacy.owner = "old";
    const prs = board();
    await prs.sync(at(), agents, true);
    legacy.owner = undefined;
    await prs.sync(at(), agents, true);
    expect(prs.cards(states, true)[0]!.agentId).toBe("old");
  });

  it("tells the PR's agent about failing checks, not about the first sight", async () => {
    const prs = board();
    await prs.sync(at({ checks: "failing" }), agents, true);
    expect(sent).toEqual([]);
    await prs.sync(at({ checks: "pending" }), agents, true);
    await prs.sync(at({ checks: "failing" }), agents, true);
    expect(sent).toEqual([{ agentId: "recent", workspaceId: "w1", text: "[asks] PR #30 checks failing: fix them and push." }]);
  });

  it("holds requested changes for the human when the setting says so", async () => {
    const prs = board();
    await prs.sync(at(), agents, false);
    await prs.sync(at({ reviewDecision: "CHANGES_REQUESTED" }), agents, false);
    expect(sent).toEqual([]);
    expect(prs.cards(states, false)[0]).toMatchObject({ phase: "waiting", buttons: [{ id: "address_review" }] });
  });

  it("leaves telling to the old watcher when a subscribed PR ask links the same PR", async () => {
    legacy.subscribed = true;
    const prs = board();
    await prs.sync(at(), agents, true);
    await prs.sync(at({ state: "MERGED" }), agents, true);
    expect(sent).toEqual([]);
  });

  it("sends a pressed button to the agent and stops waiting until the PR changes", async () => {
    const prs = board();
    await prs.sync(at(), agents, true);
    const { card, sent: delivered } = await prs.press(URL, "merge", "squash it", states, true);
    expect(delivered).toBe(true);
    expect(sent.at(-1)).toMatchObject({ agentId: "recent", text: expect.stringMatching(/^\[asks\] Merge: Merge PR #30 .* Note from the human: "squash it"$/) });
    expect(card).toMatchObject({ phase: "working", reason: "You chose Merge", pressed: { id: "merge", note: "squash it" } });
    // A restart keeps the press.
    expect(board().cards(states, true)[0]!.phase).toBe("working");
    await prs.sync(at({ checks: "failing" }), agents, true);
    expect(prs.cards(states, true)[0]).toMatchObject({ phase: "working", buttons: [{ id: "fix_checks" }] });
    expect(prs.cards(states, true)[0]!.reason).toBe("Checks are failing");
  });

  it("refuses a button the PR doesn't offer now", async () => {
    const prs = board();
    await prs.sync(at({ checks: "pending" }), agents, true);
    await expect(prs.press(URL, "merge", undefined, states, true)).rejects.toThrow(/doesn't offer merge/);
    expect(sent).toEqual([]);
  });

  it("drops cards of workspaces that are gone, and folds done ones away after a day", async () => {
    const prs = board();
    await prs.sync([...at(), { workspaceId: "w2", pr: pr({ number: 31, url: "https://github.com/acme/shop/pull/31" }) }], agents, true);
    await prs.sync(at({ state: "MERGED" }), agents, true);
    expect(prs.cards(states, true).map((card) => [card.number, card.phase])).toEqual([[30, "done"]]);
    now = new Date("2026-11-24T12:30:00.000Z");
    await prs.sync(at({ state: "MERGED" }), agents, true);
    expect(prs.cards(states, true)).toEqual([]);
  });

  it("reads deployments on change, every minute while deploying, otherwise every ten", async () => {
    const prs = board();
    await prs.sync(at(), agents, true);
    expect(deploymentReads).toHaveLength(1);
    now = new Date(now.getTime() + 2 * 60_000);
    await prs.sync(at(), agents, true);
    expect(deploymentReads).toHaveLength(1);
    await prs.sync(at({ checks: "pending" }), agents, true);
    expect(deploymentReads).toHaveLength(2);
    deployments = [{ label: "Deploying", state: "deploying" }];
    now = new Date(now.getTime() + 11 * 60_000);
    await prs.sync(at({ checks: "pending" }), agents, true);
    expect(deploymentReads).toHaveLength(3);
    now = new Date(now.getTime() + 61_000);
    await prs.sync(at({ checks: "pending" }), agents, true);
    expect(deploymentReads).toHaveLength(4);
  });

  it("keeps the last deployments when the quota is spent", async () => {
    const prs = board();
    await prs.sync(at(), agents, true);
    rateLimited = true;
    await prs.sync(at({ checks: "pending" }), agents, true);
    expect(prs.cards(states, true)[0]!.pr.deployments).toEqual(deployments);
  });
});

describe("PR messages in the chat", () => {
  it("shows a press as the human's choice with their note", () => {
    expect(parseAsksMessage(prPrompt("request_review", pr(), 'ask "ola" first'))).toEqual({
      title: "PR #30",
      event: "chose “Request review”",
      note: 'ask "ola" first',
    });
    expect(parseAsksMessage(prPrompt("merge_when_green", pr()))).toEqual({ title: "PR #30", event: "chose “Merge when green”" });
  });

  it("shows a change without the agent's instructions", () => {
    const text = describeCardChange(pr({ checks: "pending" }), pr({ checks: "failing", reviewDecision: "CHANGES_REQUESTED" }), { review: true })!;
    expect(parseAsksMessage(text)).toEqual({ title: "PR #30", event: "checks failing, changes requested" });
    expect(parseAsksMessage("[asks] PR #30 merged.")).toEqual({ title: "PR #30", event: "merged" });
  });
});
