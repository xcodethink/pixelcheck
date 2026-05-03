# ADR-032 — Vendor stealth-core into ai-browser-auditor

**Status**: Accepted
**Date**: 2026-05-02
**Closes risks**: R-NEW-V1-SHIP-1
**Task**: T31.5

## Context

`stealth-core` is a shared anti-detection / fingerprint library used by 5
of @xcodethink's projects (sibling projects, sibling project, ai-browser-auditor). Until v1.0-rc1 dogfood (T31, 2026-05-02)
it lived as a sibling git repo at `<sibling-stealth-core>`
and was wired into ai-browser-auditor's `package.json` via:

```json
"stealth-core": "file:../stealth-core"
```

This works for local development inside the monorepo-shaped layout, but
**breaks any user who installs ai-browser-auditor from the npm tarball**
because `stealth-core` is not on npm's public registry. T31 caught
exactly this: `npm install <tarball>` in a fresh tmp dir produced
`ERR_MODULE_NOT_FOUND: Cannot find package 'stealth-core'`.

Before v1.0 ship we must resolve this. Three options were considered:

### A. Publish stealth-core to npm public

- ✅ Single source of truth across 5 projects
- ✅ Industry-standard packaging
- ❌ **Public release of anti-detection / fingerprint library** — the
  library's value (evading commercial bot-detection) directly correlates
  with the secrecy of its profile catalogue. Open-publishing it lets
  anti-bot vendors fingerprint-match the profile distribution and
  preferentially flag traffic using it. All 5 dependent projects would
  be affected.
- ❌ Requires committing stealth-core to a public versioning cadence
  (SemVer, breaking-change discipline) before its API has stabilised.

### B. Vendor stealth-core into ai-browser-auditor's source tree (chosen)

- ✅ Single tarball install — no extra registry / token needed.
- ✅ Source stays private (only the compiled `dist/vendor/stealth-core/`
  ships in tarballs; the typed source is internal to ai-browser-auditor).
- ✅ No new package to maintain.
- ✅ Aligned with how the other 4 dependent projects already vendor
  stealth-core (each has a `vendor/stealth-core/` copy).
- ❌ Updating stealth-core requires re-bundling + re-publishing
  ai-browser-auditor. In v1.0 this is not a concern because stealth-core
  is stable across all 5 dependents.
- ❌ Five copies of stealth-core can drift over time. Mitigation: the
  monorepo-style refresh script (planned for v1.x) re-syncs all 5
  vendor dirs from the canonical `<sibling-stealth-core>`
  source.

### C. Inline stealth-core source into `src/`

- ✅ Single source tree, no vendor/ directory.
- ❌ Loses sharing entirely. Each of the 5 projects must maintain an
  independent copy with no contract on how to keep them in sync —
  bug fixes 5 places. Strictly worse than B.

## Decision

**Vendor stealth-core into `src/vendor/stealth-core/`.**

The 6 source files (`browser.ts` / `fingerprints.ts` / `index.ts` /
`launch-options.ts` / `retry.ts` / `stealth-script.ts`) are copied
verbatim. TypeScript compiles them as part of ai-browser-auditor's
single `tsc` invocation; the compiled output lands at
`dist/vendor/stealth-core/` and ships inside the tarball
(via the existing `files: ["dist/", ...]` whitelist).

Two import sites updated:

- `src/core/stagehand-wrapper.ts`: `from "stealth-core"` →
  `from "../vendor/stealth-core/index.js"`
- `src/handlers/index.ts`: same rewrite

Removed: `"stealth-core": "file:../stealth-core"` from
`package.json.dependencies`. Lockfile regenerated to drop the
extraneous symlink.

## Consequences

### Verified (T31 re-run 2026-05-02)

- `npm pack` size: 555 KB → **570 KB / 333 files** (+15 KB / +18 files
  — the compiled vendor copies)
- Fresh-dir `npm install <tarball>` in `/tmp/abx-dogfood-postfix-…`
  succeeds with no ERR_MODULE_NOT_FOUND
- `npx ai-audit --help` / `doctor` / `init` all functional from the
  installed package (not just dev-tree)
- Full vitest suite 1833/1833 ✓ — no behavioural change because vendor
  files compile to the same JavaScript as the previous npm-resolved copy

### Updating stealth-core

When the canonical `<sibling-stealth-core>` changes:

1. Run the refresh sync (manual for now; `scripts/sync-vendor.sh` planned
   for v1.x):
   ```
   cp <sibling-stealth-core>/src/*.ts \
      <ai-browser-auditor>/src/vendor/stealth-core/
   ```
2. `npm run typecheck && npm test`
3. Commit + bump ai-browser-auditor patch version
4. Re-publish

The other 4 vendoring projects (sibling project, etc.) follow the same
manual refresh today; the v1.x sync script will unify all 5.

### Drift detection

A future v1.x lint check (planned `scripts/check-vendor-drift.ts`) will
diff `src/vendor/stealth-core/` against `<sibling-stealth-core>/src/`
and exit non-zero if they diverge. This is monorepo-equivalent to
"vendor-update PRs" used by Bazel / Buck repos.

### Why not go fully monorepo with workspaces

A real npm workspaces / pnpm monorepo would be cleaner, but:

- All 5 dependent projects predate the workspace decision and have
  independent CI / release / branching
- Switching to a monorepo would touch all 5 projects + restructure
  `~/Developer/` layout — out of scope for v1.0
- The vendor-and-sync pattern is the conservative middle ground; v2.0
  can promote to workspaces if the maintenance cost of 5 vendor copies
  becomes painful

## Related ADRs

- ADR-018 — Result Schema versioning (vendor copies don't affect public
  API contract)
- ADR-027 — Zod v3 lock-in (similar "ship now, evolve later" decision)
- ADR-028 — Stagehand v3 deferred (similar reasoning: ship blocker
  resolved with the smallest move)
