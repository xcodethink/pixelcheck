/**
 * Integration test config (M9-3.2).
 *
 * Runs tests that need stricter process isolation than vitest's default
 * `pool: "threads"` provides. Currently scoped to the cross-process
 * file-lock race test; future entries (e.g., real-Chromium fixtures) will
 * be added here.
 *
 * Pool selection:
 *   - `pool: "forks"` gives each test file its own fresh Node process.
 *     Required for tests that `spawn` child processes — under the default
 *     threads pool, sibling worker threads share scheduling primitives
 *     and child processes contend, causing ~10-15% flake rate observed
 *     pre-T1.
 *   - `singleFork: true` further serialises forks for the rare cases
 *     where multiple integration files exist; avoids cross-fork resource
 *     contention.
 *   - `fileParallelism: false` is a redundancy belt — even if multiple
 *     test files exist, they run sequentially. Cheap insurance.
 *
 * To run:
 *   npm run test:integration
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests that need the forks pool (cross-process spawn isolation) plus
    // the chromium-launching e2e tests that aren't safe to run on every
    // ci.yml matrix config (chromium binary install cost). The integration
    // workflow installs chromium once on Ubuntu before invoking this config.
    include: [
      "tests/integration/file-lock-race.test.ts",
      "tests/integration/agent-loop-e2e.test.ts",
      "tests/integration/signals-e2e.test.ts",
      "tests/integration/whitebox-collector.test.ts",
      "tests/integration/performance-collector-integration.test.ts",
    ],
    // Forks pool — fresh Node process per file.
    // vitest 4+ moved poolOptions to top-level `forks` / `threads` keys.
    pool: "forks",
    forks: {
      isolate: true,
      singleFork: true,
    },
    // Belt-and-suspenders: also disable parallel file execution.
    fileParallelism: false,
    // Generous timeout: cross-process tests spawn ~3 children each running
    // 20-25 iterations with ~1-2 ms hold per iteration; combined with
    // file-lock acquire/release wait time, individual test cases can
    // legitimately take 30-60s on a busy machine.
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // Same setup as default suite (result-cache disable etc.) so the
    // integration tests share the same module-level state expectations.
    setupFiles: ["./tests/setup.ts"],
  },
});
