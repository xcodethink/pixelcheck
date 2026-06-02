# PixelCheck Commercial Audit Report

Audit date: 2026-05-11  
Repository path: `/Users/wayne/Developer/ai-browser-auditor`  
Auditor: Codex  
Audit type: commercial readiness, security, privacy, supply chain, quality, and maintainability review

## Executive Summary

PixelCheck has a stronger engineering base than a typical early CLI/MCP project: broad unit coverage, TypeScript strictness, explicit privacy documentation, security policy, license allowlist, SBOM workflow, Dependabot, coverage gates, integration workflows, redaction tests, and extensive architecture records.

The project is not yet at an unqualified "enterprise/commercial ready" level because several controls are either inconsistent, partially applied, or too easy to bypass. The highest-risk gaps are:

- Consent is implicitly granted in non-TTY contexts even though documentation describes first-run informed consent.
- URL safety hardening exists for several MCP primitives, but `audit_url` and `explore_url` still accept unguarded URLs.
- Platform support claims are broader than the hard CI gates: Node 18 is advertised but not tested, and Windows is advertised while CI failures are allowed.
- SBOM generation can succeed even when `npm ls` reports dependency-tree problems because the script uses `--ignore-npm-errors`.
- The current working tree is dirty, so release certification should be done from a clean branch/tag after all fixes are committed.

Current verification results are good on the main local quality gates: typecheck, build, unit tests, coverage, license check, and the latest production `npm audit` pass. However, commercial release readiness should require these gates from a clean install and CI environment, not only from the current local tree.

## Standards Used

This audit maps findings against:

- NIST SSDF SP 800-218: secure development, dependency management, release integrity.
- OWASP ASVS 5.0: application security verification, input validation, SSRF-style navigation safety, logging/secrets handling.
- OWASP SAMM: security governance, design, implementation, verification, operations maturity.
- ISO/IEC 25010: functional suitability, reliability, security, maintainability, portability.
- W3C WCAG 2.2: accessibility assurance where PixelCheck claims WCAG-oriented auditing.

Reference links:

- NIST SSDF: https://csrc.nist.gov/pubs/sp/800/218/final
- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/
- OWASP SAMM: https://owasp.org/www-project-samm/
- ISO/IEC 25010 overview: https://iso25000.com/index.php/en/iso-25000-standards/iso-25010/45-iso-iec-25010
- WCAG 2.2: https://www.w3.org/TR/WCAG22/

## Scope and Caveats

Files and areas reviewed:

- Package metadata and scripts: `package.json`, `package-lock.json`
- CI and release workflows: `.github/workflows/*`, `.github/dependabot.yml`
- Security/privacy docs: `SECURITY.md`, `PRIVACY.md`, `README.md`
- MCP server and tools: `src/mcp/**`
- Core security/privacy helpers: `src/core/consent.ts`, `src/core/secrets.ts`, `src/core/url-guard.ts`
- Test and coverage configuration: `vitest.config.ts`, integration configs, test tree
- Release readiness docs: `progress/RELEASE-READINESS-CHECKLIST.md`

Important caveat: the worktree was dirty during the audit. `git status --short` showed modified source, docs, package files, tests, and new files such as `eslint.config.js` and `src/core/url-guard.ts`. Findings below are based on the current local tree plus command results captured during this session. Release decisions should be made only after a clean checkout or a finalized branch is re-tested.

## Verification Performed

Commands that passed:

- `npm run typecheck`
- `npm run build`
- `npm test` in non-sandbox mode: 2158 passed, 1 skipped
- `npm run test:coverage:check`: statements 80.89%, branches 68.78%, functions 82.18%, lines 82.50%
- `npm run license:check`
- Latest `npm audit --production --audit-level=moderate`: 0 vulnerabilities

Commands with caveats:

