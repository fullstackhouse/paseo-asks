// Installs the FSH Paseo CLI + daemon bundle into e2e/node_modules, so the e2e runs on the host we ship
// against (FSH builds supply SDK exports, like latestTurn, that npm's @getpaseo/* don't have yet).
// Runs before every e2e run; a no-op when the pinned bundle is already installed. Copied in paseo-status.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "fsh-cli-0.15.3-0bd77c5";
const SHA256 = "f92c0f6c8704b889bf4ecfd97e831fb086d55a7c440765aaecb6d5b57c8864df";
const URL = `https://github.com/fullstackhouse/paseo/releases/download/${TAG}/paseo-${TAG}.tgz`;

const e2e = dirname(fileURLToPath(import.meta.url));
const marker = join(e2e, "node_modules", ".fsh-host");
if (existsSync(marker) && readFileSync(marker, "utf8") === TAG) process.exit(0);

const response = await fetch(URL);
if (!response.ok) throw new Error(`Download of ${URL} failed: ${response.status}`);
const bundle = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha256").update(bundle).digest("hex");
if (actual !== SHA256) throw new Error(`${TAG} sha256 is ${actual}, expected ${SHA256}`);

const dir = join(e2e, ".fsh-host");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "bundle.tgz"), bundle);
execFileSync("tar", ["-xzf", "bundle.tgz"], { cwd: dir });
const packs = readdirSync(dir).filter((name) => name.startsWith("getpaseo-") && name.endsWith(".tgz"));
execFileSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", ...packs.map((name) => join(dir, name))], {
  cwd: e2e,
  stdio: "inherit",
});
writeFileSync(marker, TAG);
