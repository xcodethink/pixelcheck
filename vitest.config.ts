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
        // Global floor — all files combined. Bumped per M1-2 phase.
        // Floor set ≤ current baseline so the gate catches regression
        // without instantly blocking the build. Each subsequent M1-2
        // commit raises the floor a few points after pushing it up.
        // M1-2 Phase 1 entry baseline (pre-tests): ~51% stmt / 45% br /
        // 54% func / 52% line. ADR-017 records the upgrade path.
        statements: 50,
        branches: 45,
        functions: 50,
        lines: 50,
      },
    },
  },
});
