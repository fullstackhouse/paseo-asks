import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Files in the worktree that are not committed, untracked ones included whatever status.showUntrackedFiles says.
 * Null when git can't tell (not a repo, git missing): the caller must not treat that as clean.
 */
export async function uncommittedFiles(directory: string): Promise<string[] | null> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: directory, timeout: 10_000 });
    return stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
  } catch {
    return null;
  }
}
