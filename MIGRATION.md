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

### Required action: rename — `ai-browser-auditor` → `pixelcheck`

**Breaking — package name + CLI bin + MCP server bin all renamed.**

v1.0 ships under the new product name **PixelCheck**, aligning the
package, CLI, MCP server, and brand to the AI-first MCP infrastructure
positioning ([ADR-001](docs/decisions/ADR-001-AI-first-positioning.md) /
[ADR-002](docs/decisions/ADR-002-primitive-first-architecture.md) /
[ADR-033](docs/decisions/ADR-033-rename-to-pixelcheck.md)).

**What changed**:

| Concept | v0.3.x | v1.0.0 |
|---|---|---|
| npm package name | `ai-browser-auditor` | `pixelcheck` |
| CLI bin | `ai-audit` | `pixelcheck` |
| MCP server bin | `ai-audit-mcp` | `pixelcheck-mcp` |
| Default data home | `~/.ai-browser-auditor/` | `~/.pixelcheck/` |
| GitHub repo | `xcodethink/ai-browser-auditor` | `xcodethink/pixelcheck` (auto-redirect) |
| Brand H1 | "AI Browser Auditor" | "PixelCheck" |
| Tagline | "Your AI-powered product experience reviewer" | "MCP server giving AI agents real eyes and hands on the web" |

**Command-by-command mapping**:

```bash
# v0.3.x                                  v1.0.0
ai-audit init projects/my-app          → pixelcheck init projects/my-app
ai-audit run --project projects/my-app → pixelcheck run --project projects/my-app
ai-audit doctor                        → pixelcheck doctor
ai-audit history                       → pixelcheck history
ai-audit diff <a> <b>                  → pixelcheck diff <a> <b>
ai-audit trends --project my-app       → pixelcheck trends --project my-app
ai-audit benchmark --tasks <dir>       → pixelcheck benchmark --tasks <dir>
ai-audit calibrate                     → pixelcheck calibrate
ai-audit persona generate              → pixelcheck persona generate
ai-audit prune                         → pixelcheck prune
```