- Earlier in the session, `npm audit --production --audit-level=moderate` reported `fast-uri` high and `hono` moderate advisories. A later run on the current tree passed with `fast-uri@3.1.2` and `hono@4.12.18`. Treat this as a resolved or in-flight dependency-tree issue, but require clean CI confirmation.
- `npm run sbom` exited 0, but its internal `npm ls --json --long --all --omit=dev` reported many `extraneous` packages and `invalid: zod@3.25.76`. Because `package.json` uses `--ignore-npm-errors`, the SBOM output should not be considered enterprise-grade evidence until the dependency tree is clean.

## Findings

### F-01: Non-TTY Consent Auto-Acknowledgement Conflicts With Informed Consent Claims

Severity: Critical  
Category: Privacy, compliance, user trust  
Standards mapping: NIST SSDF PW.4, OWASP SAMM Governance/Implementation, ISO 25010 Security

Evidence:

- `src/core/consent.ts:13-18` documents bypass priority and includes non-TTY implicit auto-consent.
- `src/core/consent.ts:214-223` writes a consent record with `agreed_via: "non-tty"` and continues execution.
- `README.md:1100-1103` says a first-run consent prompt explicitly informs the user and describes CI/non-TTY bypass via env or flag.
- `PRIVACY.md:31-35` states first-run prompt and consent expectations.
- `tests/consent.test.ts` explicitly tests non-TTY auto-acknowledgement.

Impact:

In CI, scripted usage, MCP host processes, or any non-interactive invocation, screenshots, DOM summaries, scenario text, and persona fields can be sent to Anthropic without an explicit affirmative operator action in that process. For commercial customers, this is hard to defend as informed consent. It also weakens the "local-first" and privacy positioning.

Root cause:

The consent model optimizes for non-interactive ergonomics by treating non-TTY as consent. That is convenient for automation but too permissive for privacy-sensitive workflows.

Recommended remediation:

- Change non-TTY behavior from implicit allow to fail-closed unless one of these is present:
  - existing valid consent record,
  - `AUDIT_AUTO_CONSENT=1`,
  - `--auto-consent`.
- Update tests to expect `ConsentDeclinedError` or a dedicated `ConsentRequiredError` in non-TTY without explicit bypass.
- Update README and PRIVACY to say CI/MCP must opt in explicitly.
- Consider separate consent modes:
  - `interactive-prompt`,
  - `explicit-env`,
  - `explicit-flag`,
  - `existing-record`.

Acceptance criteria:

- Non-TTY without consent marker and without explicit opt-in fails before any LLM call.
- CI examples include `AUDIT_AUTO_CONSENT=1` with a visible privacy note.
- Tests prove no screenshot/DOM payload is sent before consent is resolved.

### F-02: URL Safety Guard Is Not Applied to All MCP Navigation Entry Points

Severity: High  
Category: SSRF/internal network exposure, MCP tool safety  
Standards mapping: OWASP ASVS input validation/SSRF controls, NIST SSDF PW.5, ISO 25010 Security

Evidence:

- `src/core/url-guard.ts` introduces `assertSafeUrl()` and blocks non-http schemes, localhost, private IPv4 ranges, selected IPv6 ranges, and cloud metadata hostnames.
- Guard usage exists in:
  - `src/mcp/tools/see.ts`
  - `src/mcp/tools/act.ts`
  - `src/mcp/tools/extract.ts`
  - `src/mcp/tools/judge.ts`
  - `src/mcp/tools/compare.ts`
  - `src/mcp/tools/diagnose.ts`
- `src/mcp/tools/audit-url.ts:49-90` accepts `url` and places it in `start_url` and `base_url` without calling `assertSafeUrl`.
- `src/mcp/tools/explore-url.ts:39-80` accepts `url` and places it in `start_url` and `base_url` without calling `assertSafeUrl`.

Impact:

