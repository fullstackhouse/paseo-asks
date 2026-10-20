import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.e2e.ts"],
    exclude: ["node_modules/**"],
    // One daemon per file; files run one after another so recordings stay readable.
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
