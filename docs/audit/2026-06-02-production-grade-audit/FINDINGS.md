# pixelcheck — Production-Grade Audit FINDINGS (full inventory)

> Baseline `299500e`. 6 read-only audit agents (D1 security / D2 robustness / D3 correctness /
> D4 build-release / D5 UX-report / D6 eng-standard). **Audit phase only — no fixes applied.**
> Findings grouped by **root cause** (problem-analysis 铁律), not by dimension. Severity:
> CRIT / HIGH / MED / LOW. File:line are from the agents; re-verify each before fixing.

## Severity tally

| | CRIT | HIGH | MED | LOW |
|---|---|---|---|---|
| count | ~10 | ~17 | ~25 | ~20 |

Plus 7 named **test blind spots** (D3) and several "done well" notes (not re-listed).

---

## ⚠️ OPS-0 (do now, not code): live Anthropic key in `.env`
`.env:1` holds a real `sk-ant-...` key. Not in git, not in npm tarball (verified) — but exposed on disk + now in an agent transcript. **Rotate the key.** Then ensure `.env` stays gitignored.

---

## Theme A — Browser-binary supply chain (the install/self-heal path)
Ironically the area just touched in the A–F first-run work. Highest blast radius: auto-runs at `npm install` (postinstall), at launch self-heal, and via MCP `doctor {fix:true}`.

- **A1 [CRIT] D1-C1** `browser-install.ts:278-309` — downloaded browser zip is unpacked + `chmod 0755` + launched with **no checksum/signature/size verification**. MITM/CDN-compromise/DNS-hijack ⇒ silent arbitrary native-code execution on every user machine.
- **A2 [CRIT] D1-C2** `browser-install.ts:186-218` — `downloadToFile` follows up to 5 redirects, feeding `Location` back into `https.get` with **no origin pinning**. Amplifies A1 (redirect to attacker host).
- **A3 [LOW→HIGH if A1] D1-L1** `browser-install.ts:222-234` — `extractZip` has **no zip-slip protection**; trusts archive internal paths. Safe only while the archive is trusted (which A1/A2 break).
- **A4 [MED] D4-M3** `browser-install.ts:221-234` — Windows extraction: first tries `unzip` (not built-in on Windows) then `tar`; comment's reasoning is inverted. Fragile on locked-down Windows.

## Theme B — MCP server security surface (no auth + SSRF + consent bypass)
The MCP server is the flagship product surface and currently the weakest security boundary.

- **B1 [HIGH] D1-H3** `mcp/server.ts:134-154` + `consent.ts:214-224` — MCP dispatcher calls any tool with **no auth/authz**; consent is **auto-granted whenever stdin isn't a TTY** (always true for MCP) ⇒ the only privacy gate is effectively off for the whole MCP surface.
- **B2 [HIGH] D1-H2** SSRF guard `assertSafeUrl` is only on some primitive wrappers; **absent on `audit_url`/`explore_url`** (`mcp/tools/audit-url.ts`, `explore-url.ts`) and **absent at the `page.goto` chokepoint** (`agent/agent-loop.ts:180`, `core/primitives/{act,see,extract}.ts`, `runner.ts`). Redirects from a public page to a private IP are **not re-checked**. → SSRF to `169.254.169.254`, localhost, internal panels, exfil via model.
- **B3 [MED] D1-M2** `mcp/tools/get-last-report.ts:22-25` — reads an **arbitrary caller-supplied path**; arbitrary local-file disclosure of prior audits (which per C-theme may hold unredacted secrets).

## Theme C — Secret leakage / redaction gaps
Redaction is partial and conditional; secrets flow through several unredacted channels.

- **C1 [HIGH] D1-H1** `agent/dom-summary.ts:66-81` → `agent-loop.ts:186-187` — DOM summary sent to the LLM copies `input.value` (first 30 chars) with **no type/name redaction**, defeating the screenshot redaction that DOES mask password/secret/card fields. Password/OTP/server-token leaves the machine even with `--redact-inputs` on. Contradicts PRIVACY.md + consent promise.
- **C2 [MED] D1-M1** `reporter.ts:14-17,29-30,97-98` — reports redact **only when `redact_patterns` is non-empty**; otherwise `audit.json`/HTML/SARIF written verbatim. A token harvested off the page lands unredacted on disk + via `get_last_report`.
- **C3 [MED] D1-M3** `cli.ts:82-88` — global `~/.pixelcheck/.env` injects `ANTHROPIC_API_KEY`/`SCAMLENS_ADMIN_COOKIE`/`STRIPE_TEST_*` into **every** run regardless of target site (cross-project secret bleed).
- **C4 [MED] D1-M4** `runner.ts:308-317` + `secrets.ts:6-29` — admin-cookie injection triggered by URL-substring `includes("/admin")`; cookie domain from config, **not validated against actual navigation origin** ⇒ high-value session cookie can be sent to wrong host (esp. on cross-origin redirect).

