import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinnedSkill, Sandbox, type Ask } from "./harness";

/**
 * One Deliver click merges. The owner presses "Deliver to merged" on a PR that waits only for a review they can merge
 * past as an admin, carries `needs-qa` with QA evidence on its head, and is green. The agent must take the click as
 * the QA sign-off, add `qa-approved`, and merge with --admin: no second ask for the same merge. Without SPEC-051's
 * deliver skill it refused for want of `qa-approved` and asked again, so the owner said "merge" twice.
 *
 * GitHub is the fake gh in fake-gh/, answering for two fixture PRs and logging every call. The skill is
 * fullstackhouse/skills' deliver at a pinned commit; E2E_DELIVER_SHA runs another commit into its own cassette.
 * It runs on Sonnet, not Haiku: deliver runs on the session's model, which is never Haiku, and Haiku skips its report format.
 */
const exec = promisify(execFile);
const E2E = dirname(fileURLToPath(import.meta.url));
const DELIVER_SHA = process.env.E2E_DELIVER_SHA ?? "b4ece6a17387c697d3e3bb5b9959b9d284c512f9";
const CASSETTE = process.env.E2E_DELIVER_SHA ? `deliver-${DELIVER_SHA.slice(0, 7)}` : "deliver";
const NUDGED = /\[User\] \[asks\] A check found that your last reply leaves something for the human/;
const REPO = "e2e-fixture/app";

type Call = { argv: string[]; mutating: boolean; unsupported?: boolean };

/**
 * Asks the owner for what the Deliver move already does: "add `qa-approved`", "you need to add `qa-approved`",
 * "get QA signed off", "QA sign-off is still needed", "once QA is signed off". Saying what deliver will do passes.
 */
