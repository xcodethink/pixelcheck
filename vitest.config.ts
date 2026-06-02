import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude nested git worktrees so `npm test` doesn't double-count their
    // test files. Worktrees live under .claude/worktrees/ by convention.
    //
    // tests/integration/file-lock-race.test.ts is excluded because it needs
    // the stricter `pool: forks` config; it runs via `npm run test:integration`
    // (vitest.integration.config.ts).
    //
    // tests/integration/playwright/** is excluded because it uses
    // @playwright/test (separate test runner with its own assertion API);
    // it runs via `npm run test:integration:playwright` (playwright.config.ts).
    //
    // tests/integration/agent-loop-e2e.test.ts and signals-e2e.test.ts launch
    // real chromium via Playwright. The default `npm test` ci.yml matrix
    // (4 OS × 3 Node = 12 configs) does NOT install chromium — adding
    // `npx playwright install` × 12 would 12x the install cost. They run
    // via `npm run test:integration` from integration.yml, which already
    // installs chromium once on Ubuntu. See vitest.integration.config.ts.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/worktrees/**",
      "tests/integration/file-lock-race.test.ts",
      "tests/integration/playwright/**",
      "tests/integration/agent-loop-e2e.test.ts",
      "tests/integration/signals-e2e.test.ts",
      "tests/integration/whitebox-collector.test.ts",
      "tests/integration/performance-collector-integration.test.ts",
    ],
    // T3 cassette tests (tests/integration/llm-cassettes.test.ts) self-
    // skip when neither AUDIT_E2E_REPLAY=1 nor AUDIT_E2E_RECORD=1 is
    // set — they ship in the default suite as one "skipped" line during
    // `npm test`, but only execute via `npm run test:e2e:replay` /
    // `test:e2e:record` (see package.json scripts).
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
        // Vendored stealth-core has its own tests at the upstream source;
        // counting it here would dilute the auditor's own coverage signal.
        // See ADR-032.
        "src/vendor/**",
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
        //   M1-2 Phase 2 llm:                 60 / 53 / 62 / 60 → floor 58/52/58/58
        //   M1-2 Phase 2 instruction-mutator: 61 / 54 / 63 / 61 → floor 59/53/59/59
        //   M1-2 Phase 2 reporter-spa:        61 / 54 / 63 / 62 → floor unchanged
        //     (sub-1pt gain — ADR-017 contract bumps only on ≥ 1pt gains;
        //     keeps headroom for natural fluctuation)
        //   M2-1/2-3/2-4/2-5/2-6/M2-2/M5-7/M6-7 — sub-1pt or non-coverage tasks; floor unchanged
        //   M1-2 Phase 3 recorder:            67 / 59 / 71 / 68 → floor 60/54/60/60
        //     (recorder.ts 0% → 82.82% stmt; +1.40 project gain)
        //   M1-2 Phase 3 reporter (T12):      70 / 61 / 74 / 71 → floor 61/55/61/61
        //     (reporter.ts 0% → 99.11% stmt; +2.82 project gain; +1pt per Wave 6 phase)
        //   M1-2 Phase 3 computer-use (T16): 72 / 63 / 75 / 73 → floor 62/56/62/62
        //     (computer-use.ts 2.4% → 92.07% stmt; +2.34 project gain; +1pt)
        //   M1-2 Phase 3 runner (T13):       74 / 64 / 77 / 75 → floor 63/57/63/63
        //     (runner.ts 0.7% → 86.92% stmt; +2.09 project gain; +1pt)
        //   M1-2 Phase 3 handlers (T15):     78 / 67 / 80 / 79 → floor 64/58/64/64
        //     (handlers/index.ts 0.4% → 90.04% stmt; +3.43 project gain; +1pt)
        //   M1-2 Phase 3 agent-loop (T14):   81 / 69 / 81 / 82 → floor 65/59/65/65
        //     (agent-loop.ts 0.4% → 77.35% stmt; +2.86 project gain; CROSSED 80%
        //      on stmt/funcs/lines; Wave 6 close: floor 60/54/60/60 → 65/59/65/65)
        //   T14 follow-up + vendor exclude:  81 / 69 / 81 / 82 → floor 66/60/66/66
        //     (agent-loop +8 tests for criterion verification dispatcher /
        //      screenshot catch / micro-replan escalate; agent-loop 77.35→88.46%;
        //      vendor exclude per ADR-032 keeps coverage signal focused)
        //   Audit 2026-06-02 (D6-M1/M2): the floor had drifted to ~13-15pts
        //     below the actual baseline (79.1 / 67.64 / 80.67 / 80.59), so a
        //     large regression wouldn't trip it — defeating the gate. Re-set
        //     to ~5pts below actual, restoring ADR-017's "a few points below"
        //     intent (catches a real regression; still absorbs local/CI variance).
        //   Audit 2026-06-02 G3 (MCP-tool + observer + benchmark tests): MCP
        //     tools 5-10%→20-94%, observer dashboards/doctor 0/22%→100%,
        //     get_last_report/see→94%. Baseline rose to 81.1 / 69.8 / 82.86 /
        //     82.67; ratchet the floor +2 (keeping the same ~5-6pt gap).
        statements: 76,
        branches: 64,
        functions: 77,
        lines: 77,
      },
    },
  },
});