## Theme D — Agent liveness: dead-loops, hangs, no deadlines (the login-stuck I hit)
Missing liveness guards. This is the root of the 26-step login loop I observed in Step 8.

- **D1 [CRIT] D2-C1 + D2-H3** `agent/convergence.ts:78-134` + `agent-loop.ts:262-557` — **no no-progress circuit breaker.** Loop-detection hash includes the LLM's free-text `instruction` (varies each step) ⇒ never reaches threshold. Stuck-detection counts only **consecutive failures**, reset to 0 by any "successful" fill ⇒ a fill→click→fill→click loop on a login wall runs to `max_actions`/budget. **Direct cause of the observed symptom.**
- **D2 [CRIT] D2-C2** `core/llm.ts:87`, `navigator.ts:104`, `planner.ts:168,313`, `computer-use.ts:126` — **no timeout/AbortSignal on ANY LLM call**; Anthropic client built with defaults. A hung request hangs the whole run forever (cost-guard never fires on a call that never returns).
- **D3 [CRIT] D2-C3** `runner.ts:70-274` — **no wall-clock per-unit deadline.** A hang (D2/D3) never finishes, never reaches `finally`, leaks Chromium + CDP port, blocks the whole matrix `Promise.all`.
- **D4 [MED] D2-M1** `agent/events.ts:123-165` — single-resolver pause/takeover; a second waiter orphans the first promise ⇒ permanent hang (latent).
- **D5 [MED] D2-M3/M4** `stagehand-wrapper.ts:159-427,111-127` — no timeout on `stagehand.init()` (leak on partial init); `getFreePort` TOCTOU race under concurrent units ⇒ flaky launch crash (the comment under-estimates it given the tool's own fan-out).
- **D6 [MED] D2-M5 + D3-M1] `llm.ts:139-304` — `repairTruncatedJson` advances `lastSafeEnd` on partial tokens ⇒ can cut mid-number/keyword, produce a structurally-valid-but-wrong plan that "passes" and feeds the stuck-without-failure pattern.
- **D7 [LOW] D2-H1** `handlers/index.ts:69-75` — `executeStep` calls the **vendored** `withRetry` (option shape `maxAttempts`) not core `retry.ts` — option-contract mismatch; `act` may retry more/fewer than `step.retry`, and each retry re-runs the full 4-layer fallback (cost amplification, ties to E3).
- **D8 [LOW] D2-L2** `mcp/server.ts` — no `unhandledRejection`/`uncaughtException` handler; a stray rejection (e.g. screencast frame callback) can crash the long-lived MCP server.

## Theme E — Cost accounting & status correctness
Ledger + status aggregation + primitive cost contracts have real bugs.

