# SARIF → GitHub Code Scanning manual upload verification

**Status**: SOP documented; **manual GHCS UI screenshot pending v1.0-rc1**
(needs a real GitHub repo with Code Scanning enabled).

This doc is the **manual half** of T6 (closes RISK-REGISTER-V2 R6). The
automated half — verifying our SARIF output is structurally valid and
contains the expected `wcag/X-Y-Z` ruleIds + W3C help URLs — runs in CI
via `tests/integration/playwright/wcag-axe.test.ts`.

What automation can't catch:
- How GitHub Code Scanning's UI **renders** our SARIF
- Whether the "View documentation" link in the issue detail panel really
  goes to the right W3C URL
- Whether the `help.markdown` field renders as expanded markdown or as
  plain text in different GHCS releases
- Whether GitLab SAST, Sonatype, Snyk Code, or other SARIF consumers
  render our output similarly

These are one-time UI verifications best done by human eyes with a
screenshot. We re-verify when:
- SARIF spec major bump (currently 2.1.0; if 2.2.0 ships)
- GitHub Code Scanning UI changes (rare)
- We change `renderSarif()` rule shape in `src/core/ci-reporters.ts`

---

## SOP — manual upload verification

**Time budget**: ~15 minutes for someone with GitHub repo access.

### Prerequisites

- A GitHub repo with **Code Scanning** enabled (free for public repos;
  enabled by default on most orgs). Settings → Code security → Code
  scanning → Set up
- Push access OR ability to open a PR

### Steps

1. **Get the SARIF fixture file**:

   ```bash
   cat docs/integration/fixture-sarif.json
   # 10 KB / 5 rules / 6 results — committed by T6
   ```

   Or regenerate from the latest renderSarif:

   ```bash
   npx tsx scripts/gen-sarif-fixture.ts
   ```

2. **Create a test branch + push the SARIF**:

   ```bash
   git checkout -b sarif-upload-verify
   mkdir -p .github/workflows
   ```

   Create `.github/workflows/upload-sarif-test.yml`:

   ```yaml
   name: Upload SARIF — manual verification
   on:
     workflow_dispatch:
   jobs:
     upload:
       runs-on: ubuntu-latest
       permissions:
         security-events: write
       steps:
         - uses: actions/checkout@v4
         - uses: github/codeql-action/upload-sarif@v3
           with:
             sarif_file: docs/integration/fixture-sarif.json
             category: pixelcheck-fixture-test
   ```

   ```bash
   git add .github/workflows/upload-sarif-test.yml
   git commit -m "chore: SARIF upload verification workflow"
   git push -u origin sarif-upload-verify
   ```

3. **Trigger the workflow**:

   - GitHub UI → Actions → "Upload SARIF — manual verification" →
     Run workflow → Select branch `sarif-upload-verify` → Run

   Wait ~30s for the workflow to complete.

4. **Inspect the Code Scanning UI**:

   GitHub UI → Security → Code scanning. You should see **6 alerts**
   matching the 6 issues in the fixture. Each grouped under the rule
   it triggered:

   - `wcag/1-1-1` — Image missing alt attribute (Level A)
   - `wcag/4-1-2` — 2 alerts (Form field missing label + Empty button name) (Level A)
   - `wcag/1-4-3` — Low contrast text (Level AA)
   - `wcag/2-4-4` — Ambiguous link text (Level A)
   - `wcag/1-3-1` — Heading order skipped (Level AA)

5. **Click into an alert** (e.g. `wcag/1-4-3`). Verify:

   - [ ] Rule title: `WCAG 1.4.3 Contrast (Minimum) (Level AA)`
   - [ ] Description: `Web Content Accessibility Guidelines 1.4.3 — Contrast (Minimum). Conformance level AA under the perceivable principle.`
   - [ ] **"View documentation" link** at the top points to
         `https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum`
   - [ ] **Help section** below shows the markdown bold + W3C link,
         not raw `**WCAG 1.4.3...**` text

6. **Screenshot the issue detail panel** + commit:

   ```bash
   # Save the screenshot at:
   # docs/screenshots/sarif-ghcs-render.png
   git add docs/screenshots/sarif-ghcs-render.png
   git commit -m "docs: SARIF GHCS UI render screenshot (T6 manual verification)"
   ```

7. **Update this doc** with the verification date + reviewer + GHCS
   version (visible in the GitHub UI footer):

   - Verified date: `<YYYY-MM-DD>`
   - Verified by: `@<github-handle>`
   - GHCS UI version: `<version>` (or "current as of `<date>`")

8. **Cleanup**:

   ```bash
   # Don't merge sarif-upload-verify; let it stay as audit history
   git checkout main
   ```

---

## Verification log

| Date | Reviewer | GHCS version | Outcome | Notes |
|---|---|---|---|---|
| 2026-05-01 | (pending v1.0-rc1) | — | — | T6 SOP committed; awaits human reviewer |

When v1.0-rc1 ships, fill in the row. Subsequent rows are added on
re-verification triggers (SARIF spec bump / renderSarif logic change /
GHCS UI redesign).

---

## What to do if a check fails

| Failure | Likely cause | Fix |
|---|---|---|
| Alert count != 6 | `renderSarif` deduplicating differently OR fixture changed | Run `npx tsx scripts/gen-sarif-fixture.ts` to regenerate. If diff seems intentional, update this doc + RISK-REGISTER-V2. |
| "View documentation" link missing | `helpUri` not set on rule (regression in `buildRule`) | Check `src/core/ci-reporters.ts buildRule` — WCAG branch must set `helpUri = wcagHelpUrl(sc)` |
| Help section shows raw markdown text | GHCS started rendering `help.text` instead of `help.markdown` | Update `buildRule` to put the same content in both fields |
| Wrong WCAG SC name in shortDescription | `WCAG_CATALOG` (in `src/core/wcag.ts`) wrong | Check W3C TR/WCAG22 official table; update catalog |
| Rule level (error/warning) wrong | `SEVERITY_LEVELS` mapping changed | Verify `src/core/ci-reporters.ts SEVERITY_LEVELS[severity].sarif` |
| `wcag/X-Y-Z` ruleId missing | `wcagSarifRuleId` slug logic broken | Check `src/core/wcag.ts wcagSarifRuleId(sc)` returns `wcag/${sc.id.replace(/\./g, "-")}` |

---

## See also

- [tests/integration/playwright/wcag-axe.test.ts](../../tests/integration/playwright/wcag-axe.test.ts) — automated half
- [docs/decisions/ADR-024-wcag-clause-grouping.md](../decisions/ADR-024-wcag-clause-grouping.md) — original SARIF + WCAG design
- [docs/decisions/ADR-019-ci-friendly-output-formats.md](../decisions/ADR-019-ci-friendly-output-formats.md) — overall CI formats
- [SARIF 2.1.0 spec](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)
- [GitHub Code Scanning SARIF support](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning)
