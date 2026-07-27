# ADR-029 — Cross-process file-lock race tests move to a dedicated forks-pool config

- **Status**: Accepted
- **Date**: 2026-05-01

## Context

`tests/file-lock.test.ts` carried a known flake for six months after M9-3
shipped: roughly a 10–15% failure rate under the full parallel vitest run, but
20/20 passes when run alone. Each task wrap-up marked it in the status and
changelog files as unrelated follow-up work — 18 times in total.

**Root cause:**

- The two affected cases live in `describe("withFileLock — cross-process
  race")`. They `spawn` real Node child processes that race over a shared
  lockfile.
- vitest 4 defaults to `pool: "threads"`, so all test files run as worker
  threads inside one Node process, sharing OS-level scheduling primitives —
  notably file descriptors and process groups.
- When a sibling worker thread also spawns children (other integration tests
  such as the agent-loop and signals end-to-end suites), those children contend
  with the file-lock race children. Lock acquisition then fails intermittently,
  and the test — which expects two child processes to score 25 successes each,
  50 in total — observes 49 or fewer.
- This is contention in the test environment, not a bug in the file-lock
  implementation.

**Confirmation from prior art:**

- The vitest 4 migration documentation states that `pool: "forks"` with
  `isolate: true` is the standard arrangement for tests that spawn child
  processes.
- better-sqlite3's own suite runs comparable tests serially in a single fork
  with `fileParallelism: false`.
- vitest issue #8766 records `child_process.spawn` flakiness under the threads
  pool as a known design trade-off.

## Decision

Split precisely along the failure boundary:

- **`tests/file-lock.test.ts`** keeps the default threads pool and retains the
  single-process and sync variants, which are fast and have never flaked.
- **`tests/integration/file-lock-race.test.ts`** is a new file holding the two
  cross-process race cases, run under the forks pool.
- **`vitest.integration.config.ts`** is a new config with `pool: "forks"`,
  `forks.isolate: true`, `forks.singleFork: true` and `fileParallelism: false`.
  Its `include` names the race file specifically rather than sweeping
  `tests/integration/`, because the agent-loop and signals suites are stable
  under the threads pool. `testTimeout` is 90s to cover child spawn and
  iteration.
- **`vitest.config.ts`** excludes the race file, leaving other integration tests
  untouched.
- **`package.json`** gains `test:integration`, which runs the new config.

The default `npm test` therefore runs the whole suite minus those two cases, and
`npm run test:integration` runs them on their own.

## Verification

- [x] `npm run test:integration` passes 2/2.
- [x] **20 consecutive runs of `npm run test:integration`, 0 failures** — the
      substantive proof that the flake is gone.
- [x] Default `npm test` fully green, with the agent-loop and signals suites
      still passing under the threads pool.
- [x] No new dependencies; this uses built-in vitest features.

## Alternatives rejected

1. **Move all of `tests/file-lock.test.ts` into `tests/integration/`** —
   wasteful: 175 lines of stable single-process and sync tests would leave the
   default suite and drop its coverage.
2. **Use `pool: "threads"` with `singleThread: true`** — serialises every test,
   not just the racing ones, taking the suite from ~5s to 60s+.
3. **Use a vitest workspace / projects config** — supported in v4, but more
   configuration than one file needs.
4. **Wrap or mock `spawnSync`** — that stops testing the cross-process race at
   all, which is equivalent to deleting the test.
5. **Move the agent-loop and signals end-to-end tests into the forks pool too** —
   they have never flaked under threads; an overreaction.
6. **Set `fileParallelism: false` globally** — serialises the whole suite and
   badly degrades the development loop.
7. **Accept the flake and add vitest retries** — retries turn a known flake into
   a concealed bug. Fixed properly instead.

## Consequences

- Six months of accumulated debt is closed; the 18 "unrelated to this task"
  markers stop being renewed.
- The test signal is honest again: a green default run means green, and nobody
  learns to shrug off "just run it again".
- The CI gate can be tightened — the workflow can require both `npm test` and
  `npm run test:integration` green with no retries.
- One extra config file (~30 LoC) to maintain, which is an acceptable cost.
- Future real end-to-end tests that also need forked processes can join the same
  config's `include` list rather than inventing another one.

## Files added / changed

- `vitest.integration.config.ts` — new (~30 LoC)
- `tests/integration/file-lock-race.test.ts` — new (~115 LoC, migrated whole from the original file, plus a header explaining the split)
- `tests/file-lock.test.ts` — race section removed, unused `spawnSync` import dropped, header added explaining the split
- `vitest.config.ts` — excludes the race file
- `package.json` — adds the `test:integration` script