- **E1 [CRIT] D3-C1** `core/primitives/see.ts:403-416` — `see()` makes an **unconditional extra paid vision call** (`detectVisualState`) on every real capture even with no goal & scoring off — violates the documented "0 LLM cost without goal" contract, disables the goal-less cache, and the production path is **gated to only run when no test seam ⇒ effectively untested**. `diagnose` pays 3 vision calls not ~2.
- **E2 [CRIT] D3-C2** `handlers/index.ts:293-298` + `runner.ts:493-499` — `act` Layer-4 `skip` returns `status:"skip"`, which status aggregation treats as neither fail nor warn ⇒ **a critical action that could not be performed reports the scenario as PASS** ("looks green but the journey can't complete").
- **E3 [HIGH] D3-H1** `handlers/index.ts:178-303` — the multi-layer `act` fallback (incl. up to 8 Opus computer-use iterations) is nested **inside** the outer `withRetry` ⇒ on retry the entire expensive cascade re-runs, multiplying spend ~3×.
- **E4 [HIGH] D3-H2** `cost-guard.ts:396-440` — run counters bump **before** the ledger file-lock; on lock-timeout (10+ concurrent procs) the daily cap is silently **not enforced** (under-count) while only the run cap holds. Cross-process daily wallet diverges.
- **E5 [MED] D3-L4** `llm.ts:129` — `estimateCost` falls back to **Sonnet pricing for unknown model ids** ⇒ a typo'd Opus id is billed 5× too low, under-reporting spend silently.
- **E6 [MED] D3-M2/M3] `judge.ts:594-612` / `compare.ts:572-633` — judge doesn't require all criteria present (missing one spuriously raises overall score); compare `fast` accepts null scores and derives winner from labels only (internal inconsistency undetected).
- **E7 [MED] D3-M5** `diagnose.ts:716-723,612-620` — anti-hallucination evidence-ref check only requires a non-empty `path` string; it is **never validated against the actual diagnostics block** ⇒ a model can cite a nonexistent path (e.g. accessibility, which has no collector) and the finding passes.
- **E8 [LOW] D3-M6** `i18n.ts:91` — `zh-TW`/`zh-Hant` collapse to Simplified `zh-CN`.
- **E9 [LOW] D3-L1/L2** `act.ts:546-574` — `press` ignores per-step timeout; `scroll` with no params is a silent no-op reported as success.

## Theme F — Cross-platform / build / release / governance
- **F1 [HIGH] D4-H2** `mcp/tools/*.ts` (see/act/judge/extract/compare/diagnose/explore-url/audit-url) use `path.resolve("./personas")` (CWD-relative) with **no bundled fallback** — the CLI has `resolveBundledPersonas()` but MCP doesn't. ⇒ **persona feature is a silent no-op for every MCP/global user** (the flagship surface). Same class as the v1.0 "personas not bundled" bug, fixed for CLI only.
- **F2 [HIGH] D4-H1** `browser-install.ts:95,428` — `playwright-core` used at runtime (`esmRequire.resolve`) but **not a declared dependency** (only `playwright` is). Works today via hoisting; fragile.
- **F3 [HIGH] D6-H3** no automated publish/release workflow — `npm publish` is fully manual from a dev box (risk of wrong/dirty artifact; no provenance).
- **F4 [MED] D4-M1 + D6-M4** `src/vendor/stealth-core/` ships to npm with **no LICENSE/NOTICE/provenance/version pin**; CI drift check is a no-op on runners (`AUDIT_VENDOR_DRIFT_SKIP_IF_MISSING=1`). License-compliance + supply-chain gap.
- **F5 [MED] D4-M2** `scenarios/handlers/install-extension.ts` shipped in tarball as raw `.ts` importing `../../src/...` (src not published) ⇒ dangling import for any user referencing it.
- **F6 [MED] D4-M4 + D6-M3** `package.json` `engines.node>=18` but toolchain needs Node 20+ (`util.styleText`); CI is 20/22 only. Docs (README/CONTRIBUTING) repeat the false Node-18 claim + stale test count + wrong coverage-gate name (66 vs the "60/54/60/60" displayed).
- **F7 [LOW] D4-L1** `npm test` hard-codes `bash` (check-no-console.sh) ⇒ fails on no-bash Windows / publish env.

## Theme G — Governance & quality gates (signal without enforcement)
- **G1 [CRIT] D6-C1** `main` branch is **completely UNPROTECTED** (`gh api .../branches/main/protection` → 404) despite every workflow's comments claiming required checks + no-force-push. All CI gates are bypassable. (We relied on this during the merge train — it's also a real governance hole.)
- **G2 [HIGH] D6-H1** ESLint is configured (`eslint.config.js`, real rules) but **no `lint` script and no CI step runs it** — dead gate; only a `bash` console-grep runs.
- **G3 [HIGH] D6-H2 + MED D6-M1/M2** coverage floor (66/60/66/66) is ~15pts **below actual** (80.9/68.8) so a big regression wouldn't trip it; **MCP tools 5-10% covered**, observer/dashboard/benchmark-executor ~0% — the flagship + live-server code is least tested.
- **G4 [LOW] D6-L1/L2/L3** 17 low advisories undocumented (ci comment claims "0 vulnerabilities"); Windows shipped-but-not-gated (`continue-on-error`); bench gate stuck in observation mode.

