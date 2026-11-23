import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** No uncommitted or untracked files. Unreadable counts as dirty: the caller would delete what it can't see. */
export async function isCleanWorktree(directory: string): Promise<boolean> {
  try {
    // Untracked files count whatever status.showUntrackedFiles says: an explainer's notes are untracked.
    const { stdout } = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: directory, timeout: 10_000 });
    return stdout.trim() === "";
  } catch {
    return false;
  }
}
