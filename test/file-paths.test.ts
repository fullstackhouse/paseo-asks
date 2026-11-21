import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFilePaths, diskPathEnv, relativeFileToken, type PathEnv } from "../server/file-paths";
import { Outbox } from "../server/outbox";
import { AsksService } from "../server/service";
import { AskStore } from "../server/store";

const ROOT = "/w/track";
const SPEC = "/w/spec";
const OTHER = "/w/other";

function env(files: string[], trees = [ROOT, SPEC, OTHER]): PathEnv & { listed: number } {
  const fake = {
    listed: 0,
    exists: (path: string) => files.includes(path),
    worktrees: async () => {
      fake.listed++;
      return trees;
    },
  };
  return fake;
}

describe("relativeFileToken", () => {
  it.each([
    [".ai/specs/x.md", { path: ".ai/specs/x.md", suffix: "" }],
    ["src/a.ts:12", { path: "src/a.ts", suffix: ":12" }],
    ["src/a.ts:12:3", { path: "src/a.ts", suffix: ":12:3" }],
    ["My Docs/plan.md", { path: "My Docs/plan.md", suffix: "" }],
  ])("takes %s", (token, expected) => expect(relativeFileToken(token)).toEqual(expected));

  it.each(["/abs/x.md", "~/x.md", "https://x.dev/a.md", "x.md", "src/*.ts", "a/b", "npm run e2e", "1/2.5", "a/.gitignore"])(
    "skips %s",
    (token) => expect(relativeFileToken(token)).toBeNull(),
  );
});

describe("checkFilePaths", () => {
  it("leaves a path that exists in the workspace", async () => {
    const fake = env([`${ROOT}/src/a.ts`]);
    expect(await checkFilePaths("see `src/a.ts`", ROOT, fake)).toEqual({ body: "see `src/a.ts`", notes: [] });
    expect(fake.listed).toBe(0);
  });

  it("makes a path found in exactly one other worktree absolute, keeping its line", async () => {
    const result = await checkFilePaths("read `.ai/specs/x.md:4` and `.ai/specs/x.md`", ROOT, env([`${SPEC}/.ai/specs/x.md`]));
    expect(result.body).toBe(`read \`${SPEC}/.ai/specs/x.md:4\` and \`${SPEC}/.ai/specs/x.md\``);
    expect(result.notes).toEqual([`\`.ai/specs/x.md\` is not in your workspace; linked it to ${SPEC}/.ai/specs/x.md.`]);
  });

  it("warns and keeps the path when no worktree or several have it", async () => {
    const none = await checkFilePaths("`a/b.md`", ROOT, env([]));
    expect(none.body).toBe("`a/b.md`");
    expect(none.notes[0]).toMatch(/no other worktree of this repo has it/);
    const both = await checkFilePaths("`a/b.md`", ROOT, env([`${SPEC}/a/b.md`, `${OTHER}/a/b.md`]));
    expect(both.body).toBe("`a/b.md`");
    expect(both.notes[0]).toMatch(/2 other worktrees have it/);
  });

  it("ignores code fences", async () => {
    const body = "```\n`a/b.md`\n```\nthen `a/b.md`";
    const result = await checkFilePaths(body, ROOT, env([`${SPEC}/a/b.md`]));
    expect(result.body).toBe(`\`\`\`\n\`a/b.md\`\n\`\`\`\nthen \`${SPEC}/a/b.md\``);
  });

  it("lists real git worktrees", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "asks-wt-")));
    const main = join(base, "main");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", "-b", "spec", join(base, "spec"));
    mkdirSync(join(base, "spec", "docs"));
    writeFileSync(join(base, "spec", "docs", "x.md"), "x");
    const result = await checkFilePaths("`docs/x.md`", main, diskPathEnv);
    expect(result.body).toBe(`\`${join(base, "spec", "docs", "x.md")}\``);
  });
});

describe("ask tools", () => {
  const setup = (checkPaths: ConstructorParameters<typeof AsksService>[4]) => {
    const dir = mkdtempSync(join(tmpdir(), "asks-"));
    const store = new AskStore(dir);
    const outbox = new Outbox(dir, { state: async () => "idle", send: async () => {} }, async () => {});
    return { store, service: new AsksService(store, outbox, async () => "wks_1", async () => false, checkPaths) };
  };

  it("rewrites bodies on create and update and reports it", async () => {
    const { store, service } = setup((_, body) => checkFilePaths(body, ROOT, env([`${SPEC}/a/b.md`])));
    const created = await service.callTool("agent-1", "ask_create", { kind: "question", title: "Q", body: "see `a/b.md`" });
    expect(created.text).toContain(`file paths: \`a/b.md\` is not in your workspace; linked it to ${SPEC}/a/b.md.`);
    expect(store.get("wks_1", "A1")?.body).toBe(`see \`${SPEC}/a/b.md\``);
    await service.callTool("agent-1", "ask_update", { id: "A1", body: "now `a/b.md`" });
    expect(store.get("wks_1", "A1")?.body).toBe(`now \`${SPEC}/a/b.md\``);
  });

  it("keeps the body when the check fails", async () => {
    const { store, service } = setup(async () => {
      throw new Error("no daemon");
    });
    const created = await service.callTool("agent-1", "ask_create", { kind: "question", title: "Q", body: "see `a/b.md`" });
    expect(created.isError).toBeUndefined();
    expect(store.get("wks_1", "A1")?.body).toBe("see `a/b.md`");
  });
});