## Theme H — Report/CLI UX + the tool's OWN accessibility (ironic for an a11y auditor)
- **H1 [CRIT] D5-C1** `commands/init-interactive.ts:163-180` — the interactive `init` wizard scaffolds a scenario using a non-existent `see` step type ⇒ `pixelcheck run` fails Zod parse. **The single guided first-run path is broken.** (Non-interactive `init <dir>` emits a valid scenario — the two scaffolders disagree.)
- **H2 [HIGH] D5-H2** `ci-reporters.ts:530-555` — GitHub annotation messages **double-encode** `%0A` → `%250A`, rendering a literal `%0A` instead of a newline in every PR annotation.
- **H3 [HIGH] D5-H3** `cli.ts:806-904` — `explore` runs are **never saved to history** (only `run` calls `saveAuditToHistory`) ⇒ history/trends/diff empty for the documented quick-start workflow, no warning.
- **H4 [HIGH] D5-H4** `cli.ts:1562-1574` — exit codes conflated: `--min-score` gate-fail and scenario-fail both exit `1`; warn=2 is masked. CI can't distinguish gate regression from failure.
- **H5 [HIGH] D5-H5** `reporter-diff.ts:248` — diff HTML hardcodes `lang="en"` while rendering translated content ⇒ WCAG 3.1.1 failure **in the a11y tool's own report**.
- **H6 [MED] D5-M6/M7** `reporter-spa.ts:102,153-178` — SPA report FAIL badge contrast **3.86:1** (< AA 4.5); filter `<label>`s have no `for=`/`aria-label` (WCAG 1.3.1/4.1.2) — a11y failures in the tool's own UI.
- **H7 [MED] D5-M9/M10/M11] `cli.ts` — `--ci-format` silently drops unknown tokens (typo ⇒ zero CI output, build "passes"); `--no-baseline` default undocumented (visual-diff runs unrequested first-run); redundant `explore` dotenv reload with wrong precedence.
- **H8 [LOW] D5-L12** `✓`/`✗` glyphs in benchmark/calibration output + committed markdown violate the **no-emoji / text-label** standard (rest of tool correctly uses `[OK]`/`[FAIL]`).
- **H9 [LOW] D5-L13/L16** markdown `summary.md` doesn't escape `|`/backticks (table corruption); static `audit.html` 0-results shows blank cards with no "no results" message.

---

## Test blind spots (D3) — where a regression slips past CI
1. `see.detectVisualState` production path (E1) — gated to never run in tests.
2. cost-guard ledger-write-failure / daily-divergence (E4).
3. `handleAct` fallback-under-retry cost amplification (E3).
4. runner `skip`-status aggregation (E2).
5. `repairTruncatedJson` mid-number/keyword truncation (D6).
6. `diagnose` fabricated-evidence-path (E7).
7. `estimateCost` unknown-model silent Sonnet billing (E5).

---

## Proposed fix grouping (for the implement phase — pending Wayne approval)

**Wave 1 — Security & supply chain (CRIT/HIGH):** A1-A4 (checksum + origin-pin + zip-slip + win extract), B1-B3 (MCP consent/auth + SSRF at goto chokepoint + get_last_report sandbox), C1-C4 (DOM-summary redaction + always-redact reports + cookie origin-scoping). + OPS-0 key rotation (Wayne).

**Wave 2 — Liveness (CRIT):** D1-D3 (no-progress breaker + LLM timeout + per-unit deadline) — fixes the login-loop + hang-leak class; D4-D8 follow-ons.

**Wave 3 — Cost/correctness (CRIT/HIGH):** E1 (see extra call), E2 (skip→pass), E3 (retry cost), E4 (daily cap), E5-E9.

**Wave 4 — Build/release/governance:** F1 (MCP persona resolution), F2 (playwright-core dep), F3 (publish workflow), F4-F7; G1 (branch protection), G2 (eslint in CI), G3 (coverage floor + MCP/observer tests), G4.

**Wave 5 — UX/own-a11y:** H1 (broken init), H2-H5, H6 (own-a11y), H7-H9.

Each wave: fix → add regression test (close the matching blind spot) → local CI green. Then one local full closed-loop, then publish.

---

## Remediation status (updated 2026-06-02)

All fixes shipped with regression tests + local closed-loop (tsc clean,
lint 0 problems, full suite 2222 passed, coverage gate green).