```jsonc
// ~/.mcp.json — v0.3.x
{
  "mcpServers": {
    "ai-browser-auditor": {
      "command": "node",
      "args": ["/abs/path/to/ai-browser-auditor/dist/mcp/server.js"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}

// ~/.mcp.json — v1.0.0
{
  "mcpServers": {
    "pixelcheck": {
      "command": "pixelcheck-mcp",
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

**Migration steps**:

1. Uninstall the old package and install the new one:

   ```bash
   # global install
   npm uninstall -g ai-browser-auditor
   npm install -g pixelcheck

   # or per-project
   npm uninstall ai-browser-auditor
   npm install pixelcheck
   ```

2. Update your `~/.mcp.json` (and any equivalent in Cursor / Cline /
   Continue / Zed / Claude Desktop) to use the new server name + binary.

3. Update CI workflows:

   ```yaml
   # GitHub Actions
   - run: npm install pixelcheck && npx pixelcheck install
   - run: npx pixelcheck run --project .audit --min-score 7.0
   ```

4. Update any scripts, aliases, or documentation that reference
   `ai-audit` / `ai-browser-auditor`.

5. **Data directory migration**: on first run, v1.0 detects the
   legacy `~/.ai-browser-auditor/` directory and offers to migrate it
   to `~/.pixelcheck/`. Choose `[Y]es` to copy (originals are kept as
   `~/.ai-browser-auditor.v0.x.backup-<timestamp>/` for safety) or
   `[n]o` to start fresh. Override via env: `PIXELCHECK_HOME` (new
   primary) — also reads `AUDIT_HOME` (legacy alias) for one-version
   transition window.

6. **GitHub repo URL**: GitHub auto-redirects `xcodethink/ai-browser-auditor`
   → `xcodethink/pixelcheck`. Existing clone remotes keep working.
   Update them at your convenience:

   ```bash
   git remote set-url origin git@github.com:xcodethink/pixelcheck.git
   ```

7. **Schema `$id` URLs**: 30 published JSON Schemas now reference
   `github.com/xcodethink/pixelcheck/...`. Old URLs remain accessible
   via redirect for one minor version (v1.0.x); update downstream
   schema references at your convenience.

**Backward-compat shim** (one minor version, then removed in v1.1):

For users running v0.3 commands in pinned scripts, you can install
a thin alias for the transition window:

```bash
# In your shell rc:
alias ai-audit=pixelcheck
alias ai-audit-mcp=pixelcheck-mcp
```

This is **not** a supported v1.x API; it's a transition convenience.
Update your scripts to use `pixelcheck` directly.

**Why now**: v1.0 ship is the brand-defining moment. Aligning the
package name with the strategic positioning before npm publish avoids
irreversible name divergence and uses the 2026-Q2 MCP / vendor-agnostic
narrative window. See [ADR-033](docs/decisions/ADR-033-rename-to-pixelcheck.md)
for the full decision rationale.

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
1. Run `ai-audit run --tag pre-v1.0-baseline` on v0.3 (last time, using legacy CLI bin)
2. Upgrade to v1.0 (which renames the bin to `pixelcheck`)
3. Run `pixelcheck run --tag v1.0-baseline`
4. Compare with `pixelcheck diff pre-v1.0-baseline v1.0-baseline`
5. Triage the new findings — these are legitimate WCAG Level A violations

If you want the old (under-reporting) behaviour for a transition window,
explicitly pass `standard: wcag2aaa` (skips Level A) — but this is
**not recommended** for ADA / EAA / Section 508 compliance reporting.

### Required action: review screenshot dimensions

**No change** — v1.0 default viewport remains 1280×720 (matches PDF
output viewport since v0.3.5).

### Optional: update CI workflows

v1.0 ships first-party GitHub Actions workflows in `.github/workflows/`:

- `ci.yml` — 8-config matrix (4 OS × 2 Node: 20 / 22) running every PR
- `integration.yml` — Playwright e2e + file-lock-race on Ubuntu
- `coverage.yml` — coverage gate (ADR-017 ratchet; thresholds in vitest.config.ts)
- `sbom.yml` — CycloneDX SBOM on release tag

If your fork pre-v0.3 had its own `.github/workflows/`, you'll see no
conflict — our new workflow filenames don't collide. Cherry-pick or
adopt as you like.

### Optional: Anthropic SDK upgrade

v0.3 used `@anthropic-ai/sdk@0.39`; v1.0 uses `@anthropic-ai/sdk@^0.92`.
**No code change required** for users — v1.0 internally uses the new
SDK; your CLI / MCP / config interface is unchanged.

If you import `@anthropic-ai/sdk` directly in your downstream code (not
recommended — use `pixelcheck`'s wrappers), check the
[Anthropic SDK CHANGELOG](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/CHANGELOG.md)
for any direct-API breaking changes.

### Optional: Stagehand stays on v2.5.8

v1.0 deliberately ships Stagehand v2.5.8 (not v3). v3's act/observe API
is a major surface change ([ADR-028](docs/decisions/ADR-028-stagehand-v3-deferred.md))
that we'll address in **v1.1**. For v1.0 users:

- **No code change** if you only use the high-level `pixelcheck` CLI / MCP server
- **No code change** if you use the library's `act` / `extract` primitives — we wrap Stagehand internally

If you import `@browserbasehq/stagehand` directly (rare — not recommended),
stay on v2.5.x in your tree as well.

### Optional: Zod stays on v3

Same pattern as Stagehand. v1.0 uses Zod v3.25.x ([ADR-027](docs/decisions/ADR-027-zod-3-lock-in.md)).
Zod v4 evaluation is deferred to v1.1. **No user action required**.

### URL changes

- The repository URL changed:
  - v0.2.x referenced `github.com/anthropics/ai-browser-auditor` (an erroneous v0.2 reference, fixed in v0.3)
  - v0.3 referenced `github.com/xcodethink/ai-browser-auditor`
  - **v1.0 references `github.com/xcodethink/pixelcheck`** (renamed; GitHub auto-redirects from the old URL)
- All 30 published JSON Schema `$id` URLs updated accordingly to the new repo.
- SARIF `tool.driver.informationUri` now points to the new repo.
- PR diff comment footer link now points to the new repo.

**What to do**: if you cached schema URLs in any downstream system
(internal registries, contract tests pinned to old URL), update to the
new prefix `https://github.com/xcodethink/pixelcheck/blob/main/docs/schemas/`.
Old URLs remain accessible via GitHub's automatic redirect for at least
one minor version cycle.

### Package metadata changes

`package.json` now declares `os: ["darwin", "linux", "win32"]` and
`cpu: ["x64", "arm64"]`. Platforms outside this list (e.g., Linux
mips64, Windows ARM32) will be **skipped** by npm at install time
(not error — by design). If you operate on such a platform and got
v0.3 to install via fallback, v1.0 will not.

Reach out via [GitHub Issues](https://github.com/xcodethink/pixelcheck/issues)
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
# Before upgrading (using legacy v0.3 bin)
ai-audit run --tag last-v0.3
git tag pre-v1.0-baseline
git push origin pre-v1.0-baseline

# Upgrade (uninstall old, install new)
npm uninstall ai-browser-auditor
npm install pixelcheck@latest

# After upgrade (new bin name)
pixelcheck run --tag first-v1.0
pixelcheck diff last-v0.3 first-v1.0
```

This gives you a concrete diff to review with stakeholders so the
"why are there suddenly more issues?" conversation has data backing.

### Lock the version in CI

```json
// package.json — stay on a known-good major
"dependencies": {
  "pixelcheck": "^1.0.0"
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
