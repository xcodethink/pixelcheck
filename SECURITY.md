# Security Policy

## Supported Versions

`pixelcheck` follows semantic versioning. We provide security
patches according to the schedule below.

| Version | Status | Patches until |
|---|---|---|
| 1.x | ✅ Active | 6 months after 2.0 ships (not yet scheduled) |
| 0.x | ⚠ Pre-release | No patches; upgrade to 1.x |

After a major version (e.g., 2.0) ships, the previous major (1.x) receives
critical security patches for **6 months**, then enters end-of-life.

---

## Reporting a Vulnerability

**Do not file public GitHub issues for security reports.**

Use **GitHub Security Advisories** (the only supported private channel for
v1.0):

- Visit: `https://github.com/xcodethink/pixelcheck/security/advisories/new`
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

> **Update 2026-05-03**: the Stagehand v3 upgrade was executed earlier
> than planned — see [ADR-035](docs/decisions/ADR-035-stagehand-v3-migration.md)
> (originally filed as ADR-029, renumbered 2026-05-05 to resolve a slot
> conflict with the file-lock-race ADR).
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

## Post-Stagehand-v3 transitive cleanup (2026-05-03)

Stagehand v3.3.0 introduced a **new** set of 5 transitive moderate
findings (different from the v1.0 set listed above):

| Package | GHSA | Severity | Resolution |
|---|---|---|---|
| `langsmith` | [GHSA-v34v-rq6j-cj6p](https://github.com/advisories/GHSA-v34v-rq6j-cj6p) — SSRF via Tracing Header Injection | moderate | **Resolved** via `overrides.langsmith: ^0.6.0` |
| `langsmith` | [GHSA-fw9q-39r9-c252](https://github.com/advisories/GHSA-fw9q-39r9-c252) — Prototype Pollution via incomplete `__proto__` guard | moderate | **Resolved** via override (same) |
| `langsmith` | [GHSA-rr7j-v2q5-chgv](https://github.com/advisories/GHSA-rr7j-v2q5-chgv) — Streaming token events bypass output redaction | moderate | **Resolved** via override (same) |
| `uuid` | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — Missing buffer bounds check in v3/v5/v6 | moderate | **Resolved** via `overrides.uuid: ^14.0.0` |
| (uuid same finding via second dependency path) | — | moderate | Same override above |

Both overrides are validated at runtime by the Stagehand smoke test
(real chromium + Anthropic API exercising act / extract / observe). The
forced versions are major bumps over what `@browserbasehq/stagehand@3.3.0`
and `@langchain/core` declare in their `dependencies`, but Stagehand
runs cleanly against them.

Result: `npm audit --production` reports **0 moderate-or-higher findings**.
(It does report LOW advisories — see "Known low advisories" below.)

### CI policy

After ADR-035 + the post-v3 override cleanup above, CI runs
`npm audit --production --audit-level=moderate` (tightened from the
v1.0 `--audit-level=high` gate). All historical moderate waivers are
closed. Low advisories are surfaced but below this gate (documented
below).

When `@browserbasehq/stagehand` ships a new minor / patch that bumps
its own internal langsmith / uuid pins, the `overrides` block can be
removed in a follow-up PR (the override is harmless to keep but
unnecessary once upstream catches up).

---

## Known low advisories (2026-06-02 audit)

A production-grade audit flagged that the CI comment
overclaimed "0 vulnerabilities" when `npm audit` actually reports LOW
advisories. For honesty, here is the full current state. Reproduce with
`npm audit` (full tree) and `npm audit --production` (shipped tree).

### Production tree — 17 low, 1 root cause

All 17 low advisories in the **production** tree trace to a single
upstream issue and fan out across the AI-SDK family:

| Advisory | Severity | Affected | Status |
|---|---|---|---|
| [`@ai-sdk/provider-utils`](https://github.com/advisories/GHSA-866g-f22w-33x8) — Uncontrolled Resource Consumption | low | `@ai-sdk/provider-utils` and every `@ai-sdk/*` provider + `ai` that depends on it (17 packages) | Accepted, with the fix attempted and reverted — see below |

These are transitive and low severity, so they do not block the build.
Tracked here so the "0 vulnerabilities" claim is never made again without
qualification.

**`npm audit` reports `fixAvailable: true` for all seventeen. It is wrong,
and this was measured rather than assumed.** The advisory's fixed range is
`>3.0.97`, and the only published versions above it are `5.x` — two majors
up. `@browserbasehq/stagehand`, which brings the whole family in, is on its
latest release and still resolves `3.0.30`.

Forcing `"@ai-sdk/provider-utils": "^5.0.20"` through `overrides` installs
cleanly, builds, and passes **2569 unit tests, 49 integration tests, and
`npm audit` goes to zero findings**. The product is dead:

```
SyntaxError: The requested module '@ai-sdk/provider-utils'
             does not provide an export named 'lazyValidator'
    at @ai-sdk/gateway/src/errors/gateway-forbidden-error.ts:3
```

`@ai-sdk/gateway` is compiled against 3.x and imports a symbol 5.x no longer
exports, so the module graph fails to load and no LLM call can be made at
all. Nothing in the suite covers that path — there is no cassette replay for
it — so every gate stayed green while the thing the product exists to do was
broken. Confirmed by making one real API call before and after the revert:
`"ok"` on the reverted tree, the SyntaxError above with the override in
place.

So the honest status is not "no fix published". It is: a fix exists, it
cannot be taken from here, and it arrives when the AI SDK family moves
together — which is upstream's release, not ours. Do not re-attempt the
override on the strength of `fixAvailable`.

### Dev-only tree — 1 moderate (NOT shipped)

`npm audit` (full tree) additionally reports 1 **moderate**:

| Advisory | Severity | Affected | Status |
|---|---|---|---|
| `brace-expansion` — large numeric range defeats the documented `max` DoS protection | moderate | dev-dependency transitive only | **Not in `--production`**, so not shipped to users and not gate-relevant. Picked up on the next dev-dep refresh. |

Because it is absent from the production tree, the
`npm audit --production --audit-level=moderate` gate is unaffected.

---

## Dependency Security Practices

- **Weekly automated scans**: GitHub Dependabot opens PRs for new vulns
  (see [.github/dependabot.yml](.github/dependabot.yml))
- **CI gate**: every PR runs `npm audit --production --audit-level=moderate`
  as a required check. `moderate` rather than `high` because the production
  tree currently reports zero findings at that level, so the stricter gate
  costs nothing; see "Known low advisories" below for what sits beneath it
- **License compliance**: every PR runs `license-checker` against an
  allowlist (see [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md))
- **SBOM**: release artifacts include a CycloneDX SBOM at
  GitHub Releases
- **Lockfile**: `package-lock.json` is committed; CI runs `npm ci`
  (lockfile-strict)

---

## Scope

This policy covers vulnerabilities in:

- The `pixelcheck` source code (CLI, MCP server, library)
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
retention), see [PRIVACY.md](PRIVACY.md).

---

**Last updated**: 2026-05-01 (initial draft)
**Policy owner**: project maintainers
