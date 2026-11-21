import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Test files share one database; run them one at a time. Concurrency is
    // exercised *inside* each test, against real Postgres connections.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