- **PR #43** (`audit-2026-06-02-hardening`): OPS-0 (key rotation — Wayne),
  A1-A4, B1-B3, C1-C4, D1-D3, E1-E2, F1, F2, G2.
- **PR #44** (`audit-w5-followups`, stacked on #43): H1, H2, C2-gap, E3, E4,
  E5 — then this session: **D4, D5, D6, D7, D8, E6, E7, E8, E9, H3, H4, H5,
  H6, H7, H8, H9**; G2-tail (all 35 lint warnings cleared); G3-partial
  (coverage floor 66/60/66/66 → 74/62/75/75, ~5pts under actual per
  ADR-017); **F3** (release.yml — needs one-time NPM_TOKEN secret); doctor
  test-isolation flake fixed (browsersRoot honors PLAYWRIGHT_BROWSERS_PATH
  first).

### Tech-debt sweep (2026-06-02, stacked on #44 — F4-F7 / G3 / G4)
- **F4** vendored stealth-core: added LICENSE + PROVENANCE.md + committed
  SHA-256 `integrity.json`; new `check:vendor-integrity` runs on every CI
  runner (the canonical-diff check stays maintainer-local) + disclosed in
  THIRD_PARTY_LICENSES.md. Regression test for tamper/extra/missing.
- **F5** shipped custom-handler example ported `.ts` → self-contained `.js`
  (no `../../src` dangling import; loads via dynamic import in an installed
  pkg). Doc + regression test updated.
- **F6** `engines.node` `>=18` → `>=20` (toolchain truth); purged stale
  Node-18 / test-count / coverage-gate-name / "12-config" claims across
  README-adjacent docs + ci.yml comments; coverage-gate job name genericized
  so it can't drift; regression test locks engines/CI-matrix agreement.
- **F7** no-console gate ported `bash` `.sh` → cross-platform `tsx` `.ts`
  (npm test / prepublishOnly no longer need bash); regression test.
- **G3 (rest)** added MCP-tool + observer + benchmark unit tests: MCP tools
  5-10% → 20-94%, observer dashboards / doctor 0/22% → 100%, get_last_report
  (B3 sandbox) / see → 94%, benchmark executor 0% → taskToScenario covered,
  + a cross-tool SSRF regression (B2) over all 8 URL tools. Global coverage
  79.1/67.6/80.7/80.6 → 81.1/69.8/82.9/82.7; floor ratcheted 74/62/75/75 →
  76/64/77/77 (ADR-017). Remaining low: observer/server + screencast
  (http/CDP — need integration mocking, diminishing returns).
- **G4** documented the 17 LOW advisories honestly (single root cause
  @ai-sdk/provider-utils) + dev-only moderate (brace-expansion) in
  SECURITY.md; fixed the false "0 vulnerabilities" CI comment; clarified
  windows-latest non-blocking + bench/dogfood observation in docs;
  regression test locks the wording.

### G1 branch protection — partially applied (2026-06-02, Wayne approved "best practice")
- **Done now (non-disruptive, pure upside):** `main` protection enabled via
  `gh api PUT .../branches/main/protection` — `enforce_admins=true`,
  `allow_force_pushes=false`, `allow_deletions=false`. History-destroying ops
  are blocked for everyone incl. admins; normal pushes/merges/PRs (and the
  #43/#44 merge train) are unaffected.
- **Deferred to AFTER #43/#44 merge:** required status checks + required PR
  reviews. The check contexts (`Test (ubuntu-latest · Node 20)` + 7 others,
  `Playwright integration (real chromium)`, `Coverage gate (ADR-017 ratchet)`)
  only become selectable once those workflows have run on `main`, and adding
  them now could block the in-flight stacked PRs. Follow-up once merged:
  ```
  gh api -X PUT repos/xcodethink/pixelcheck/branches/main/protection --input - <<'JSON'
  { "required_status_checks": { "strict": true,
      "contexts": ["Test (ubuntu-latest · Node 20)", "Playwright integration (real chromium)", "Coverage gate (ADR-017 ratchet)"] },
    "enforce_admins": true,
    "required_pull_request_reviews": { "required_approving_review_count": 0 },
    "restrictions": null, "allow_force_pushes": false, "allow_deletions": false }
  JSON
  ```
  (solo repo: `required_approving_review_count: 0` keeps PR flow without a
  second-reviewer deadlock; raise it if/when more maintainers join.)
</content>
