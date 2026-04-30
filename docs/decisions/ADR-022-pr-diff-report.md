# ADR-022 — PR diff report renderers (M2-5)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M2-5 — Audit diff 报告
- **Builds on**: ADR-019 (CI-friendly output formats — same "alternate serialisation, same source data" pattern), ADR-021 (trends dashboard — same "history.db is the source, render at the consumer's needs" architecture)

## Context

By the end of M2-3, every individual `audit run` is well-served:

- Engineers see GitHub PR inline annotations on their changed files (M2-6)
- Stakeholders get an emailable PDF (M2-1)
- Anyone in the organisation can open the trends dashboard (M2-3)

But **PR review** has a different question that none of the above answers cleanly: *"did **this PR specifically** make UX better or worse vs `main`?"*

The auditor's `diffRuns()` core API has always answered that question structurally — given two run IDs, return the score delta, the new issues, the resolved issues, the dimension deltas. The CLI even has a `diff` subcommand that prints those deltas in colored terminal text. But the only consumer of that output today is "an engineer SSH'd into the CI runner". Reviewers in a typical PR-review flow don't see it; CI integrators have to hand-write a script that captures the text and pastes it into a PR comment.

That last-mile gap is exactly where M2-5 lives: **render the diff in formats the PR-review surface natively consumes.**

The standard GitHub Actions workflow for "post a comment on the PR" expects Markdown — usually via `marocchino/sticky-pull-request-comment` or `gh pr comment --body-file`. GitLab MRs and Bitbucket PRs both render GFM tables. That's the primary format. A standalone HTML version covers email / Slack / archival; JSON covers downstream tooling.

## Decision

Add `src/core/reporter-diff.ts` with four pure renderers + one disk-write helper, plus extend the existing `ai-audit diff` CLI with `--format` and `--output` flags.

### Renderers

| Format | Primary use case | Output shape |
|---|---|---|
| `markdown` | Direct paste as a PR comment via GitHub Actions | GitHub-Flavored Markdown — tables, ▲/▼ arrows, ✅/⚠️ polarity emoji, severity tags as `**[critical]** description` |
| `html` | Email / Slack / archival as a standalone file | A4-friendly light theme matching reporter-pdf + reporter-trends; severity-coloured issue cards; cross-project warning banner |
| `json` | Downstream tooling that wants to chart / aggregate | `{ kind: "audit_diff", rendered_at, diff }` envelope with the structured `RunDiff` preserved verbatim |
| `text` | File redirection / log aggregators (no ANSI codes) | The legacy CLI shape stripped of `chalk` colour |

The CLI's interactive `--format text` path keeps using `chalk` directly so users running `ai-audit diff` at a terminal still see the coloured legacy output. `renderDiffText()` is the public-API ANSI-free version for embedders piping the result through to a file or a log.

### Delta arrow polarity

Polarity is **value-aware**, not direction-aware:

| Metric | Up = | Visual |
|---|---|---|
| Overall score / per-dimension score | good | ▲ green / ✅ |
| Issues / critical issues | bad | ▲ red / ⚠️ |
| Cost | bad | ▲ red / ⚠️ |
| Duration | bad | ▲ red / ⚠️ |
| Zero delta | flat | "—" muted |

Markdown encodes polarity via emoji shorthand (`✅` / `⚠️`) since GFM doesn't honour inline `<span style>`; HTML uses `<span class="delta up|down|flat">` with stylesheet-driven colours.

### CLI

```
ai-audit diff <runA> <runB> [-o reports] [-f text|markdown|html|json] [--output path] [--max-issues N]
```

- No `--format` and no `--output`: prints the legacy chalk-coloured terminal output (backwards-compatible).
- `--format markdown` to stdout: emits Markdown for piping (`ai-audit diff a b --format markdown >> diff.md`).
- `--output path`: writes to a file. If `--format` is omitted, format is inferred from the extension (`.md` / `.html` / `.json` / fallback text).
- `--max-issues N`: cap on the new/resolved issue lists (default 10).

### Public API

```ts
renderDiffMarkdown(diff, opts?) → string  // pure, GFM
renderDiffHtml(diff, opts?) → string      // pure, standalone HTML
renderDiffJson(diff) → string             // pure, { kind, rendered_at, diff }
renderDiffText(diff) → string             // pure, ANSI-free
writeDiffReport(diff, outPath, format?, opts?) → string  // disk
type DiffReportFormat = "markdown" | "html" | "json" | "text"
type DiffReportOptions = { maxIssues?, includeFooter? }
```

