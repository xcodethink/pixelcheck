import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude nested git worktrees so `npm test` doesn't double-count their
    // test files. Worktrees live under .claude/worktrees/ by convention.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
    // Setup runs before each test file: disables the result cache
    // (M9-4) globally so primitive tests don't accidentally persist or
    // hit cache from prior runs. The cache tests opt-in by clearing
    // the env var locally + using temp SQLite paths.
    setupFiles: ["./tests/setup.ts"],
    // M1-2: coverage instrumentation. Run with `npm run test:coverage`
    // (writes ./coverage report) or `npm run test:coverage:check`
    // (enforces global thresholds — fails CI if regressed).
    // Thresholds are intentionally conservative for v1; lifted as
    // M1-2 phases land. See ADR-017.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      // Schemas + thin re-export entry are pure type contracts already
      // exercised through schema.test.ts / consumer tests; counting them
      // against coverage thresholds dilutes the signal on real logic.
      exclude: [
        "src/cli.ts",
        "src/index.ts",
        "src/mcp/server.ts",
        "src/core/types.ts",
        "src/core/result-schema.ts",
        "src/**/*.d.ts",
      ],
      thresholds: {
        // Global floor — all files combined. Ratcheted per M1-2 phase
        // commit per ADR-017's contract ("raise the floor by at least
        // the gain it just produced"). Floor sits a few points below
        // current baseline so natural week-to-week fluctuation doesn't
        // trip the gate, but a real regression does.
        //
        // History:
        //   M1-2 Phase 1 entry (pre-tests): 51 / 45 / 54 / 52 → floor 50/45/50/50
        //   M1-2 Phase 1 close (12 modules):  57 / 51 / 60 / 58
        //   M1-2 Phase 2 critic:              58 / 51 / 61 / 59 → floor 55/50/55/55
        statements: 55,
        branches: 50,
        functions: 55,
        lines: 55,
      },
    },
  },
});
