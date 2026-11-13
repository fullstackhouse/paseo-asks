import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, type Provider } from "./harness";

const exec = promisify(execFile);
const NUDGED = /\[User\] \[asks\] A check found that your last reply leaves something for the human/;

/**
 * Whether the host tells Codex to look up alwaysLoad MCP tools (fullstackhouse/paseo, branch
 * merry-porcupine). Without it Codex 0.166 defers ask_create behind its tool search and never sees the
 * asks rules, so the Codex scenario fails. TODO: drop this and the skip once fsh-host.mjs pins a release with it.
 */
function hostTellsCodexToLoadMcpTools(): boolean {
  const dir = join(import.meta.dirname, "node_modules", "@getpaseo", "server", "dist", "server", "server", "agent", "providers", "codex");
  return existsSync(dir) && readdirSync(dir).some((file) => file.endsWith(".js") && readFileSync(join(dir, file), "utf8").includes("loaded on demand"));
}
const CODEX_FIX = hostTellsCodexToLoadMcpTools() || process.env.E2E_CODEX === "1";

// No prompt here mentions asks: the agent has to create one because its server instructions say so.
// Asserted on the first turn alone, since the plugin's "Asks check" nudge would otherwise mask a miss.
// One sandbox (and cassette) per provider, so each starts from an empty project.
const cases: { provider: Provider; skip: boolean }[] = [
  { provider: "claude", skip: false },
  { provider: "codex", skip: !CODEX_FIX },
];

for (const { provider, skip } of cases) {
  describe.skipIf(skip)(`${provider}: asks an agent creates on its own`, () => {
    let sandbox: Sandbox;

    beforeAll(async () => {
      sandbox = await Sandbox.start(`unprompted-${provider}`);
    });

    afterAll(async () => {
      await sandbox?.stop();
      expect(sandbox?.misses ?? [], "requests missing from the cassette; run npm run record").toEqual([]);
    });

    it("records the decision a task leaves for the human", async () => {
      const agent = await sandbox.run(
        "Add an MIT LICENSE file for Acme Ltd, 2026, and commit it. I have not decided yet whether we should use Apache-2.0 instead; recommend one, and I will make the call.",
        provider,
      );

      // Taken as the first turn ends, before the nudge classifier could start a second one.
      const asks = sandbox.asks().filter((ask) => ask.ownerAgentId === agent);
      const firstTurn = (await sandbox.timeline(agent)).split(NUDGED)[0]!;
      expect(asks, `no ask after the first turn:\n${firstTurn}`).not.toEqual([]);
      expect(firstTurn).toMatch(/ask_create/);
      const { stdout } = await exec("git", ["log", "--name-only", "--format=%s"], { cwd: sandbox.project });
      expect(stdout).toMatch(/^LICENSE/m);
    });
  });
}
