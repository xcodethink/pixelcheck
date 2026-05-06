# ADR-035 — Stagehand v3.3.0 migration with Playwright + CDP bridge

> **Numbering note**: Originally filed as ADR-029 alongside the stagehand v3 PR
> (#15) on 2026-05-03. Renumbered to ADR-035 on 2026-05-05 because
> ADR-029-file-lock-race-isolation (the M9-3.2 file-lock fix, Wave 1) had
> already taken the 029 slot two days earlier (commit `91b2805`, 2026-05-01).
> First-to-commit wins; this ADR moves to the next available slot after
> ADR-034. All references in CHANGELOG / SECURITY.md / docs/releases /
> ADR-028 have been updated.

- **Status**: Accepted
- **Date**: 2026-05-03
- **Task**: T-NEW-1 (originally deferred per [ADR-028](ADR-028-stagehand-v3-deferred.md))
- **Supersedes**: ADR-028's deferral decision

## Context

[ADR-028](ADR-028-stagehand-v3-deferred.md) deferred the Stagehand v3
migration to "v1.1 early task" because v3 has substantial breaking
changes (act/observe signature, BYO Playwright, wrapper rewrite, real
e2e smoke required). At the time, three transitive moderate
vulnerabilities (`ai` SDK file-type bypass, `jsondiffpatch`
HtmlFormatter XSS, one low) were waived as non-exploitable in our
usage pending the v3 upgrade.

In May 2026 the deferred work pulled forward, triggered by:
1. Stagehand 3.3.0 stable release (peer-deps now `zod ^3.25.76 || ^4.2.0`,
   no more dotenv pin, `ai` / `jsondiffpatch` fully replaced).
2. Empirical validation that override-based dotenv 17 + zod 3.25.76
   shipped in PR #12 was a workaround, not the right fix.
3. The T5 Stagehand smoke test landed in the v1-ai-first worktree
   (PR #11 cherry-pick) is now available to validate v3 runtime
   behaviour at the act / extract / observe boundary.

## Decision

**Upgrade `@browserbasehq/stagehand` from `^2.0.0` to `^3.3.0`.**

Architecture: PixelCheck launches its own Playwright Chromium with
stealth + HAR + video + tracing recording, then bridges Stagehand v3
via `localBrowserLaunchOptions.cdpUrl` so v3 attaches to that browser
over CDP. This preserves the recording features Stagehand v3 itself
no longer supports (its CDP-native context dropped Playwright
BrowserContext as the substrate).

Public API unchanged: handlers / instruction-mutator / primitives keep
calling `wrapper.stagehand.act({ action })` / `extract({ instruction,
schema })` / `observe({ instruction })`. The wrapper adapter
internally translates to v3's positional API (`act(string, opts)`,
`extract(string, schema, opts)`, `observe(string, opts)`).

## Stagehand v3 breaking changes encountered (and adapts)

The v3 migration guide documents the headline changes; this section
records the implementation surprises that only surfaced when the T5
Stagehand smoke test ran with the upgraded code:

1. **`stagehand.page` removed** — v3 uses `stagehand.context.pages()`
   (V3Context returns Playwright-shaped `Page[]`). Wrapper +
   `primitives/{act,extract}.ts` updated.
2. **Constructor option shape**: `modelName` + `modelClientOptions` →
   nested `model: { modelName, apiKey }`. `enableCaching: true` →
   removed (v3 caches by default). `domSettleTimeoutMs` →
   `domSettleTimeout`.
3. **`stagehand.metrics` is async** (`Promise<StagehandMetrics>`) —
   `OpenedExtractor.readMetrics` becomes `() => Promise<...>` and the
   two before/after snapshots in `runExtract` await it.
4. **`cdpUrl` lives inside `localBrowserLaunchOptions`, NOT at the
   top of `V3Options`.** Putting it at top level is silently ignored
   and Stagehand launches its own browser parallel to ours. The
   `V3Options` interface has no top-level `cdpUrl` field but
   TypeScript's strict-extra-property check doesn't fire because the
   constructor type is `(cfg: Record<string, unknown>)`. Reading
   `v3.js` source (`lbo.cdpUrl` decides between attach and launch
   branches) is the only way to find this.
5. **`cdpUrl` must be a `ws://...` WebSocket URL**, not the http://
   URL Chromium's `--remote-debugging-port` advertises directly. The
   `/json/version` HTTP response payload includes a
   `webSocketDebuggerUrl` field that points at the right ws endpoint;
   we read that and pass it. http:// gives an opaque "Unexpected
   server response: 404".
6. **Passing `{ page: ourPlaywrightPage }` to act/extract/observe
   options errors with `StagehandInitError: Failed to resolve V3 Page
   from Playwright page`.** v3's resolver only knows about V3Page
   wrappers it created itself. Workaround: omit `page`, let v3's
   `awaitActivePage()` pick. Works correctly because we and v3 share
   the same CDP targets through different wrappers — recording at
   the Playwright BrowserContext level captures any driver's actions
   on the target.

## Recording features preservation

| Feature | v2 mechanism | v3 path |
|---|---|---|
| HAR (`recordHar`) | Playwright `recordHar` on Stagehand-launched context | Playwright `recordHar` on OUR context (Stagehand bridges via CDP) |
| Video (`recordVideo`) | Playwright `recordVideo` on Stagehand-launched context | Playwright `recordVideo` on OUR context |
| Tracing (`tracing.start/stop`) | Stagehand's context exposed Playwright tracing | OUR context's Playwright tracing |
| Stealth init script | `stagehand.context.addInitScript` | OUR `context.addInitScript` |
| Cookies | `stagehand.context.addCookies` | OUR `context.addCookies` |
| Stealth fingerprint launch options | passed via `localBrowserLaunchOptions` | passed via Playwright `chromium.launch` (v3's strict schema rejects them) |

All preserved. Verified by T5 smoke (act + extract + observe round-trip
in 10.3s, HAR + video + cost-budget all green).

## Transitive vulnerability closure

ADR-028 listed three transitive vulnerabilities waived for v1.0 ship:

| Package | Severity | Status after v3 |
|---|---|---|
| `ai` (Vercel AI SDK) — GHSA-rwvc-j5jr-mgvh | moderate | **Removed** (Stagehand v3 dropped this dep) |
| `jsondiffpatch` — GHSA-33vc-wfww-vjfv | moderate | **Removed** (Stagehand v3 no longer uses HtmlFormatter) |
| 1 low (unspecified) | low | **Removed** alongside the above |

`SECURITY.md` updated to reflect closure. CI `npm audit
--audit-level=high` gate retained but the moderate-tier waiver is no
longer needed.

## Verification matrix (functional parity vs v2.5.8)

Per CLAUDE.md migration规范 (≥ 95% completion rate required):

| Category | v2 behaviour | v3 result |
|---|---|---|
| `wrapper.stagehand.act({ action })` | works | ✅ adapter translates to v3 positional |
| `wrapper.stagehand.extract({ instruction, schema })` | works | ✅ adapter translates to v3 positional |
| `wrapper.stagehand.observe({ instruction })` | works | ✅ adapter translates to v3 positional |
| `wrapper.page` is the active Playwright Page | yes | ✅ owned by us, not by Stagehand |
| `wrapper.context` is Playwright BrowserContext | yes | ✅ owned by us |
| `wrapper.harPath` HAR recording | yes | ✅ Playwright-side |
| `wrapper.videoDir` video | yes | ✅ Playwright-side |
| `wrapper.tracesDir` Playwright tracing | yes | ✅ Playwright-side (skipped on persistent contexts, same as v2) |
| Stealth init script | yes | ✅ via Playwright `addInitScript` |
| Persona-derived locale / timezone / viewport / proxy | yes | ✅ Playwright `newContext` opts |
| Cookies injection | yes | ✅ via Playwright `addCookies` |
| `OpenedExtractor.readMetrics` | sync | ⚠️ now async (signature change) — internal-only API, no public surface impact |
| Handler `ctx.stagehand.act/extract/observe` calls | object-arg | ✅ unchanged (wrapper translates) |
| `instruction-mutator.ts` `stagehand.observe` | object-arg | ✅ unchanged |
| `primitives/{act,extract}.ts` Stagehand opener | v2 page-method | ✅ rewritten for v3 instance-method |
| T5 Stagehand smoke (real chromium) | 3/3 pass | ✅ 3/3 pass on v3 |
| Wrapper unit tests | 24 cases | ✅ rewritten + expanded to 31 cases |
| Full unit suite | 1851 pass | ✅ 1858 pass + 1 self-skip |
| `npm pack` dogfood | 365 files | ✅ unchanged |

**Completion rate: 16/16 = 100%.** No documented v2 behaviour lost.

The only signature change is `OpenedExtractor.readMetrics: () =>
StagehandMetricsSnapshot` → `() => Promise<StagehandMetricsSnapshot>`,
forced by v3 making `stagehand.metrics` async. `OpenedExtractor` is
an internal-only interface; no public-API consumer impact.

## Files changed

Migration unfolded in 6 atomic commits on `feat/stagehand-v3-migration`:

1. `package.json` / `package-lock.json` — bump to `^3.3.0`, drop the
   `overrides.@browserbasehq/stagehand` block.
2. `src/core/stagehand-wrapper.ts` — rewrite for Playwright + CDP bridge.
3. `src/core/primitives/{act,extract}.ts` — v3 instance-method API.
4. `tests/stagehand-wrapper.test.ts` — mock both Playwright + Stagehand.
5. `src/core/stagehand-wrapper.ts` (follow-up) — fix
   `localBrowserLaunchOptions.cdpUrl` + `ws://` URL discovered via T5.
6. `docs/decisions/{ADR-028-stagehand-v3-deferred.md → Superseded,
   ADR-035-stagehand-v3-migration.md (this file, originally filed as
   ADR-029 — see numbering note at top)}`, `CHANGELOG.md`,
   `SECURITY.md` (transitive vulns closure).

## Alternatives rejected

1. **Stay on Stagehand v2.5.8 with `overrides` for dotenv 17 + zod
   3.25.76** (the PR #12 state). Workable short-term but still pinned
   to the upstream-deprecated v2 line and carries 3 transitive vulns.
   We've now run the migration, so the override block in PR #12 is
   superseded.
2. **Stagehand v3 launches the browser, Playwright connects via
   `connectOverCDP`.** The recording features (HAR / video) require
   Playwright BrowserContext options at creation time — connecting
   later cannot retroactively enable them. Rejected.
3. **Drop HAR / video / tracing for v3 (B-lite path).** A real user-
   facing regression (audit artifacts) for no gain. Rejected.
4. **Use v3's BYO-Puppeteer or BYO-Patchright path.** Would require
   replacing our Playwright dependency entirely; Playwright is also
   used by `tests/integration/playwright/**` and the `--trace` CLI
   flag. Rejected.

## Consequences

- Stagehand v3.3.0 ships in v1.x next release.
- Override block in `package.json` removed.
- `OpenedExtractor.readMetrics` signature change is documented
  internal-only (no public-API impact).
- `SECURITY.md` 3 transitive moderate waivers closed.
- CI `npm audit --audit-level=moderate` gate now feasible (no longer
  needed `high` to skip the Stagehand v2 transitive moderate set).
- Future Stagehand minor / patch upgrades land cleanly through
  dependabot weekly bumps (no more peer-dep ignore rules required).
