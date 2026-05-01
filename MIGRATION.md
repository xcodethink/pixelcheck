# Migration Guide

This file documents user-visible breaking changes and migration paths
between major releases. We follow [Semantic Versioning](https://semver.org/):
breaking changes only land in major version bumps.

---

## Table of contents

- [v0.3.x → v1.0.0](#v03x--v100)
- [General upgrade tips](#general-upgrade-tips)

---

## v0.3.x → v1.0.0

v1.0 is the first **commercially-supported** release. The public API
(CLI flags, config schema, Result Schema 1.2.0, MCP tool surface) is
now stable per our [Stability Commitment](README.md#stability-commitment).

This section lists every change a v0.3 user must read before upgrading.

### Required action: Node.js 16 → 18+

**Breaking — install fails on Node < 18.**

v1.0 requires Node.js 18.x or later. v0.3 ran on Node 16+.

```bash
# Check your Node version
node --version

# Upgrade via nvm (recommended)
nvm install --lts
nvm use --lts

# Or via fnm
fnm install --lts
```

**Why**: v1.0 native dependencies (better-sqlite3, sharp, playwright
1.x) ship prebuilt binaries for Node 18+ ABI; Node 16 builds were dropped
upstream.

If you cannot upgrade Node, stay on v0.3.x for the supported window
(see [SECURITY.md § Supported Versions](SECURITY.md#supported-versions)).

### Required action: review accessibility audit results

**Breaking — same site may report MORE WCAG violations after upgrade.**

v0.3's `assert_a11y` step passed `runOnly: ["wcag2aa"]` to axe-core.
Because axe's `runOnly` is **exact-match**, this silently missed all
Level A WCAG rules (image-alt, label, button-name, link-name, etc).

v1.0 fixes this via `expandAxeStandard()` ([ADR-030](docs/decisions/ADR-030-axe-standard-cumulative-expansion.md)):

| Standard input | v0.3 axe tags | v1.0 axe tags |
|---|---|---|
| `wcag2aa` | `["wcag2aa"]` | `["wcag2a", "wcag2aa"]` |
| `wcag22aa` | `["wcag22aa"]` | `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]` |

**What you'll see**: First v1.0 audit of the same site reports more A11y
issues. This is **NOT a regression** — those violations were always present;
v0.3 just didn't report them.

**What to do**:
1. Run `ai-audit run --tag pre-v1.0-baseline` on v0.3 (last time)
2. Upgrade to v1.0
3. Run `ai-audit run --tag v1.0-baseline`
4. Compare with `ai-audit diff pre-v1.0-baseline v1.0-baseline`
5. Triage the new findings — these are legitimate WCAG Level A violations

If you want the old (under-reporting) behaviour for a transition window,
explicitly pass `standard: wcag2aaa` (skips Level A) — but this is
**not recommended** for ADA / EAA / Section 508 compliance reporting.

### Required action: review screenshot dimensions

**No change** — v1.0 default viewport remains 1280×720 (matches PDF
output viewport since v0.3.5).

### Optional: update CI workflows

v1.0 ships first-party GitHub Actions workflows in `.github/workflows/`:

- `ci.yml` — 12-config matrix (4 OS × 3 Node) running every PR
- `integration.yml` — Playwright e2e + file-lock-race on Ubuntu
- `coverage.yml` — coverage gate (60/54/60/60)
- `sbom.yml` — CycloneDX SBOM on release tag

If your fork pre-v0.3 had its own `.github/workflows/`, you'll see no
conflict — our new workflow filenames don't collide. Cherry-pick or
adopt as you like.

### Optional: Anthropic SDK upgrade

v0.3 used `@anthropic-ai/sdk@0.39`; v1.0 uses `@anthropic-ai/sdk@^0.92`.
**No code change required** for users — v1.0 internally uses the new
SDK; your CLI / MCP / config interface is unchanged.

If you import `@anthropic-ai/sdk` directly in your downstream code (not
recommended — use `ai-browser-auditor`'s wrappers), check the
[Anthropic SDK CHANGELOG](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md)
for any direct-API breaking changes.

### Optional: Stagehand stays on v2.5.8

v1.0 deliberately ships Stagehand v2.5.8 (not v3). v3's act/observe API
is a major surface change ([ADR-028](docs/decisions/ADR-028-stagehand-v3-deferred.md))
that we'll address in **v1.1**. For v1.0 users:

- **No code change** if you only use the high-level `ai-audit` CLI / MCP server
- **No code change** if you use the library's `act` / `extract` primitives — we wrap Stagehand internally

If you import `@browserbasehq/stagehand` directly (rare — not recommended),
stay on v2.5.x in your tree as well.

### Optional: Zod stays on v3

Same pattern as Stagehand. v1.0 uses Zod v3.25.x ([ADR-027](docs/decisions/ADR-027-zod-3-lock-in.md)).
Zod v4 evaluation is deferred to v1.1. **No user action required**.

### URL changes

- The repository URL changed from `github.com/anthropics/ai-browser-auditor`
  (an erroneous v0.3 reference) to `github.com/xcodethink/ai-browser-auditor`.
- All 30 published JSON Schema `$id` URLs updated accordingly.
- SARIF `tool.driver.informationUri` now points to the correct repo.
- PR diff comment footer link now points to the correct repo.

**What to do**: if you cached schema URLs in any downstream system
(internal registries, contract tests pinned to old URL), update to the
new prefix `https://github.com/xcodethink/ai-browser-auditor/blob/main/docs/schemas/`.

### Package metadata changes

`package.json` now declares `os: ["darwin", "linux", "win32"]` and
`cpu: ["x64", "arm64"]`. Platforms outside this list (e.g., Linux
mips64, Windows ARM32) will be **skipped** by npm at install time
(not error — by design). If you operate on such a platform and got
v0.3 to install via fallback, v1.0 will not.

Reach out via [GitHub Issues](https://github.com/xcodethink/ai-browser-auditor/issues)
if your platform is not covered — we may consider extending support
in v1.1+.

### What did NOT change (no action required)

- **Result Schema** stays at version `1.2.0` — your stored audit.json
  files continue to parse correctly with v1.0
- **CLI flags / subcommands** — every v0.3 flag still works in v1.0
- **Config file shape** (config.yaml / scenarios/*.yaml / personas/*.yaml)
  — no schema breaks
- **MCP tool surface** — all 12 tools (`audit_url`, `see`, `act`, etc)
  unchanged
- **History database schema** — v1.0 includes a forward migration
  ([ADR-026](docs/decisions/ADR-026-unified-db-migrations.md));
  existing `history.db` files upgrade automatically on first open

---

## General upgrade tips

### Always tag your last pre-upgrade audit

```bash
# Before upgrading
ai-audit run --tag last-v0.3
git tag pre-v1.0-baseline
git push origin pre-v1.0-baseline

# Upgrade
npm install ai-browser-auditor@latest

# After upgrade
ai-audit run --tag first-v1.0
ai-audit diff last-v0.3 first-v1.0
```

This gives you a concrete diff to review with stakeholders so the
"why are there suddenly more issues?" conversation has data backing.

### Lock the version in CI

```json
// package.json — stay on a known-good major
"dependencies": {
  "ai-browser-auditor": "^1.0.0"
}
```

`^1.0.0` will pull every v1.x patch + minor (safe per SemVer + our
[Stability Commitment](README.md#stability-commitment)) but never v2.0.

### Read the CHANGELOG before upgrading minors

Every minor / patch release documents user-visible changes in
[CHANGELOG.md](CHANGELOG.md) under `## [Unreleased]` or `## [vX.Y.Z]`.
We follow [Keep a Changelog](https://keepachangelog.com/) format.

---

**Last updated**: 2026-05-01 (T20 — Wave 3 stability commitment)
