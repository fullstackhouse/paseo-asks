import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Files in the worktree that are not committed, untracked ones included whatever status.showUntrackedFiles says.
 * Null when git can't tell (not a repo, git missing): the caller must not treat that as clean.
 */
export async function uncommittedFiles(directory: string): Promise<string[] | null> {
  try {
    // -z: paths come raw (no quoting of spaces or non-ASCII), each entry NUL-terminated; a rename's old path follows it.
    const { stdout } = await exec("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: directory, timeout: 10_000 });
    const entries = stdout.split("\0");
    const files: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (!entry) continue;
      files.push(entry.slice(3));
      if (entry[0] === "R" || entry[0] === "C") index++;
    }
    return files;
  } catch {
    return null;
  }
}