An MCP client can still direct the browser through higher-level preset tools to internal resources such as localhost, RFC1918 services, or cloud metadata endpoints. Because the browser runs on the operator's machine, this can expose local network assets, intranet panels, or metadata services to screenshots, DOM extraction, logs, artifacts, and LLM prompts.

Root cause:

The safety control was added at selected primitive tool boundaries, but not centralized across every tool that can navigate.

Recommended remediation:

- Call `assertSafeUrl()` at the beginning of `audit_url` and `explore_url`.
- Centralize URL validation in a shared MCP helper so every future navigation-capable tool gets the same guard.
- Add tests for every MCP tool with:
  - `file:///etc/passwd`
  - `http://127.0.0.1`
  - `http://localhost`
  - `http://169.254.169.254`
  - `http://192.168.1.1`
  - valid `https://example.com`
- Document `PIXELCHECK_ALLOW_PRIVATE=1` as a local-development escape hatch, with warning text.

Acceptance criteria:

- `rg "requireString\\(args.url"` across MCP tools shows every navigation path followed by centralized validation.
- Tests fail if a new navigation-capable tool omits the guard.
- Private-network navigation is blocked by default in all MCP tools.

### F-03: Platform Support Claims Exceed Enforced CI Guarantees

Severity: High  
Category: Release quality, portability, customer expectations  
Standards mapping: ISO 25010 Portability/Reliability, NIST SSDF RV.1/RV.2

Evidence:

- `package.json:13-15` declares `node >=18.0.0`.
- `.github/workflows/ci.yml:65-71` states Node 18 was dropped from CI because current tooling needs Node 20+ behavior.
- `package.json:17-21` declares support for `win32`.
- `.github/workflows/ci.yml:48-55` uses `continue-on-error` for Windows.

Impact:

Users on Node 18 or Windows may assume the package is supported when the project does not enforce those combinations as hard release gates. In procurement or enterprise deployment, this creates a support and warranty mismatch.

Root cause:

Package metadata was not tightened after CI reality changed. Windows is listed as supported while known flaky or failing tests are tolerated.

Recommended remediation:

Choose one of these paths:

1. Narrow support claims:
   - Set `engines.node` to `>=20.0.0`.
   - Keep `win32` only if the package installs/runs, but document Windows as experimental until CI is hard-gated.

2. Or broaden CI:
   - Restore Node 18 hard CI if truly supported.
   - Remove Windows `continue-on-error` and fix remaining failures.

Acceptance criteria:

- Every platform/runtime advertised in `package.json` is a required CI pass.
- README installation docs match `package.json.engines`.
- Release checklist contains a hard gate for advertised OS/Node matrix.

### F-04: SBOM Script Can Produce a "Successful" Artifact From an Invalid Dependency Tree

Severity: High  
Category: Supply-chain assurance, release evidence  
Standards mapping: NIST SSDF PS.3/PW.4, OWASP SAMM Verification/Operations

Evidence:

- `package.json:68` defines `sbom` as `cyclonedx-npm --output-file sbom.json --omit dev --ignore-npm-errors`.
- Running `npm run sbom` exited 0 but printed `npm ls` errors, including many `extraneous` packages and `invalid: zod@3.25.76`.
- `sbom.json` was still present after the command.

Impact:

Enterprise customers increasingly treat SBOMs as release evidence. If SBOM generation ignores dependency-tree errors, the generated artifact may be incomplete, misleading, or non-reproducible.

Root cause:

The SBOM command intentionally ignores npm errors, likely to keep release workflows resilient. That trades away evidence integrity.

Recommended remediation:

- Remove `--ignore-npm-errors` from the SBOM script.
- Add a separate CI step before SBOM:
  - `npm ci`
  - `npm ls --omit=dev`
  - `npm run sbom`
- Generate SBOM only from clean CI, not from a local dirty `node_modules`.
- If optional dependency peer warnings are unavoidable, document exact accepted exceptions and ensure they do not produce `ELSPROBLEMS`.

Acceptance criteria:

