// Installs the FSH Paseo CLI + daemon bundle into e2e/node_modules, so the e2e runs on the host we ship
// against (FSH builds supply SDK exports, like latestTurn, that npm's @getpaseo/* don't have yet).
// Runs before every e2e run; a no-op when the pinned bundle is already installed. Copied in paseo-status.
//
// E2E_PASEO_CHECKOUT=<path to a built fullstackhouse/paseo checkout> (`npm run build:server` there) installs
// that build instead, to test or record against a host change that no release carries yet.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// TODO: bump to the first fsh-cli release that includes fullstackhouse/paseo branch merry-porcupine
// (Codex is told to look up alwaysLoad MCP tools); until then the Codex scenario in unprompted.e2e.ts is
// skipped on this host, see CODEX_FIX there.
const TAG = "fsh-cli-0.15.3-0bd77c5";
const SHA256 = "f92c0f6c8704b889bf4ecfd97e831fb086d55a7c440765aaecb6d5b57c8864df";
const URL = `https://github.com/fullstackhouse/paseo/releases/download/${TAG}/paseo-${TAG}.tgz`;
const PACKAGES = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];

const e2e = dirname(fileURLToPath(import.meta.url));
const marker = join(e2e, "node_modules", ".fsh-host");
const checkout = process.env.E2E_PASEO_CHECKOUT ? resolve(process.env.E2E_PASEO_CHECKOUT) : null;
const wanted = checkout ? `local:${checkout}` : TAG;
// A local build changes under the same path, so it is reinstalled every run. `npm install` in e2e/ prunes
// the host packages but keeps the marker, hence the binary check.
const installed = existsSync(join(e2e, "node_modules", ".bin", "paseo")) && existsSync(marker) && readFileSync(marker, "utf8");
if (!checkout && installed === TAG) process.exit(0);

const dir = join(e2e, ".fsh-host");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
if (checkout) {
  // The same tarballs the fsh-cli release bundles (.github/workflows/fsh-cli.yml in the paseo repo).
  for (const name of PACKAGES)
    execFileSync("npm", ["pack", `--workspace=@getpaseo/${name}`, "--pack-destination", dir], { cwd: checkout, stdio: ["ignore", "ignore", "inherit"] });
} else {
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`Download of ${URL} failed: ${response.status}`);
  const bundle = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bundle).digest("hex");
  if (actual !== SHA256) throw new Error(`${TAG} sha256 is ${actual}, expected ${SHA256}`);
  writeFileSync(join(dir, "bundle.tgz"), bundle);
  execFileSync("tar", ["-xzf", "bundle.tgz"], { cwd: dir });
}
const packs = readdirSync(dir).filter((name) => name.startsWith("getpaseo-") && name.endsWith(".tgz"));
execFileSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", ...packs.map((name) => join(dir, name))], {
  cwd: e2e,
  stdio: "inherit",
});
writeFileSync(marker, wanted);
