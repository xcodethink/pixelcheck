# GitHub PR diff comment — manual rendering verification

**Status**: SOP documented; **manual GitHub UI screenshot pending v1.0-rc1**
(needs a real GitHub repo with PR write access).

This doc is the **manual half** of T7c (closes RISK-REGISTER-V2 R9). The
automated half — verifying our `renderDiffMarkdown()` produces correct
GFM markdown with delta arrows + emojis + tables — runs in vitest unit
tests (`tests/reporter-diff.test.ts`).

What automation can't catch:
- How **GitHub** renders our markdown (vs spec — GFM has 4 dialects)
- How `sticky-pull-request-comment` action displays + updates our comment
  on subsequent runs
- Whether GitLab MR / Bitbucket PR render the same output similarly
- Whether emojis (▲ ▼ ✅ ⚠️ 🆕) display correctly across browsers

These need human eyes + a screenshot. We re-verify when:
- `renderDiffMarkdown` logic changes (`src/core/reporter-diff.ts`)
- New diff section added (e.g. WCAG by-criterion section)
- GitHub PR comment UI changes (rare, but happens)

---

## SOP — manual upload verification

**Time budget**: ~10 minutes for someone with GitHub PR write access.

### Prerequisites

- GitHub repo with PR-write permission
- Ability to open a PR (any small change works)

### Steps

1. **Get the fixture diff markdown**:

   ```bash
   cat docs/integration/fixture-diff.md
   # ~1.1 KB, 28 lines
   ```

   Or regenerate from latest renderDiffMarkdown:

   ```bash
   npx tsx scripts/gen-diff-fixture.ts
   ```

2. **Open a test PR**:

   ```bash
   git checkout -b diff-render-verify
   echo "// trigger PR" >> docs/integration/diff-pr-comment-verified.md
   git add docs/integration/diff-pr-comment-verified.md
   git commit -m "chore: trigger PR for diff render verification"
   git push -u origin diff-render-verify
   gh pr create --title "[draft] Diff render verification" --body "Test PR for T7c"
   ```

3. **Post the fixture as a PR comment**:

   ```bash
   gh pr comment <PR-NUMBER> --body-file docs/integration/fixture-diff.md
   ```

   Or via GitHub UI: open the PR → Add comment → paste fixture-diff.md
   contents → Comment.

4. **Inspect the rendered comment**. Verify:

   - [ ] H2 heading "AI Browser Audit Diff" renders correctly
   - [ ] Two `code spans` (`run-baseline-...`, `run-pr-1234-...`) render
         with monospace + grey background
   - [ ] First metric table has 5 rows with right-aligned numeric cols
   - [ ] Score row shows: `7.2 | 8.4 | ▲ +1.2 ✅` (green up-arrow + check)
   - [ ] Issues row shows: `4 | 2 | ▼ -2 ✅` (down-arrow is GOOD here
         because fewer issues is better — value-aware polarity)
   - [ ] Cost row shows: `$0.250 | $0.310 | ▲ +$0.060 ⚠️` (up + warn —
         more cost is bad)
   - [ ] Per-dimension table: 6 rows sorted by delta descending
   - [ ] "🆕 New issues (1)" section renders the emoji + count
   - [ ] "✅ Resolved issues (3)" section renders 3 bullets
   - [ ] Numbers + arrows align properly (no broken Unicode)

5. **Test sticky-pull-request-comment action** (optional but high-value):

   In a real CI workflow, post the diff using:
   [sticky-pull-request-comment](https://github.com/marshmallow/sticky-pull-request-comment).
   Verify subsequent posts UPDATE the same comment instead of stacking.

   Sample workflow snippet:
   ```yaml
   - uses: marocchino/sticky-pull-request-comment@v2
     with:
       header: pixelcheck-diff
       path: docs/integration/fixture-diff.md
   ```

   Trigger the workflow twice (e.g. add a noop commit). Verify the
   second run REPLACES the first comment, not appends.

6. **Screenshot the rendered comment + commit**:

   ```bash
   # Save the screenshot at:
   # docs/screenshots/diff-pr-comment.png
   git add docs/screenshots/diff-pr-comment.png
   git commit -m "docs: PR diff render screenshot (T7c manual verification)"
   ```

7. **Update this doc** with the verification date + reviewer + GitHub
   release version (visible in repo footer):

   - Verified date: `<YYYY-MM-DD>`
   - Verified by: `@<github-handle>`
   - GitHub Enterprise Server version: (blank if cloud) or `<version>`
   - Browser: Chrome / Firefox / Safari `<version>`

8. **Close the test PR**:

   ```bash
   gh pr close --delete-branch <PR-NUMBER>
   ```

---

## Verification log

| Date | Reviewer | Browser | Outcome | Notes |
|---|---|---|---|---|
| 2026-05-01 | (pending v1.0-rc1) | — | — | T7c SOP committed; awaits human reviewer |

When v1.0-rc1 ships, fill in the row. Subsequent rows are added on
re-verification triggers (renderDiffMarkdown change / GitHub UI redesign).

---

## Sample workflow for production users

This is the **recommended** GitHub Actions workflow for running an
audit + posting the diff to PR comments:

```yaml
name: Audit on PR
on:
  pull_request:
    branches: [main]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - name: Run audit on baseline (main)
        run: npx ai-audit run --tag baseline-${{ github.sha }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Run audit on PR
        run: npx ai-audit run --tag pr-${{ github.event.pull_request.number }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Generate diff
        run: npx ai-audit diff baseline-${{ github.sha }} pr-${{ github.event.pull_request.number }} --format markdown --output diff.md
      - uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: pixelcheck-diff
          path: diff.md
```

This is documented in [docs/ci-integration.md](../ci-integration.md) and
will be the officially-recommended pattern in v1.0 README.

---

## What to do if a check fails

| Failure | Likely cause | Fix |
|---|---|---|
| Tables don't render aligned | GFM table syntax broken | grep `\|` count per row in fixture-diff.md — must be consistent |
| Emoji squares (▲ ▼ ✅ 🆕) | Browser missing emoji font OR wrong UTF-8 | check `Content-Type` of paste; force UTF-8 |
| Up-arrow on issues count instead of down | Polarity logic broken in renderDiffMarkdown (issuesDelta sign or labelling) | check `src/core/reporter-diff.ts > issuesDeltaCells` |
| sticky-pull-request-comment stacks (doesn't update) | `header:` field changed between runs | pin a stable `header:` like `pixelcheck-diff` |
| GitLab/Bitbucket renders differently | Not strictly GFM | document in compatibility table; consider HTML-fallback render in v1.x |

---

## See also

- [tests/reporter-diff.test.ts](../../tests/reporter-diff.test.ts) — automated half (50 tests)
- [docs/decisions/ADR-022-pr-diff-report.md](../decisions/ADR-022-pr-diff-report.md) — original PR diff design
- [docs/ci-integration.md](../ci-integration.md) — full CI integration guide (v1.0)
- [GitHub Flavored Markdown spec](https://github.github.com/gfm/)
- [sticky-pull-request-comment action](https://github.com/marshmallow/sticky-pull-request-comment)