- `npm ls --omit=dev` exits 0 in clean CI.
- `npm run sbom` exits non-zero on dependency tree errors.
- SBOM workflow uploads artifacts only after strict dependency verification.

### F-05: Dependency Security Gate Needs Clean-Install Reproducibility

Severity: Medium  
Category: Dependency management, release repeatability  
Standards mapping: NIST SSDF PS.2/PW.4/RV.1, OWASP SAMM Operations

Evidence:

- Earlier audit run reported `fast-uri` high and `hono` moderate advisories.
- Latest run on the current working tree reports 0 vulnerabilities.
- Current `npm ls fast-uri hono --omit=dev` shows:
  - `fast-uri@3.1.2`
  - `hono@4.12.18`
- `npm audit fix --dry-run --production` indicated a clean production audit can reach 0 vulnerabilities after dependency-tree cleanup.

Impact:

The current tree may be in the middle of dependency remediation. A local pass is encouraging, but release evidence must be produced from a clean, committed state. Otherwise, published packages may not match what was audited.

Root cause:

Dependency state changed during the audit and the worktree is dirty. That makes it unsafe to treat one local audit as final release proof.

Recommended remediation:

- Commit dependency fixes in a dedicated PR.
- Run these from a fresh checkout:
  - `npm ci`
  - `npm ls --omit=dev`
  - `npm audit --omit=dev --audit-level=moderate`
  - `npm test`
  - `npm run build`
- Update `SECURITY.md` to reflect the exact current audit date and dependency versions.

Acceptance criteria:

- CI produces the same 0-vulnerability result from lockfile-only install.
- No uncommitted `package.json` or `package-lock.json` changes at release tag.
- Security documentation no longer contains stale audit claims.

### F-06: Source and Release Governance Are Strong, But Missing Some Common Enterprise Supply-Chain Controls

Severity: Medium  
Category: Supply-chain maturity  
Standards mapping: NIST SSDF, OWASP SAMM Governance/Operations

Evidence:

Present controls:

- Dependabot weekly updates in `.github/dependabot.yml`
- CI matrix for Linux/macOS/Windows with Node 20/22
- Coverage gate
- Integration workflow
- License allowlist
- SBOM workflow
- Tarball dogfood workflow
- Security policy and disclosure process

Missing or not observed:

- CodeQL or equivalent SAST workflow
- Secret scanning/gitleaks/trufflehog style CI gate
- OpenSSF Scorecard
- npm provenance/trusted publishing
- SLSA or Sigstore attestation
- Branch protection enforced in repository settings cannot be verified locally

Impact:

The project is suitable for open-source engineering review, but a security-conscious commercial buyer will ask for stronger provenance and static-analysis evidence.

Recommended remediation:

- Add GitHub CodeQL for TypeScript.
- Add gitleaks or equivalent secret scanning to PR CI.
- Enable npm trusted publishing and provenance for releases.
- Add OpenSSF Scorecard workflow.
- Add a release checklist item requiring all published artifacts to be generated by CI from a signed/tagged commit.

Acceptance criteria:

- Release page contains tarball, SBOM, provenance/attestation, and checksums.
- CI status list includes SAST and secret scanning.
- Published npm package has provenance metadata.

### F-07: Redaction Logic Improved, But Needs Regression Coverage Around Prototype-Pollution and Short Secret Tradeoffs

Severity: Medium  
Category: Data leakage, defensive coding  
Standards mapping: OWASP ASVS logging/data protection, ISO 25010 Security/Maintainability

Evidence:

- `src/core/secrets.ts:57-76` auto-adds selected secret env var values to redaction patterns when length is at least 4.
- `src/core/secrets.ts:103-108` now uses `Object.create(null)` and skips `__proto__`, `constructor`, and `prototype` keys in `redactDeep`.

Impact:

The prototype-key skip is a positive hardening change. The shortened minimum secret length from 8 to 4 improves coverage of shorter test secrets but can over-redact normal content if a short env secret is common text. This is not a blocker, but it should be intentionally documented and tested.

Recommended remediation:

- Add tests proving `redactDeep` does not preserve prototype-pollution keys.
- Add tests for short secret values to ensure useful redaction without excessive false positives.
- Consider maintaining length >= 8 for general secrets and explicit allowlist for known short credentials like PIN/OTP fields.

Acceptance criteria:

- Regression tests cover `__proto__`, `constructor`, and `prototype`.
- Documentation explains how config redaction patterns interact with env-derived patterns.

### F-08: Calibration and LLM-Dependent Quality Gates Are Not Fully Enforced

Severity: Medium  
Category: Product quality, AI evaluation reliability  
Standards mapping: ISO 25010 Functional Suitability/Reliability, NIST SSDF RV.1

Evidence:

- `progress/RELEASE-READINESS-CHECKLIST.md` lists LLM cassette replay and calibration items as dependent on API key availability.
- `.github/workflows/calibration.yml` skips when `ANTHROPIC_API_KEY` is missing.

Impact:

PixelCheck's core value depends on LLM/vision judging quality. If calibration can skip cleanly, core product quality may regress without blocking releases.

Recommended remediation:

- Require calibration for release tags and model/prompt changes.
- Keep PR calibration optional or label-triggered to control cost.
- Store calibration results as release artifacts.
- Define a manual emergency waiver process if the provider is unavailable.

Acceptance criteria:

- Release workflow fails if calibration is skipped on a release tag.
- Calibration baseline drift thresholds are documented and versioned.

## Positive Controls Observed

Security and privacy:

- Security disclosure policy exists.
- Dependency scanning and Dependabot exist.
- Secrets redaction exists in logs and reports.
- Privacy data-flow documentation is detailed.
- Cost guard and local cache governance are documented.

Quality:

- TypeScript build passes.
- Unit suite is large and currently passing.
- Coverage thresholds are enforced.
- Integration workflows exist for Playwright and cross-process file locks.
- Structured result schemas and schema idempotence checks exist.

Release engineering:

- Tarball dogfood workflow exists.
- License allowlist passes.
- SBOM workflow exists.
- Package `files` field limits publish contents.
- ADRs and release-readiness docs are unusually complete.

## Recommended Remediation Plan

Phase 1: release blockers

1. Make non-TTY consent fail-closed unless explicit consent is present.
2. Apply `assertSafeUrl()` to `audit_url` and `explore_url`; add complete MCP URL guard tests.
3. Re-run all gates from a clean checkout and commit dependency fixes.
4. Remove `--ignore-npm-errors` from SBOM generation and make `npm ls --omit=dev` clean.

Phase 2: support and release consistency

1. Align `package.json.engines.node` with CI reality, likely `>=20`.
2. Either hard-gate Windows CI or document Windows as experimental.
3. Update `SECURITY.md`, `README.md`, and `PRIVACY.md` after behavior changes.
4. Require release evidence from CI, not local dirty state.

Phase 3: enterprise hardening

1. Add CodeQL.
2. Add secret scanning.
3. Add OpenSSF Scorecard.
4. Enable npm provenance/trusted publishing.
5. Require calibration on release tags.

## Release Decision

Current status: conditional no-go for enterprise/commercial release.

The codebase is close, but the consent model and incomplete URL guard coverage should be treated as blockers. After those are fixed and the release is verified from a clean CI run with strict SBOM generation, the project can be reassessed as commercial-ready.

Minimum go-live gate:

- `npm ci`
- `npm ls --omit=dev`
- `npm audit --omit=dev --audit-level=moderate`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run test:coverage:check`
- `npm run license:check`
- `npm run sbom` without ignored npm errors
- URL safety tests across every MCP navigation tool
- Consent tests proving non-TTY fail-closed behavior

