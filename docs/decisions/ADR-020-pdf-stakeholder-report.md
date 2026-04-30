# ADR-020 — Stakeholder-facing PDF report (M2-1)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M2-1 — PDF 报告生成器
- **Builds on**: ADR-019 (CI-friendly output formats — same "alternate serialisation, same source AuditRun" pattern)

## Context

By the end of M2-6, the auditor emits JSON / HTML / SPA / Markdown / 4 CI formats. Every one of those targets either an engineer or a machine. The decision-maker layer above engineering — PMs, executives, customers, sales / CS reps preparing client-facing material — has no native artefact:

- HTML reports require opening a browser tab; nobody attaches HTML to a stakeholder email
- Markdown is illegible without a renderer
- JSON is incomprehensible to anyone non-technical
- The CI formats are inside CI dashboards no PM has access to

Real-world consequence: a PM who wants to brief leadership on "how does our Japanese-market signup compare to last quarter" has to open the HTML, screenshot it, paste into a slide, manually annotate. This is the friction point where the auditor's findings stop short of the people who can act on them.

PDF is the universal fallback for this audience: emailable as attachment, paste-able into slides, readable on phone, archivable, printable. Every commercial product that produces user-facing reports (Stripe, Snowflake, every BI tool) ships PDF as the stakeholder format because no other format crosses the technical/non-technical divide.

## Decision

Add `src/core/reporter-pdf.ts` with a 4-section A4 portrait PDF rendered through Playwright's chromium PDF export, defaulting to ON during `ai-audit run` with a `--no-pdf` opt-out for fast local iteration.

### Section layout

1. **Cover** (page 1) — project name, base URL, run date, duration; centred big colour-coded score (0–10); 7-counter summary card (total / pass / pass_with_issues / fail / critical / total issues / cost).
2. **Top findings** (page 2) — severity-sorted, capped at 5 by default. Each finding cites the originating scenario × persona, the issue description, and the recommendation. "No issues" path emits an explicit clean-run paragraph.
3. **Per-scenario results** (pages 3+) — one block per (scenario × persona) audit unit. Status badge, score + cost, per-dimension table, all issues.
4. **Methodology** (last page) — prose paragraph on how the audit works, sorted unique persona list, sorted unique scenario list, AI calibration disclaimer, run_id for archival.

Every page (chromium header/footer templates): project name + run date in the header; run_id + page X / Y in the footer.

### Implementation choices

- **A4 portrait, 12pt body, 1.5 cm margins**. A4 is the international default and prints fine on US Letter; 12pt is the legibility floor on a phone.
- **Helvetica fallback chain** (`-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`). Every PDF reader has these. No font embedding → smaller files → emailable.
- **Vector text via `chromium.page.pdf()`**. Selectable, searchable, accessible. Beats screenshot-of-HTML by every metric except ease of implementation, and that ease is paid for by the existing Playwright dep.
- **Colour-coded score** is hard-coded green ≥ 8 / amber 5–8 / red < 5 regardless of the brand colour option. A health signal must be a universal traffic-light convention; brand-tinting it would defeat the purpose.
- **No screenshots in PDF** — see "Alternatives rejected" §5.
- **Page-break controls everywhere** — `page-break-after: always` between sections, `page-break-inside: avoid` on findings + scenario blocks. Never get a "summary card split across pages" failure mode.
- **Redaction goes through `redactDeep`** (M1-4 secrets layer) so the PDF can't leak anything the JSON report already redacts. Tests verify with planted secrets.

### Public API

```ts
renderPdfHtml(audit, opts?) → string         // pure
writePdfReport(audit, runDir, opts?) → string // async, writes audit.pdf
PdfReportOptions {
  brandColor?, logoDataUri?, maxTopFindings?,
  launchBrowser?  // injection seam — reuse audit's chromium
}
```

`launchBrowser` is the one non-obvious option: when an embedder is already running chromium (an MCP server, a long-lived daemon), they pass their existing instance and avoid the ~2s cold-start per render.

