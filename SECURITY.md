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

Use one of these private channels:

1. **GitHub Security Advisories** (preferred):
   - Visit: `https://github.com/xcodethink/ai-browser-auditor/security/advisories/new`
   - Allows private discussion + coordinated disclosure
2. **Email**: `security@<TBD>`

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

`npm audit` reports the following moderate transitive vulnerabilities in
the v1.0.0 dependency tree. They are **inherited from
`@browserbasehq/stagehand@2.5.8`** and are **not exploitable in our use
case**, as documented below.

### 1. `ai` SDK — file-type whitelist bypass (GHSA-rwvc-j5jr-mgvh)

- **Severity**: Moderate
- **Source**: `@browserbasehq/stagehand@2.5.8 → ai`
- **Vulnerable behavior**: Vercel AI SDK's file-upload endpoint
  whitelist can be bypassed when uploading user-supplied files.
- **Why not exploitable in `ai-browser-auditor`**: We do not call the
  `ai` SDK's file-upload functionality. Stagehand uses `ai` for prompt
  formatting only; no file uploads cross this code path.
- **Closure plan**: T-NEW-1 (Stagehand v3 upgrade, v1.1 early task) —
  Stagehand v3.x removes the dependency on the vulnerable `ai`
  versions, fully clearing this finding.

### 2. `jsondiffpatch` — `HtmlFormatter::nodeBegin` XSS (GHSA-33vc-wfww-vjfv)

- **Severity**: Moderate
- **Source**: `@browserbasehq/stagehand@2.5.8 → jsondiffpatch`
- **Vulnerable behavior**: `HtmlFormatter::nodeBegin` does not properly
  escape user-controlled values, leading to cross-site scripting if
  the formatted HTML is rendered in a browser.
- **Why not exploitable in `ai-browser-auditor`**: We do not use
  `jsondiffpatch`'s `HtmlFormatter`. Stagehand uses `jsondiffpatch` for
  internal plan diffing (server-side, never rendered as HTML to a
  browser). No HTML output reaches a user surface from this code path.
- **Closure plan**: Same as above — Stagehand v3 (T-NEW-1).

### 3. (One additional low-severity transitive — see `npm audit`)

- **Severity**: Low
- **Source**: Stagehand v2.5.8 transitive
- **Closure plan**: Same as above (Stagehand v3 / T-NEW-1)

### CI policy

Our CI runs `npm audit --audit-level=high`, which **does not** fail on the
moderate findings above. The decision is documented in
[ADR-028](docs/decisions/ADR-028-stagehand-v3-deferred.md).

When Stagehand v3 ships in v1.1, we will tighten the gate to
`--audit-level=moderate`.

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
