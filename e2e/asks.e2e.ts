import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness";

const NUDGED = /\[User\] \[asks\] A check found that your last reply leaves something for the human/;

describe("asks in a real Paseo daemon", () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await Sandbox.start("asks");
  });

  afterAll(async () => {
    await sandbox?.stop();
    expect(sandbox?.misses ?? [], "requests missing from the cassette; run npm run record").toEqual([]);
  });

  it("stores an ask the agent creates and does not nudge", async () => {
    const agent = await sandbox.run(
      'Call the asks ask_create tool once with kind "pr", title "Merge PR #7", and one action: label "Merge", kind "send", prompt "Merge PR #7 with squash". Then reply with just the ask id.',
    );

    await sandbox.settle(agent);

    expect(sandbox.asks()).toEqual([expect.objectContaining({ id: "A1", title: "Merge PR #7", status: "open", ownerAgentId: agent })]);
    expect(await sandbox.timeline(agent)).toContain("[mcp__asks__ask_create]");
    expect(await sandbox.timeline(agent)).not.toMatch(NUDGED);
  });

  it("delivers a pressed send action back to the agent", async () => {
    const [ask] = sandbox.asks();
    await sandbox.act(ask.id, { verb: "action", actionId: ask.actions[0].id });

    const timeline = await sandbox.waitForTimeline(ask.ownerAgentId!, /\[User\] \[asks\][^\n]*Merge PR #7 with squash/);
    expect(timeline).toMatch(/\[User\] \[asks\][^\n]*Merge PR #7 with squash/);
  });

  it("reminds an agent whose turn ends with the ask still in progress", async () => {
    const [ask] = sandbox.asks();
    // PR #7 doesn't exist, so the agent can't finish the merge and ends its turn holding the ask.
    const timeline = await sandbox.waitForTimeline(ask.ownerAgentId!, /\[User\] \[asks\] Your turn ended with A1 \(Merge PR #7\) in progress/);
    expect(timeline).toMatch(/Your turn ended with A1/);
    await sandbox.settle(ask.ownerAgentId!);
    expect(sandbox.asks().find((candidate) => candidate.id === "A1")?.status).not.toBe("in_progress");
  });

  it("nudges a question left in chat without an ask", async () => {
    const agent = await sandbox.run(
      'Reply with exactly this sentence and nothing else, without using any tools: "The migration plan is ready. Should I run it tonight?"',
    );

    const timeline = await sandbox.waitForTimeline(agent, NUDGED);
    expect(timeline).toMatch(NUDGED);
  });

  it("nudges a request left in chat without a question mark", async () => {
    const agent = await sandbox.run(
      'Write a file plan.md containing "Add an index on orders.created_at". Then reply with exactly this sentence and nothing else: "Wrote the migration plan to plan.md; decide whether to run it tonight, then I will re-review."',
    );

    const timeline = await sandbox.waitForTimeline(agent, NUDGED);
    expect(timeline).toMatch(NUDGED);
  });

  it("nudges a deferred follow-up left in chat", async () => {
    const agent = await sandbox.run(
      'Reply with exactly this sentence and nothing else, without using any tools: "Kept the onRetryComplete callback for today\'s release; it is worth removing when the replay path is replaced."',
    );

    const timeline = await sandbox.waitForTimeline(agent, NUDGED);
    expect(timeline).toMatch(NUDGED);
    await sandbox.settle(agent);
    expect(sandbox.asks()).toContainEqual(
      expect.objectContaining({ kind: "followup", ownerAgentId: agent, actions: expect.arrayContaining([expect.objectContaining({ kind: "send" })]) }),
    );
  });

  it("does not nudge a plain report", async () => {
    const before = sandbox.classifierCalls();
    const agent = await sandbox.run('Write a file notes.txt containing "hello". Then reply with exactly "Created notes.txt." and nothing else.');
    await sandbox.waitForClassifier(agent, before);

    expect(await sandbox.timeline(agent)).not.toMatch(NUDGED);
  });

  it("creates a decision's ask, then ends the turn on its explanation", async () => {
    const agent = await sandbox.run(
      "Our shop keeps carts in a 4 KB session cookie and long carts get cut short. Compare keeping carts in Redis or in Postgres in a short paragraph, recommend one, and leave the choice to me. Do not read or write any files.",
    );
    await sandbox.settle(agent);

    expect(sandbox.asks()).toContainEqual(expect.objectContaining({ kind: "decision", ownerAgentId: agent }));
    // A collapsed turn shows only its last message, so the explanation follows the ask and ends the turn.
    const turn = (await sandbox.timeline(agent)).split(/^\[User\].*$/m).at(-1) ?? "";
    const after = turn.split("[mcp__asks__ask_create]").at(-1) ?? "";
    expect(turn).toContain("[mcp__asks__ask_create]");
    expect(after).toMatch(/Postgres/);
  });

  it("logs no plugin errors", async () => {
    expect(await sandbox.pluginLogs()).not.toMatch(/error|exception/i);
  });
});
