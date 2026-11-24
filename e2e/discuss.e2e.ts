import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness";

describe("Discuss in a real Paseo daemon", () => {
  let sandbox: Sandbox;
  let owner: string;
  let explainer: { agentId: string; workspaceId: string; created: boolean };

  beforeAll(async () => {
    sandbox = await Sandbox.start("discuss");
    await sandbox.commitProject();
  });

  afterAll(async () => {
    await sandbox?.stop();
    expect(sandbox?.misses ?? [], "requests missing from the cassette; run npm run record").toEqual([]);
  });

  it("opens an explainer in a workspace of its own", async () => {
    owner = await sandbox.run(
      'Call the asks ask_create tool once with kind "decision", title "Keep carts in Redis or Postgres?", body "Simply put: carts outgrow the 4 KB session cookie, so they need a server-side home.", and two actions: label "Redis", kind "resolve"; label "Postgres", kind "resolve", recommended true. Then reply with just the ask id. Do not read or write any files.',
    );
    await sandbox.settle(owner);
    const [ask] = sandbox.asks();
    expect(ask).toMatchObject({ id: "A1", status: "open", ownerAgentId: owner });

    explainer = await sandbox.discuss("A1");
    const ownerWorkspace = sandbox.workspaceOf("A1");
    expect(explainer.created).toBe(true);
    expect(explainer.workspaceId).not.toBe(ownerWorkspace);
    expect(sandbox.asks()[0]).toMatchObject({ discussionAgentId: explainer.agentId, discussionWorkspaceId: explainer.workspaceId });

    const snapshot = await sandbox.inspect(explainer.agentId);
    expect(JSON.stringify(snapshot)).toContain("Explain A1");
    await sandbox.settle(explainer.agentId);
    expect(await sandbox.timeline(explainer.agentId)).toMatch(/Postgres/);
  });

  it("reopens the same explainer on a second press", async () => {
    expect(await sandbox.discuss("A1")).toEqual({ ...explainer, created: false });
  });

  it("lets the explainer settle the ask from its workspace, and tells the owner", async () => {
    await sandbox.send(explainer.agentId, "Go with Postgres. Settle the ask now.");
    await sandbox.settle(explainer.agentId);

    expect(sandbox.asks()[0]).toMatchObject({ status: "done", outcome: { by: "agent", label: "Postgres" } });
    const timeline = await sandbox.waitForTimeline(owner, /\[User\] \[asks\] A1 \(Keep carts in Redis or Postgres\?\) resolved in a side chat: Postgres/);
    expect(timeline).toMatch(/resolved in a side chat: Postgres/);
    // The owner answers that message, and the nudge check on its reply runs after the turn ends.
    await sandbox.settle(owner);
    await sandbox.quiet();
    // It named A1 while waiting on the choice, so it was not nudged into a duplicate ask.
    expect(await sandbox.timeline(explainer.agentId)).not.toMatch(/\[User\] \[asks\] A check found/);
  });

  it("logs no plugin errors", async () => {
    expect(await sandbox.pluginLogs()).not.toMatch(/error|exception/i);
  });
});
