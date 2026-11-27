import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findGh } from "../server/github";

describe("findGh", () => {
  it("prefers the gh on the daemon's PATH, so it uses the same gh as the host's PR reads", () => {
    const empty = mkdtempSync(join(tmpdir(), "asks-path-"));
    const bin = mkdtempSync(join(tmpdir(), "asks-gh-"));
    writeFileSync(join(bin, "gh"), "#!/bin/sh\n");
    chmodSync(join(bin, "gh"), 0o755);
    expect(findGh([empty, bin].join(delimiter))).toBe(join(bin, "gh"));
  });

  it("falls back to the usual install locations on a bare PATH", () => {
    const found = findGh("");
    expect(found === null || ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].includes(found)).toBe(true);
  });
});
