# Security Policy

## Supported Versions

`ai-browser-auditor` follows semantic versioning. We provide security
patches according to the schedule below.

| Version | Status | Patches until |
|---|---|---|
| 1.x | ✅ Active | TBD (next major) |
| 0.x | ⚠ Pre-release | No patches; upgrade to 1.x |

After a major version (e.g., 2.0) ships, the previous major (1.x) receives
critical security patches for **6 months**, then enters end-of-life.

---

## Reporting a Vulnerability

**Do not file public GitHub issues for security reports.**

Use **GitHub Security Advisories** (the only supported private channel for
v1.0):

- Visit: `https://github.com/xcodethink/ai-browser-auditor/security/advisories/new`
- Allows private discussion + coordinated disclosure with maintainers
- Tracks the lifecycle (acknowledged → triaged → fixed → CVE issued)
  natively within GitHub

A dedicated email channel may be added in v1.x for users who can't access
GitHub Security Advisories (regulated networks, etc). Until then, please
use GHSA above.

We aim to:
- Acknowledge within **72 hours**
- Provide initial assessment within **7 days**
- Publish a fix within **30 days** for critical severity, **90 days** for
  moderate

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure):
researchers and vendors agree on a public-disclosure date, after a fix
ships and downstream users have time to upgrade.

---

## Known Accepted Risks (v1.0.0)

> **Update 2026-05-03**: T-NEW-1 (Stagehand v3 upgrade) executed earlier
> than planned — see [ADR-029](docs/decisions/ADR-029-stagehand-v3-migration.md).
> Stagehand v3.3.0 dropped both vulnerable transitive dependencies, so the
> three waivers below are **closed**. The full text is preserved here as a
> historical record of v1.0.0's accepted-risk posture.

### 1. `ai` SDK — file-type whitelist bypass (GHSA-rwvc-j5jr-mgvh) — **CLOSED**

- **Severity**: Moderate
- **Source**: `@browserbasehq/stagehand@2.5.8 → ai`
- **Vulnerable behavior**: Vercel AI SDK's file-upload endpoint
  whitelist can be bypassed when uploading user-supplied files.
- **Why was not exploitable in `pixelcheck@1.0.x`**: We do not call the
  `ai` SDK's file-upload functionality. Stagehand uses `ai` for prompt
  formatting only; no file uploads cross this code path.
- **Resolution**: Stagehand 3.3.0 no longer depends on `ai` SDK.
  Verified by `npm audit` post-upgrade — finding is gone.

### 2. `jsondiffpatch` — `HtmlFormatter::nodeBegin` XSS (GHSA-33vc-wfww-vjfv) — **CLOSED**

- **Severity**: Moderate
- **Source**: `@browserbasehq/stagehand@2.5.8 → jsondiffpatch`
- **Vulnerable behavior**: `HtmlFormatter::nodeBegin` does not properly
  escape user-controlled values, leading to cross-site scripting if
  the formatted HTML is rendered in a browser.
- **Why was not exploitable in `pixelcheck@1.0.x`**: We do not use
  `jsondiffpatch`'s `HtmlFormatter`. Stagehand uses `jsondiffpatch` for
  internal plan diffing (server-side, never rendered as HTML to a
  browser). No HTML output reaches a user surface from this code path.
- **Resolution**: Stagehand 3.3.0 no longer uses `jsondiffpatch`.
  Verified by `npm audit` post-upgrade.

### 3. (One additional low-severity transitive) — **CLOSED**

- **Severity**: Low
- **Source**: Stagehand v2.5.8 transitive
- **Resolution**: Removed alongside the two findings above when
  Stagehand v3.3.0 replaced its dependency tree.

### CI policy

Historic v1.0.x: CI ran `npm audit --audit-level=high`, which did not
fail on the moderate findings above. The original decision was
documented in
[ADR-028](docs/decisions/ADR-028-stagehand-v3-deferred.md).

After [ADR-029](docs/decisions/ADR-029-stagehand-v3-migration.md) the
moderate-tier waiver is no longer needed. The audit-level gate can be
tightened to `--audit-level=moderate` in a follow-up CI commit when
maintainer time is available; this was previously blocked on the
Stagehand v3 transitive cleanup.

---

## Dependency Security Practices

- **Weekly automated scans**: GitHub Dependabot opens PRs for new vulns
  (see [.github/dependabot.yml](.github/dependabot.yml))
- **CI gate** (T26+T27): every PR runs `npm audit --audit-level=high` as a
  required check
- **License compliance** (T28): every PR runs `license-checker` against an
  allowlist (see [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md))
- **SBOM** (T29): release artifacts include a CycloneDX SBOM at
  GitHub Releases
- **Lockfile**: `package-lock.json` is committed; CI runs `npm ci`
  (lockfile-strict)

---

## Scope

This policy covers vulnerabilities in:

- The `ai-browser-auditor` source code (CLI, MCP server, library)
- The Node.js modules we directly publish under `dist/`
- Our `package.json` direct + transitive dependencies (where we have
  upgrade authority)

This policy **does not** cover:

- Vulnerabilities in **Anthropic Claude API** infrastructure (report to
  Anthropic directly)
- Vulnerabilities in **Chromium** (report upstream to the Chromium
  Security team)
- Issues in user-supplied scenarios / personas (user responsibility)
- Issues in audited target sites (user responsibility)

---

## Privacy / Data Handling

For data-handling concerns (what data is collected, where it is sent,
retention), see [docs/PRIVACY.md](docs/PRIVACY.md) (added in T22).

---

**Last updated**: 2026-05-01 (T0.6 initial draft)
**Policy owner**: project maintainers