## Alternatives rejected

1. **Bake all four formats into `ai-audit diff` and emit them simultaneously to `runDir`** — Rejected. `diff` is *across* runs, not per-run; there's no "this run's directory" to write to. And the typical CI usage is `--format markdown > diff.md && gh pr comment --body-file diff.md`, where a single explicit output is exactly what the user wants. Forcing 4 files when 1 is needed pollutes the repo.
2. **Use a templating engine (Handlebars / EJS / etc) for the renderers** — Rejected. Each renderer is ~80 LoC of straightforward string concat with one helper (`arrowMd` / `arrowHtml`). A templating engine adds a dependency, a precompile step, and an escape-handling foot-gun for one of the most security-sensitive surfaces in the project (PR comments are user-content-adjacent). Inline string composition with explicit `escapeHtml()` is auditable.
3. **Use HTML inside Markdown for richer formatting** — GFM permits inline HTML, and we could embed `<span style="color: green">` for delta colours. Rejected: GitHub strips `style` attributes server-side, and other GFM consumers (Bitbucket, GitLab MRs, plain Markdown viewers in IDEs) render the raw HTML. Emoji-based polarity (✅ / ⚠️) renders identically across all of them.
4. **Drop the `text` format — only ship Markdown / HTML / JSON** — Rejected. The existing `ai-audit diff` (no flags) produces colored terminal text; users would be surprised if the same command suddenly emits Markdown by default. Backwards-compatibility wins. Plus `text` is useful for CI logs that don't render Markdown (Jenkins console, Slack pre-formatted blocks).
5. **Auto-post the PR comment from the CLI itself (`gh pr comment` integration)** — Rejected for v1. Coupling the auditor to a specific git-host CLI is dependency creep; users have wildly different "how do I post to a PR" pipelines (GitHub Actions vs GitLab CI vs Bitbucket Pipelines vs custom). Outputting the Markdown to stdout/file and letting the user's own pipeline post is more general. May add `ai-audit diff --post-pr <pr-url>` later if a clear pattern emerges.
6. **Embed screenshots in the HTML diff** — Rejected (consistent with ADR-020 §"no screenshots in PDF"). The diff is meant to be small enough to live in a PR comment or a stakeholder email. Screenshots ballooned the prototype to multi-megabyte files. For visual evidence the user opens the per-run `audit-explorer.html` (linked from the diff's run IDs).
7. **Use a different polarity convention (e.g. always "up = up", colour-blind)** — Tempting (colour-blindness affects ~8% of male users), but rejected because issues-up = ▲-but-bad is the clearest signal in any colour scheme — the arrow's direction encodes the metric's direction, the polarity emoji (✅/⚠️) encodes whether that direction is good or bad. Colour is *additional* signal, not the only one.
8. **Render Markdown via an existing diff-Markdown library** — Surveyed: no popular library does "audit-style" diff rendering; the closest are git-diff Markdown (wrong domain) and changelog generators (wrong shape). Rolling our own is ~80 LoC and exactly fit-to-purpose.

## Consequences

- PR reviewers get the diff in the format they actually consume. CI integrators paste 5 lines of YAML to enable: `ai-audit diff <main> <pr> --format markdown --output diff.md` then `marocchino/sticky-pull-request-comment` with `path: diff.md`.
- The auditor's full PR-review surface is now: trigger run on PR commit (M2-6 GitHub Actions setup) → score-gate exit code (existing `--min-score`) → inline annotations for new issues (M2-6) → diff comment summarising the change vs `main` (M2-5).
- Public API surface grows 50 → 55: 4 renderers + 1 writer + 2 types.
- 1269 → 1319 tests pass (+50). Coverage on the new file: 98.08% statements / 94.16% branches / 100% functions.
- The legacy `ai-audit diff` (no flags) is unchanged. Users with existing scripts that parse the text output don't see any drift.

## Files added / changed

- `src/core/reporter-diff.ts` — new (~310 LoC)
- `tests/reporter-diff.test.ts` — new (50 tests)
- `src/cli.ts` — `--format`, `--output`, `--max-issues` flags on the existing `diff` subcommand
- `src/index.ts` — 5 new public exports + 2 types
- `tests/public-api-samples.test.ts` — snapshot 50 → 55
