# ADR-021 — Long-running trends dashboard (M2-3)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M2-3 — 历史趋势 chart + dashboard
- **Builds on**: ADR-020 (PDF stakeholder report — same "alternate consumption surface for the same audit data" pattern)

## Context

By M2-1 the auditor's per-run output is solved: engineers consume `audit.json` / `audit.html` / 4 CI formats, stakeholders consume `audit.pdf`. What's still missing is the *across-runs* answer:

- "Did our Japanese-market signup score get better or worse over the last quarter?"
- "We deployed a redesign on April 15 — did the audit catch a regression?"
- "Cost per run has been creeping up; is that a model issue or scenario sprawl?"
- "Localisation has been improving but visual polish is silently dropping — is anyone watching?"

The data to answer all of these has been sitting in `<reportsDir>/history.db` since v0.3 (M9-2 schema versioning made it queryable across runs). The only consumer of it today is the CLI `history` subcommand, which prints a plain-text 1-line-per-run table — useful for engineers checking the last 5 runs, useless for any "is the trend up or down" question that needs visualisation.

Without a trend dashboard, the auditor's value is "did this PR pass or fail" — fine for CI gates but not the long-term quality monitoring story the stakeholders bought into. PMs ask "are we trending up", get a 30-row text dump, can't answer, and stop opening it.

## Decision

Add `src/core/reporter-trends.ts` exposing `writeTrendsDashboard()` and a CLI `ai-audit trends` subcommand that reads `history.db` and renders a single self-contained HTML file with five inline-SVG charts plus six summary cards plus a recent-runs table.

### What's in the dashboard

| Section | Charts / cards | Question it answers |
|---|---|---|
| Header | Project label, run count, time window | "What am I looking at?" |
| Summary cards (×6) | Latest score, mean last 7, mean last 30, total cost, total issues, total critical issues | "What's the headline number to put in a meeting?" |
| Chart 1 | Overall score line | "Up or down?" |
| Chart 2 | Pass / Warn / Fail stacked bars | "Consistent or flaky?" |
| Chart 3 | Issues over time, total + critical highlighted | "Where are the regression hot spots?" |
| Chart 4 | Cost over time | "Is efficiency drifting?" |
| Chart 5 | Per-dimension multi-line | "Which dimension is the cause of overall movement?" |
| Recent-runs table | Last 25 rows | "Take me to the run that explains chart 3's spike on April 15" |

### CLI

```
ai-audit trends [-o reports] [--dashboard path] [-n limit] [--project name]
```

Output: by default `<reports>/trends.html`. `--dashboard` overrides the path. `--project` filters to a single project; `--limit` caps history rows for chart density (default 100, ~3 months of daily runs).

### Public API

```ts
writeTrendsDashboard(reportsDir, opts?) → string  // returns absolute outPath
renderTrendsHtml(entries, project?) → string     // pure
computeSummary(orderedAsc) → TrendsSummary       // pure aggregation
TrendsDashboardOptions { project?, limit?, outPath? }
TrendsSummary { totalRuns, latestScore, meanLast7, meanLast30, ... }
```

Plus exposed primitives (`lineChartSvg` / `stackedBarsSvg` / `multiLineChartSvg` / `deriveTicks` / `collectDimensions` / `escapeHtml`) for embedders that want to drop a single chart into their own dashboard.

### Implementation

- **Inline SVG, no charting library** (~10 KB total across 5 charts).
- **Light theme** matching reporter-pdf — trends.html gets forwarded to non-technical readers.
- **UTC date formatting** — never local time.
- **Score colour mapping** (green ≥ 8 / amber 5–8 / red < 5) — matches reporter-pdf, never overridable. Health signals must be a universal traffic-light convention.
- **Empty-state placeholder** when `history.db` is missing or the project filter excludes everything — explicit "run `ai-audit run` to seed" guidance instead of a confusing broken page.
- **Page is fully self-contained** — no external CSS, JS, fonts. Email-able, archivable, printable, opens behind a corporate firewall.

## Alternatives rejected

1. **Use Chart.js / Recharts / D3 for richer interactivity** — Rejected. ~70 KB bundle + a CDN request behind every corporate firewall break the "email this PDF/HTML" use case. Inline SVG renders identically on disk / web / forwarded email. The interactivity gap (no hover tooltips on lines) is acceptable: the question this dashboard answers is "trending up or down", which a clean line chart shows at a glance. Power users can read the table beneath the charts for exact numbers.
2. **Dark theme matching `audit.html`** — Rejected. trends.html gets forwarded to PMs / customers / sales who paste into corporate slide decks where dark backgrounds clash with the surrounding template. Light theme also matches `audit.pdf` for visual consistency across the stakeholder artefact set.
3. **Embed the dashboard inside `audit.html` (per-run report)** — Rejected. trends.html is *across* runs; embedding it in a per-run page would force regenerating every historical report when a new run lands, and the per-run dashboard would only be accurate at the moment of writing. Standalone-and-rebuildable wins.
4. **Auto-generate trends.html on every audit run** — Tempting but rejected for v1: most users won't run `ai-audit trends` between every commit, and writing it automatically would slow each audit by ~50ms (read history.db + render SVGs). `ai-audit trends` as an explicit command keeps `ai-audit run` fast and predictable. May reconsider as `--auto-trends` flag if real users ask.
5. **Write to a date-stamped path (e.g. `trends-2026-05.html`)** — Rejected. Stakeholders want *the* trends dashboard, not 30 of them. Overwriting `<reports>/trends.html` with the freshest data is the right default; users who want archival can copy.
6. **Per-scenario or per-persona trend lines as additional charts** — Deferred to M2-3.1. Per-(scenario × persona) trends produce N×M lines on a single chart and quickly become unreadable. The "Per-dimension scores" chart already shows the most useful slice (one line per scoring dimension). When real users ask "show me Japanese-market scores over time", we add a `--persona <name>` filter that re-renders all charts scoped to that persona.
7. **Render charts in PNG instead of SVG** — Rejected. SVG is vector (looks crisp at any zoom in print or HiDPI), text-searchable (a recipient can ⌘-F for "April 15"), accessible (screen readers can read tick labels), and 5–10× smaller in bytes for our chart shapes. PNG would need to be rasterised through chromium (defeating the "no Playwright" simplicity) or via an external image library (new dep).
8. **Exporting CSV / Excel for the data behind the dashboard** — Deferred to M2-5 (Audit diff). The use case for a CSV dump is "I want to do my own analysis", which overlaps with the diff report's data export needs more than the dashboard's "single forwarded HTML" use case. Add `ai-audit trends --csv <path>` later if real users ask.

## Consequences

- The "did we get better over time" question now has an answer that fits in an emailed HTML attachment or a slide-deck screenshot.
- `ai-audit trends` is the third top-level CLI subcommand alongside `run` and `history`; users learn one new verb, no extra config files.
- Public API surface grows 47 → 50: `writeTrendsDashboard`, `renderTrendsHtml`, `computeSummary` (plus 2 types).
- 1225 → 1269 tests pass (+44). Coverage on the new file: 98.54% statements / 90.83% branches / 100% functions.
- `<reports>/trends.html` joins the per-run artefacts but lives at the project level (one trends file per project, not per run). Keeps the run dirs self-contained while the trends file is the project-level rollup.

## Files added / changed

- `src/core/reporter-trends.ts` — new (~430 LoC)
- `tests/reporter-trends.test.ts` — new (44 tests)
- `src/cli.ts` — `ai-audit trends` subcommand
- `src/index.ts` — 3 new public exports + 2 types
- `tests/public-api-samples.test.ts` — snapshot 47 → 50
