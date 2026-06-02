# ADR-036 — First-run browser reliability (self-heal + honest doctor)

- Status: Accepted
- Date: 2026-06-01
- Task: first-run-browser-reliability

## Context

A new user who runs `npm install -g pixelcheck` and then `pixelcheck explore`
hit a hard wall: the process crashed with a raw Playwright stack —
`browserType.launch: Executable doesn't exist at .../chromium_headless_shell-<rev>/...`.

Root causes, confirmed by a clean-room repro (empty `PLAYWRIGHT_BROWSERS_PATH`):

1. **No browser is guaranteed at install time.** pixelcheck depends on
   `playwright`, whose postinstall normally downloads browsers — but that step
   is skippable (`--ignore-scripts`, CI), can hang on macOS while extracting,
   and downloads full Chromium even though every primitive launches
   `headless: true` (which needs the *separate* `chrome-headless-shell`).
2. **`doctor` lied.** A missing headless-shell was a `[WARN]`, and the summary
   printed "audits will work" — immediately before the first launch crashed.
   This is the single most misleading first-run signal.
3. **Nothing self-healed.** `ensureHeadlessShell()` (added in ADR-035 / the
   `doctor --fix` work) was only reachable via `doctor --fix`. A user running
   `explore`/`run` directly never touched it.
4. **The official remedy made things worse.** README and `doctor` told users to
   run a bare `npx playwright install chromium`. Bare `npx` resolves whatever
   Playwright version is latest on the registry, which can pin a *different*
   chromium revision than the bundled Playwright launches (observed: bundled
   1217 vs `npx`-pulled 1223) — "installed but still broken".

These compounded into the "open-sourced but unusable on first run" experience.

## Decision

A layered fix so the failure cannot occur regardless of how the user arrives:

1. **Self-heal at launch (primary).** `launchWithBrowserAutoInstall()` wraps
   both `chromium.launch` / `launchPersistentContext` sites in
   `stagehand-wrapper.ts`: on a missing-binary error it downloads the
   headless-shell directly and retries exactly once. Any other error, or a
   second failure, propagates unchanged. This makes `run`/`explore`/MCP work on
   a fresh machine even if the user never runs `doctor`.
2. **`postinstall` bootstrap.** `scripts/postinstall.mjs` fetches the
   headless-shell at install time. It is best-effort: it never fails the
   install, skips on CI and on the `*_SKIP_BROWSER_DOWNLOAD` env flags, and
   no-ops if `dist/` is not built (dev checkout).
3. **Honest `doctor`.** Missing headless-shell is now a blocking `[FAIL]`; the
   "audits will work" summary is gone. Full Chromium absence is `[SKIP]` (only
   `--headed` needs it). All remedies point at `pixelcheck install` /
   `doctor --fix`, never a bare `npx playwright install`.
4. **`pixelcheck install` command** + a **`doctor` MCP tool** (with
   `{ fix: true }`) give explicit, revision-correct install paths from the CLI
   and from inside an MCP agent.
5. **Route every install through the bundled `playwright-core`** so the cached
   revision always matches what we launch. Docs drop bare `npx playwright`
   browser-download guidance (Linux `install-deps` for system libraries stays).
6. **Global key fallback.** The CLI also loads `~/.pixelcheck/.env` so a global
   install finds `ANTHROPIC_API_KEY` without a per-project `.env`.

## Alternatives rejected

- **Pin `playwright` to an exact version instead of self-healing.** Removes the
  npx-skew trap but not the "browser never downloaded" crash, and freezes us off
  security patches. Self-heal addresses the actual failure; pinning is orthogonal.
- **Auto-heal full Chromium too at launch.** Headed runs are rare and full
  Chromium download risks the very extractor-hang we bypass for headless-shell.
  Headed installs are explicit via `pixelcheck install --headed`.
- **Keep headless-shell as `[WARN]`.** The whole bug is that a warning read as
  "fine". A binary whose absence breaks every audit must be a `[FAIL]`.
- **Rely solely on Playwright's own postinstall.** Skippable, can hang, and
  fetches the wrong (full-Chromium) artifact. Our postinstall targets the exact
  binary via the extractor-bypassing path.

## Consequences

- `pixelcheck doctor` now exits 1 on a machine with no headless-shell. CI
  runners that don't pre-install browsers must pass `--skip-browser` or run
  `pixelcheck install` (documented; README CI snippet updated).
- The MCP catalog grows from 13 to 14 tools (`doctor`).
- `package.json` gains a `postinstall` script and ships `scripts/postinstall.mjs`.
- New public exports on `browser-install`: `isMissingBrowserBinaryError`,
  `launchWithBrowserAutoInstall`, `installFullChromium` (+ a `_setX...ForTests`
  seam). No `src/index.ts` surface change.

## Files added / changed

- `src/core/browser-install.ts` — self-heal launch wrapper, missing-binary
  matcher, `installFullChromium`, test seam
- `src/core/stagehand-wrapper.ts` — both launch sites wrapped
- `src/commands/doctor.ts` — headless-shell `[FAIL]`, Chromium `[SKIP]`, honest
  summary + remedies
- `src/cli.ts` — `install` command, `~/.pixelcheck/.env` fallback
- `src/mcp/tools/doctor.ts`, `src/mcp/server.ts` — `doctor` MCP tool
- `scripts/postinstall.mjs`, `package.json` — postinstall bootstrap + `files`
- `README.md`, `docs/INSTALLATION.md`, `MIGRATION.md`,
  `docs/integration/post-deploy-audit.example.yml` — install guidance
- `tests/browser-install.test.ts`, `tests/doctor.test.ts`,
  `tests/mcp-registry.test.ts` — coverage incl. clean-room doctor repro
