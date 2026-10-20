import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLASSIFIER_PROMPT } from "../server/nudge";
import { startProxy, upstreamFromEnv, type Mode, type Proxy } from "./proxy";

const exec = promisify(execFile);
const E2E = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(E2E, "..");
const BIN = join(E2E, "node_modules", ".bin");
const PASEO = join(BIN, "paseo");

// Recording reads its key from e2e/.env (gitignored) when it is not in the environment.
if (existsSync(join(E2E, ".env"))) process.loadEnvFile(join(E2E, ".env"));

export const MODE: Mode = process.env.E2E_MODE === "record" ? "record" : "replay";

export type Ask = { id: string; title: string; kind: string; status: string; ownerAgentId?: string; actions: { id: string; label: string; kind: string }[] };

/**
 * A throwaway Paseo daemon with this plugin installed, in its own home, talking to the
 * record/replay proxy instead of Anthropic. Nothing touches the developer's ~/.paseo or ~/.claude.
 */
export class Sandbox {
  private constructor(
    readonly root: string,
    readonly project: string,
    private readonly paseoHome: string,
    private readonly daemon: ChildProcess,
    private readonly proxy: Proxy,
  ) {}

  static async start(name: string): Promise<Sandbox> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-asks-e2e-")));
    const home = join(root, "home");
    const paseoHome = join(root, "paseo");
    const project = join(root, "project");
    for (const dir of [home, paseoHome, project]) mkdirSync(dir, { recursive: true });
    await exec("git", ["init", "-q"], { cwd: project });

    const upstream = MODE === "record" ? upstreamFromEnv(process.env) : undefined;
    const proxy = await startProxy({ mode: MODE, cassette: join(E2E, "cassettes", `${name}.json`), root, upstream });
    const port = await freePort();
    writeFileSync(
      join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { injectIntoAgents: false } },
        pluginsEnabled: true,
      }),
    );

    const daemon = spawn(PASEO, ["daemon", "run", "--home", paseoHome], {
      env: daemonEnv({ home, proxy: proxy.url }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log: string[] = [];
    daemon.stdout!.on("data", (chunk) => log.push(String(chunk)));
    daemon.stderr!.on("data", (chunk) => log.push(String(chunk)));

    const sandbox = new Sandbox(root, project, paseoHome, daemon, proxy);
    try {
      await waitFor("daemon listening", async () => (await sandbox.paseo("daemon", "status")).includes("running"), 30_000);
      await sandbox.paseo("plugin", "install", PLUGIN);
      await waitFor("plugin running", async () => /paseo-asks\s+running/.test(await sandbox.paseo("plugin", "ls")), 30_000);
    } catch (error) {
      await sandbox.stop();
      throw new Error(`${(error as Error).message}\n--- daemon output ---\n${log.join("").slice(-4000)}`);
    }
    return sandbox;
  }

  /** Runs the paseo CLI against this sandbox's daemon. */
  async paseo(...args: string[]): Promise<string> {
    const { stdout } = await exec(PASEO, [...args, "--home", this.paseoHome], { maxBuffer: 16 << 20 });
    return stdout;
  }

  /** Starts a Haiku agent in the sandbox project and waits for its first turn to end. */
  async run(prompt: string): Promise<string> {
    const out = await this.paseo(
      "run", "--cwd", this.project, "--provider", "claude", "--model", "haiku",
      "--mode", "bypassPermissions", "--wait-timeout", "3m", "--json", prompt,
    );
    return JSON.parse(out.slice(out.indexOf("{"))).agentId;
  }

  async wait(agentId: string): Promise<void> {
    await this.paseo("wait", agentId);
  }

  /** The agent's timeline as the CLI prints it: `[User] ...`, `[tool] {...}`, and replies. */
  async timeline(agentId: string): Promise<string> {
    return this.paseo("logs", agentId);
  }

  /** Waits until the timeline matches, then until the agent is idle again. */
  async waitForTimeline(agentId: string, pattern: RegExp, timeoutMs = 120_000): Promise<string> {
    await waitFor(`timeline to match ${pattern}`, async () => pattern.test(await this.timeline(agentId)), timeoutMs);
    await this.wait(agentId);
    return this.timeline(agentId);
  }

  /** The asks stored for every workspace in this sandbox. */
  asks(): Ask[] {
    const dir = join(this.paseoHome, "plugin-data", "asks", "workspaces");
    if (!existsSync(dir)) return [];
    return readdir(dir).flatMap((file) => JSON.parse(readFileSync(join(dir, file), "utf8")).asks);
  }

  workspaceOf(askId: string): string {
    const dir = join(this.paseoHome, "plugin-data", "asks", "workspaces");
    const file = readdir(dir).find((file) => JSON.parse(readFileSync(join(dir, file), "utf8")).asks.some((ask: Ask) => ask.id === askId));
    if (!file) throw new Error(`No ask ${askId}`);
    return file.replace(/\.json$/, "");
  }

  /** What a button press in Paseo does, through the plugin's terminal endpoint. */
  async act(askId: string, input: { verb: "action" | "done" | "drop" | "reply"; actionId?: string; note?: string }): Promise<unknown> {
    const { port, token } = JSON.parse(readFileSync(join(this.paseoHome, "plugin-data", "asks", "server.json"), "utf8"));
    const res = await fetch(`http://127.0.0.1:${port}/act`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: this.workspaceOf(askId), id: askId, ...input }),
    });
    if (!res.ok) throw new Error(`/act ${res.status}: ${await res.text()}`);
    return res.json();
  }

  pluginLogs(): Promise<string> {
    return this.paseo("plugin", "logs", "paseo-asks");
  }

  /** Gives the plugin's turn-end hooks time to land (a nudge, an outbox flush), then waits for the agent to be idle. */
  async settle(agentId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await this.wait(agentId);
  }

  /** How many times the nudge classifier (a child agent prompted with CLASSIFIER_PROMPT) has had its answer. */
  classifierCalls(): number {
    const opening = CLASSIFIER_PROMPT.slice(0, 60);
    return this.proxy.answered.filter(({ messages }) => JSON.stringify(messages[0]?.content ?? "").includes(opening)).length;
  }

  /** Waits for the classifier to answer once more than `before`, then for the agent to settle on what the plugin did with it. */
  async waitForClassifier(agentId: string, before: number): Promise<void> {
    await waitFor("the nudge classifier", () => this.classifierCalls() > before, 120_000);
    await this.settle(agentId);
  }

  /** Requests the cassette could not answer; a non-empty list means the scenario needs re-recording. */
  get misses() {
    return this.proxy.misses;
  }

  async stop(): Promise<void> {
    await this.paseo("daemon", "stop").catch(() => {});
    if (this.daemon.exitCode === null) this.daemon.kill();
    await this.proxy.close();
    if (!process.env.E2E_KEEP) rmSync(this.root, { recursive: true, force: true });
  }
}

function daemonEnv({ home, proxy }: { home: string; proxy: string }): NodeJS.ProcessEnv {
  // Start from a clean slate so the developer's Claude and Paseo settings cannot leak in.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "TERM", "USER", "SHELL"]) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    HOME: home,
    PATH: `${BIN}:${env.PATH ?? "/usr/bin:/bin"}`,
    ANTHROPIC_BASE_URL: proxy,
    // The proxy holds the real credentials; agents get the same dummy key in record and replay.
    ANTHROPIC_API_KEY: "e2e-dummy",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    PASEO_DICTATION_ENABLED: "false",
    PASEO_VOICE_MODE_ENABLED: "false",
  });
  return env;
}

export async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await Promise.resolve(check()).catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function readdir(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".json"));
}