### CLI

`ai-audit run --no-pdf` — opt-out only; default is ON. Aligns with the rest of the CLI's `--no-baseline`, `--no-preflight` convention. Render failures are non-fatal: they downgrade to a yellow warning so the audit exit code is unchanged. The PDF is the last artefact written, after JSON / HTML / SPA / Markdown, so PDF failure never loses audit data.

## Alternatives rejected

1. **Use `pdfkit` or `@react-pdf/renderer`** — both work by drawing PDF primitives in code (lines, text runs, page breaks). That puts every layout decision in TypeScript, which is great for fully-procedural reports but terrible for "I want this to look like a print-ready document". CSS print styling is what print-design has used for 25 years; we already have the renderer.
2. **Use `wkhtmltopdf` or `weasyprint`** — both are out-of-process binaries with platform-specific install paths and known CSS-3 gaps. The auditor already ships chromium; reusing it has zero install footprint cost and matches the rendering of the screen HTML report exactly.
3. **Default OFF, opt-in via `--pdf`** — rejected because PDF is the *stakeholder* artefact; the people who need it (PMs, CEOs) do not run `ai-audit` directly, so they never see CLI flags. Defaulting ON means a CI run automatically produces the PDF that gets emailed to the PM. The `--no-pdf` opt-out covers the local-iteration pain point.
4. **US Letter instead of A4** — Letter prints awkwardly outside North America (top/bottom margins clip). A4 prints fine on Letter (slightly more whitespace). A4 is the safer default for a tool that audits sites in multiple countries.
5. **Embed screenshots in the PDF** — rejected. A 20-unit audit with screenshots ballooned to 50 MB+ in early prototyping; many corporate email systems reject anything over 25 MB; PDFs over 10 MB are noticeably slow on phones. The PDF is the "summary"; visual evidence lives in `audit-explorer.html`, which the methodology section cites by name. If users push back, we add `--pdf-screenshots` opt-in later.
6. **One-page A4 summary instead of multi-page** — tempting (everyone says they want a one-pager), but a 20-unit audit can't compress its top findings + scenario detail + methodology into one page without making the type 6pt and unreadable on phone. Phones zoom into multi-page PDFs naturally; one-page-cramped PDFs are unusable.
7. **PDF/A archival format** — rejected for v1. PDF/A requires embedded fonts (file-size cost) and ICC colour profiles. Audit reports are operational documents, not legal records. Add later if a customer asks for compliance-grade archival.
8. **Third-party PDF templating library (e.g. `puppeteer-report`)** — rejected: dependency cost, lifecycle risk (these libs go unmaintained), and the templating language is always weaker than HTML/CSS. We have HTML/CSS and we have chromium; one direct call to `page.pdf()` is the smallest correct solution.

## Consequences

- The audit now emits a stakeholder artefact every run. PMs / executives / customers / sales can be served the same data engineers see, in a format they actually open.
- `runDir/audit.pdf` joins the existing JSON / HTML / SPA / MD / 4 CI formats — total 9 artefacts in CI, 5 on developer laptop (CI formats default off locally; PDF default on; matches the priority of who consumes them).
- Adding bespoke branding (logo + brand colour) is a 2-property `PdfReportOptions` change — no template-engine surface.
- 1186 → 1225 tests pass. Coverage on the new file: 92.39% statements / 87.17% branches.
- Chromium cold-start adds ~2 s per audit run. Negligible against a 30 s+ audit; for users with thousands of fast runs the `--no-pdf` flag cuts it.

## Files added / changed

- `src/core/reporter-pdf.ts` — new (~360 LoC)
- `tests/reporter-pdf.test.ts` — new (39 tests)
- `src/cli.ts` — `--no-pdf` flag wiring + run-summary `PDF:` row
- `src/index.ts` — 2 new public exports (writePdfReport / renderPdfHtml) + PdfReportOptions type
- `tests/public-api-samples.test.ts` — snapshot 45 → 47
