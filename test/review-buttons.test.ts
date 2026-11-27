import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Outbox, type Courier } from "../server/outbox";
import { ghPrReviewOf, isMergeAction, reviewButtonsProblem, reviewerOf, type PrReview } from "../server/review-buttons";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";

const WS = "wks_1";
const OWNER = "owner";
const URL = "https://github.com/o/r/pull/30";

const review = (overrides: Partial<PrReview> = {}): PrReview => ({
  number: 30,
  state: "OPEN",
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  viewerCanMergeAsAdmin: false,
  author: "maker",
  ...overrides,
});

const send = (label: string, prompt?: string) => ({ kind: "send" as const, label, prompt });
const alice = send("Request review from alice", "Request review on PR #30 from alice");
const bob = send("Request review from bob", "Request review on PR #30 from bob");
const admin = send("Merge with --admin", "Merge PR #30 with --admin");
const deliver = send("Deliver PR #30 to dev", "Deliver PR #30 to dev");
const copilot = send("Request Copilot review", "Request a Copilot review on PR #30");

describe("review buttons", () => {
  it("tells merges and reviewer requests apart", () => {
    expect(isMergeAction(send("Merge (squash)"))).toBe(true);
    expect(isMergeAction(send("QA, then merge when green"))).toBe(true);
    expect(isMergeAction(send("Land it", "Run gh pr merge 30 --squash"))).toBe(true);
    expect(isMergeAction(send("Start phase 2 (after merge #12)"))).toBe(false);
    expect(isMergeAction(send("Start the migration", "Wait for PR #12 to merge, then start the migration"))).toBe(false);
    expect(isMergeAction(send("Fix merge conflicts"))).toBe(false);
    expect(isMergeAction(send("Request review from alice", "then merge"))).toBe(false);
    expect(isMergeAction(send("Merge (skip review)"))).toBe(true);
    expect(isMergeAction(admin)).toBe(true);
    expect(isMergeAction(deliver)).toBe(false);
    expect(reviewerOf(alice)).toBe("alice");
    expect(reviewerOf(send("Review: Carol", "Request review on PR #30 from @carol-d"))).toBe("carol-d");
    expect(reviewerOf(send("Request Copilot review", "Request a Copilot review on PR #30"))).toBeNull();
    expect(reviewerOf(send("Request review from Copilot"))).toBeNull();
    expect(reviewerOf(send("Request review from the team"))).toBeNull();
  });

  it("accepts any buttons that can work, reviewers or not", () => {
    expect(reviewButtonsProblem(review(), [deliver])).toBeNull();
    expect(reviewButtonsProblem(review(), [alice, bob])).toBeNull();
    expect(reviewButtonsProblem(review({ viewerCanMergeAsAdmin: true }), [send("Merge when green", "Merge PR #30 with squash once checks pass")])).toBeNull();
    expect(reviewButtonsProblem(review({ viewerCanMergeAsAdmin: true }), [admin])).toBeNull();
    expect(reviewButtonsProblem(review({ viewerCanMergeAsAdmin: true }), [alice, bob])).toBeNull();
    expect(reviewButtonsProblem(review(), [send("Merge (squash) once approved", "Merge PR #30 with squash once alice approves")])).toBeNull();
  });

  it("refuses a merge the human cannot perform", () => {
    expect(reviewButtonsProblem(review(), [send("Merge when green", "Merge PR #30 with squash once checks pass")])).toContain("cannot merge past it");
    expect(reviewButtonsProblem(review(), [admin, alice])).toContain('"Merge with --admin" merges a PR that still needs a review');
    expect(reviewButtonsProblem(review(), [send("Merge (skip review)"), alice, bob])).toContain("still needs a review");
  });

  it("refuses a review from Copilot or the author", () => {
    expect(reviewButtonsProblem(review(), [copilot])).toContain("asks Copilot");
    expect(reviewButtonsProblem(review({ viewerCanMergeAsAdmin: true }), [alice, copilot])).toContain("asks Copilot");
    expect(reviewButtonsProblem(review(), [send("Request review from maker")])).toContain("maker wrote the PR");
    expect(reviewButtonsProblem(review(), [send("Request review from Maker")])).toContain("Maker wrote the PR");
  });

  it("leaves PRs that need no first review alone", () => {
    const merge = [send("Merge (squash)")];
    expect(reviewButtonsProblem(review({ reviewDecision: "APPROVED" }), merge)).toBeNull();
    expect(reviewButtonsProblem(review({ reviewDecision: null }), merge)).toBeNull();
    expect(reviewButtonsProblem(review({ isDraft: true }), merge)).toBeNull();
    expect(reviewButtonsProblem(review({ state: "MERGED" }), merge)).toBeNull();
  });

  it("reads the PR in one GraphQL call", async () => {
    const calls: string[][] = [];
    const read = ghPrReviewOf(async (args) => {
      calls.push(args);
      return JSON.stringify({
        data: { repository: { pullRequest: { number: 30, state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", viewerCanMergeAsAdmin: true, author: { login: "maker" } } } },
      });
    });
    expect(await read(`${URL}/files`)).toEqual(review({ viewerCanMergeAsAdmin: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("owner=o");
    expect(calls[0]).toContain("number=30");
  });
});

describe("ask_create and ask_update on a PR that needs a review", () => {
  let store: AskStore;
  let state: PrReview | Error;
  let reads: number;
  let service: AsksService;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "asks-"));
    store = new AskStore(dir);
    const courier: Courier = { state: async () => "idle", send: async () => {} };
    state = review();
    reads = 0;
    const prReview = async () => {
      reads++;
      if (state instanceof Error) throw state;
      return state;
    };
    service = new AsksService(store, new Outbox(dir, courier), async () => WS, undefined, undefined, prReview);
  });

  const create = (actions: unknown[], kind = "pr") =>
    service.callTool(OWNER, "ask_create", { kind, title: "Request review on PR #30", links: [{ label: "PR", url: URL }], actions });

  it("refuses a Copilot review request and says why", async () => {
    const result = await create([copilot, { kind: "resolve", label: "I'll pick a reviewer" }]);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("PR #30 is REVIEW_REQUIRED");
    expect(result.text).toContain("asks Copilot");
    expect(result.text).toContain("never Copilot or maker (the author)");
    expect(store.list(WS)).toHaveLength(0);
  });

  it("refuses a non-admin Merge", async () => {
    const result = await create([send("Merge when green", "Merge PR #30 with squash once checks pass")]);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("viewerCanMergeAsAdmin is false");
    expect(store.list(WS)).toHaveLength(0);
  });

  it("accepts an ask with only a Deliver button", async () => {
    expect((await create([deliver], "pr")).isError).toBeUndefined();
    expect(store.list(WS)).toHaveLength(1);
  });

  it("accepts an ask without reviewer buttons when the human can merge past the review", async () => {
    state = review({ viewerCanMergeAsAdmin: true });
    expect((await create([send("Merge when green", "Merge PR #30 with squash once checks pass")])).isError).toBeUndefined();
    expect(store.list(WS)).toHaveLength(1);
  });

  it("lets the ask through when gh fails", async () => {
    state = new Error("gh: network");
    expect((await create([send("Merge (squash)")])).isError).toBeUndefined();
  });

  it("does not read the PR for a follow-up that only waits on it, or a review ask about something else", async () => {
    expect((await create([send("Start once #30 is merged")], "followup")).isError).toBeUndefined();
    const qa = [{ kind: "resolve", label: "Looks right" }, { kind: "resolve", label: "Needs changes" }];
    expect((await create(qa, "review")).isError).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("checks a new offer on ask_update, not a status change", async () => {
    await create([alice, bob]);
    const merge = await service.callTool(OWNER, "ask_update", { id: "A1", actions: [send("Merge (squash)")] });
    expect(merge.isError).toBe(true);
    reads = 0;
    expect((await service.callTool(OWNER, "ask_update", { id: "A1", status: "in_progress" })).isError).toBeUndefined();
    expect((await service.callTool(OWNER, "ask_update", { id: "A1", status: "done", links: [{ label: "PR", url: URL }] })).isError).toBeUndefined();
    expect(reads).toBe(0);
  });
});
