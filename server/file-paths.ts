import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * The app opens an inline-code path in an ask against the ask's workspace directory. Agents often write a file in
 * another worktree of the same repo (a spec PR's branch, say) and quote it relative to that worktree, so the link
 * finds nothing. Fixing it here keeps the rule out of the agent prompt and works when the agent forgets.
 */
export interface PathCheck {
  /** The body with every path found in exactly one other worktree made absolute. */
  body: string;
  /** Feedback for the agent's tool result: what was rewritten, and paths no worktree has. */
  notes: string[];
}

export interface PathEnv {
  exists(path: string): boolean;
  /** Absolute paths of the repo's worktrees, the workspace's own included or not. */
  worktrees(root: string): Promise<string[]>;
}

const FENCE = /(```[\s\S]*?(?:```|$))/;
const INLINE = /`([^`\n]+)`/g;
const LINE_SUFFIX = /(:\d+(?::\d+)?)$/;

/** A relative path with a folder and a file extension: `.ai/specs/x.md`, `src/a.ts:12`. Not URLs, globs or commands. */
export function relativeFileToken(token: string): { path: string; suffix: string } | null {
  const suffix = token.match(LINE_SUFFIX)?.[1] ?? "";
  const path = token.slice(0, token.length - suffix.length);
  if (isAbsolute(path) || path.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (!path.includes("/") || /[*?<>|"'$\\]/.test(path) || /\s{2}|^\s|\s$/.test(path)) return null;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return /^[^\s]*\.[a-z][a-z0-9]{0,7}$/i.test(last) && !last.startsWith(".") ? { path, suffix } : null;
}

export async function checkFilePaths(body: string, root: string, env: PathEnv): Promise<PathCheck> {
  const notes: string[] = [];
  const found = new Map<string, string | null>();
  let others: string[] | null = null;

  const lookup = async (path: string): Promise<string | null> => {
    if (found.has(path)) return found.get(path)!;
    let result: string | null = null;
    if (!env.exists(join(root, path))) {
      others ??= (await env.worktrees(root).catch(() => [])).filter((tree) => resolve(tree) !== resolve(root));
      const hits = others.map((tree) => join(tree, path)).filter((candidate) => env.exists(candidate));
      if (hits.length === 1) {
        result = hits[0]!;
        notes.push(`\`${path}\` is not in your workspace; linked it to ${result}.`);
      } else {
        const where = hits.length ? `${hits.length} other worktrees have it` : "no other worktree of this repo has it";
        notes.push(`\`${path}\` is not in your workspace (${root}) and ${where}, so its link opens nothing. Give its absolute path.`);
      }
    }
    found.set(path, result);
    return result;
  };

  const parts = body.split(FENCE);
  for (let i = 0; i < parts.length; i += 2) {
    const tokens = [...parts[i]!.matchAll(INLINE)].map((match) => match[1]!);
    const rewrites = new Map<string, string>();
    for (const token of tokens) {
      const file = relativeFileToken(token);
      if (!file) continue;
      const absolute = await lookup(file.path);
      if (absolute) rewrites.set(token, absolute + file.suffix);
    }
    if (rewrites.size) parts[i] = parts[i]!.replace(INLINE, (match, token: string) => (rewrites.has(token) ? `\`${rewrites.get(token)}\`` : match));
  }
  return { body: parts.join(""), notes };
}

const run = promisify(execFile);

export const diskPathEnv: PathEnv = {
  exists: existsSync,
  async worktrees(root) {
    const { stdout } = await run("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 5_000 });
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
  },
};