const QA_STILL_NEEDED = new RegExp(
  [
    /(?:^|[.;:!?,(]\s*|[-*]\s+|\b(?:please|then|you(?:'ll)? (?:need to|must|should|have to|can))\s+)(?:also\s+)?add\s+`?qa-approved/,
    /\byou (?:need|must|have to|should)\b[^.\n]{0,30}qa-approved/,
    /\bget (?:the )?QA (?:signed off|sign-?off)/,
    /QA sign-?off[^.\n]{0,30}\b(?:needed|required|missing|pending)\b/,
    /qa-approved`?[^.\n]{0,30}\b(?:is|are) (?:still )?(?:needed|required|missing)\b/,
    /\b(?:once|after|when|until)\b[^.\n]{0,40}\bQA (?:is |has been |gets )?sign(?:s|ed)? off\b/,
  ]
    .map((part) => part.source)
    .join("|"),
  "im",
);
/** A `Now:` line saying the PR still lacks qa-approved ("needs-qa without qa-approved"). */
const NOW_WITHOUT_QA = /\b(?:without|no|lacks?|missing)\b[^.\n]{0,10}qa-approved/i;

/** The agent's last reply: the timeline after its last `[User]`, `[Shell]`, `[mcp__…]` or other tagged line. */
const finalMessage = (timeline: string) => {
  const lines = timeline.trimEnd().split("\n");
  return lines.slice(lines.findLastIndex((line) => /^\[[^\]\s]+\] /.test(line)) + 1).join("\n").trim();
};

/**
 * The Next moves block deliver ends every report with, which the asks plugin turns into buttons: from its last
 * "Next moves" line to the end of the message, and its `Now:` line. Loose on wording and markdown, strict on shape.
 */
const nextMoves = (message: string) => {
  const start = message.search(/^.*Next moves.*$(?![\s\S]*^.*Next moves)/im);
  const block = start < 0 ? "" : message.slice(start);
  const now = block.match(/^[\s>*_`-]*Now[*_`]*:.*$/im)?.[0] ?? "";
  const moves = block.split("\n").filter((line) => /\/deliver --pr|^[\s>*_`-]*Deliver to\b/i.test(line));
  return { block, now, moves };
};

describe("a Deliver click on a PR that needs QA and a review", () => {
  let sandbox: Sandbox;
  let heads: Record<"7" | "8", string>;

  const calls = (): Call[] => {
    const file = join(sandbox.home, ".fake-gh", "calls.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const mutations = () => calls().filter((call) => call.mutating);
  const merges = () => mutations().filter(({ argv }) => argv[0] === "pr" && argv[1] === "merge");
  const pr = (number: "7" | "8") => JSON.parse(readFileSync(join(sandbox.home, ".fake-gh", "state.json"), "utf8")).prs[number];

  /** Starts an agent that offers the Deliver ask deliver's report would leave, as `A<n>` for this PR. */
  const offer = (number: "7" | "8") =>
    sandbox.run(
      [
        `Call the asks ask_create tool once with kind "pr", title "Deliver PR #${number}?", subscribe true,`,
        `links [{"label": "PR #${number}", "url": "https://github.com/${REPO}/pull/${number}"}],`,
        `body "PR #${number} is ready: review converged, CI green, QA evidence on head ${heads[number].slice(0, 7)}. Levels read: merged (default; no deploy workflow, ci.yml runs on pull_request).",`,
        `and one action: label "Deliver to merged", kind "send", recommended true,`,
        `prompt "Deliver PR #${number} to merged (offered at ${heads[number]})\n/deliver --pr ${number} --to merged".`,
        "Then reply with just the ask id.",
      ].join(" "),
    );

  /** Presses the ask's Deliver button and waits for the agent to finish carrying it out. */
  const click = async (ask: Ask, number: "7" | "8") => {
    const clicked = new RegExp(`\\[User\\] \\[asks\\][^\\n]*Deliver PR #${number} to merged`);
    await sandbox.act(ask.id, { verb: "action", actionId: ask.actions[0].id, workspaceId: ask.workspaceId });
    await sandbox.waitForTimeline(ask.ownerAgentId!, clicked);
    await sandbox.settle(ask.ownerAgentId!);
    await sandbox.quiet();
    await sandbox.wait(ask.ownerAgentId!);
    // The turn that carried out the click: everything after the human's [asks] message.
    const timeline = await sandbox.timeline(ask.ownerAgentId!);
    return { timeline, turn: timeline.slice(timeline.search(clicked)) };
  };

  beforeAll(async () => {
    const deliver = await pinnedSkill("fullstackhouse/skills", DELIVER_SHA, "skills/deliver");
    sandbox = await Sandbox.start(CASSETTE, { path: [join(E2E, "fake-gh")], skills: { deliver }, claudeModel: "sonnet" });
    heads = await fixture(sandbox);
  }, 300_000);

  afterAll(async () => {
    await sandbox?.stop();
    expect(sandbox?.misses ?? [], "requests missing from the cassette; run npm run e2e:record").toEqual([]);
  });

  it("adds qa-approved and merges with --admin, without a second ask", { timeout: 1_200_000 }, async () => {
    const agent = await offer("7");
    await sandbox.settle(agent);
    expect(sandbox.asks()).toEqual([expect.objectContaining({ id: "A1", ownerAgentId: agent })]);

    const { timeline } = await click(sandbox.asks()[0], "7");

    expect(calls().filter((call) => call.unsupported), "gh calls the fake does not answer").toEqual([]);
    const done = mutations();
    const merge = done.filter(({ argv }) => argv[0] === "pr" && argv[1] === "merge");
    expect(merge, "exactly one gh pr merge").toHaveLength(1);
    expect(merge[0].argv).toContain("--admin");
    const approved = done.findIndex(({ argv }) => argv.join(" ").includes("qa-approved") && !argv.includes("--remove-label"));
    expect(approved, "qa-approved added").toBeGreaterThanOrEqual(0);
    expect(approved, "qa-approved added before the merge").toBeLessThan(done.indexOf(merge[0]));
    // Only the review blocked the merge, and the clicker may merge past it: nobody is asked to review.
    expect(done.filter(({ argv }) => /--add-reviewer|requested_reviewers/.test(argv.join(" ")))).toEqual([]);
    expect(done.filter(({ argv }) => argv[0] === "workflow")).toEqual([]);
    expect(pr("7")).toMatchObject({ state: "MERGED", labels: expect.arrayContaining(["needs-qa", "qa-approved"]) });

    expect(sandbox.asks(), "no second ask").toHaveLength(1);
    expect(timeline).not.toMatch(NUDGED);

    // At the top level: the report still ends with Next moves, `Now:` on merged and no moves.
    const moves = nextMoves(finalMessage(timeline));
    expect(moves.block, "the final message ends with a Next moves block").not.toBe("");
    expect(moves.now, "its Now: line names merged").toMatch(/merged/i);
    expect(moves.moves, "no moves left").toEqual([]);
  });

  it("stops at do-not-merge and says so", { timeout: 600_000 }, async () => {
    const before = mutations().length;
    const agent = await offer("8");
    await sandbox.settle(agent);
    const ask = sandbox.asks().find((candidate) => candidate.ownerAgentId === agent)!;

    // Its own workspace, where its ask is A1 too.
    const { turn } = await click(ask, "8");

    expect(merges(), "no merge of PR #8").toHaveLength(1);
    expect(pr("8")).toMatchObject({ state: "OPEN", labels: ["needs-qa", "do-not-merge"] });
    expect(mutations().slice(before).filter(({ argv }) => argv[0] === "pr" && argv[1] === "edit")).toEqual([]);
    expect(turn).toMatch(/do-not-merge/);

    // Blocked: Next moves says so and names the label. The click was the QA sign-off, so nobody is asked to add it.
    const message = finalMessage(turn);
    const { block, now, moves } = nextMoves(message);
    expect(block, "the final message ends with a Next moves block").not.toBe("");
    expect(now, "its Now: line says blocked").toMatch(/blocked/i);
    expect(now, "its Now: line names do-not-merge").toMatch(/do-not-merge/);
    expect(moves, "a hard stop lists no moves").toEqual([]);
    expect(now, "its Now: line doesn't say qa-approved is missing").not.toMatch(NOW_WITHOUT_QA);
    // The click was the QA sign-off: nothing may say it, or qa-approved, is still to come.
    expect(message, "no ask to add qa-approved").not.toMatch(QA_STILL_NEEDED);
  });
});

/**
 * The agent's checkout: a repo with CI on pull requests and no deploy workflow (so its only level is `merged`), PR #7's
 * branch checked out, and review-loop's state saying the local review converged on its head. Its origin is a bare
 * repo in the sandbox, so fetches and pushes work. Fixed dates make every commit's sha the same on every run.
 */
async function fixture(sandbox: Sandbox): Promise<Record<"7" | "8", string>> {
  const project = sandbox.project;
  const env = { ...process.env, HOME: sandbox.home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  const git = async (...args: string[]) => (await exec("git", args, { cwd: project, env })).stdout.trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  const origin = join(sandbox.root, "origin.git");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin], { env });

  write(".gitignore", ".context/\nnode_modules/\n");
  write("AGENTS.md", "# app\n\nA greeting page.\n\n## Checks\n\n`npm test`, which CI (`.github/workflows/ci.yml`) runs on every pull request.\n\n## Merging\n\n- A PR labelled `needs-qa` merges only once it also carries `qa-approved`.\n- `do-not-merge` blocks a merge.\n");
  write("package.json", JSON.stringify({ name: "app", private: true, scripts: { test: "node test.js" } }, null, 2) + "\n");
  write("greet.js", 'export const greet = () => "Hello!";\n');
  write("test.js", 'import { greet } from "./greet.js";\nif (!greet("Ada").startsWith("Hello")) throw new Error("no greeting");\nconsole.log("ok");\n');
  write(".github/workflows/ci.yml", "name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "chore: greeting page");
  await git("remote", "add", "origin", origin);
  await git("push", "-q", "-u", "origin", "main");

  await git("checkout", "-q", "-b", "feat/banner");
  write("banner.js", 'export const banner = "Spring sale";\n');
  await git("add", ".");
  await git("commit", "-q", "-m", "feat: show a sale banner");
  await git("push", "-q", "-u", "origin", "feat/banner");

  await git("checkout", "-q", "main");
  await git("checkout", "-q", "-b", "feat/greeting");
  write("greet.js", 'export const greet = (name) => (name ? `Hello, ${name}!` : "Hello!");\n');
  await git("add", ".");
  await git("commit", "-q", "-m", "feat: greet visitors by name");
  await git("push", "-q", "-u", "origin", "feat/greeting");
  const heads = { "7": await git("rev-parse", "HEAD"), "8": await git("rev-parse", "feat/banner") };

  write(
    ".context/review-loop/feat-greeting/state.json",
    JSON.stringify(
      { verdict: "clean", sources: { local: { rounds: 1, quiet: 1, exit: "converged", reviewed_oid: heads["7"], last_round_severity: "none" } }, open: [] },
      null,
      2,
    ) + "\n",
  );
  write(".context/review-loop/feat-greeting/report.md", "# review-loop: feat/greeting\n\nRubric: correctness. Round 1: no findings. Exit: converged. Gate: npm test passed.\n");

  const time = "2026-01-02T00:00:00Z";
  const qa = (head: string) => ({
    author: { login: "owner" },
    createdAt: time,
    body: `## QA: pass\n\nTested head \`${head}\`: the home page greets "Ada" by name. Screenshot: https://example.com/qa/home.png`,
  });
  const base = {
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "BLOCKED",
    author: { login: "owner" },
    reviews: [],
    latestReviews: [],
    isCrossRepository: false,
    mergeCommit: null,
    mergedAt: null,
    checks: [{ name: "test", workflow: "CI", conclusion: "success" }],
  };
  const state = {
    time,
    repo: { owner: "e2e-fixture", name: "app", defaultBranch: "main", visibility: "PRIVATE" },
    viewer: "owner",
    requiredChecks: ["test"],
    prs: {
      "7": {
        ...base,
        number: 7,
        title: "feat: greet visitors by name",
        body: "Greets the visitor by name on the home page.",
        headRefName: "feat/greeting",
        headRefOid: heads["7"],
        labels: ["needs-qa"],
        comments: [qa(heads["7"])],
        files: ["greet.js"],
        mergeOid: "7".repeat(40),
      },
      "8": {
        ...base,
        number: 8,
        title: "feat: show a sale banner",
        body: "Adds a sale banner.",
        headRefName: "feat/banner",
        headRefOid: heads["8"],
        labels: ["needs-qa", "do-not-merge"],
        comments: [qa(heads["8"])],
        files: ["banner.js"],
        mergeOid: "8".repeat(40),
      },
    },
  };
  mkdirSync(join(sandbox.home, ".fake-gh"), { recursive: true });
  writeFileSync(join(sandbox.home, ".fake-gh", "state.json"), JSON.stringify(state, null, 2));
  return heads;
}
