# ADR-023 — Report localisation (M2-4)

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: M2-4 — 报告 i18n 5 主流语言
- **Builds on**: ADR-019 / ADR-020 / ADR-021 / ADR-022 (the four reporters this consolidates around)

## Context

By the end of M2-5 the auditor produces stakeholder-facing artefacts in 4 formats — PDF (M2-1), trends dashboard (M2-3), diff report (M2-5), CI envelopes (M2-6). All are English-only. The project's biggest commercial markets are non-English:

- Chinese SaaS teams (auditing zh-CN sites)
- Japanese product orgs (auditing ja-JP sites)
- DACH-region enterprises (German is the BI / reporting default)
- Spanish-speaking LatAm + Spain (Spanish-language stakeholders)

Asking a Japanese PM to read an English audit report defeats the "show me what my users see" value proposition. M2-4 closes this gap before any remaining reporter work — adding i18n later means re-touching every translated reporter twice.

## Decision

Add a single central translation module `src/core/i18n.ts` that all four stakeholder reporters consume, plus a `--locale <code>` CLI flag and a `default_locale` field in `ProjectConfig`. Five locales for v1: **en / zh-CN / ja / es / de**.

### Translation scope

What's translated: the *static skeleton* of every report — section headings, table headers, card labels, status / severity badges, disclaimer prose, empty-state messages, button-equivalent strings. ~90 keys × 5 locales = 450 translation entries.

What's NOT translated: the auditor's own findings (LLM-generated issue descriptions and recommendations come from Claude in whatever language the user asked for); numeric values, dates, run IDs, scenario / persona IDs (data, not UI).

### Architecture

- **Single dictionary file** `src/core/i18n.ts` with `TRANSLATIONS = { en, "zh-CN", ja, es, de }`. New locale = one new dictionary + one `SUPPORTED_LOCALES` entry.
- **`t(key, locale)`** function — typed: `TranslationKey` union ensures every callsite uses a valid key, every locale must have every key.
- **`lintTranslations(locale)`** — returns missing keys; the i18n unit test asserts this is `[]` for every locale, so a regression where a key is added only to en silently falls back is caught at CI time.
- **`normaliseLocale(raw)`** — robust input: case-insensitive, family-fallback (`zh-Hans` → `zh-CN`, `ja-JP` → `ja`, `en-GB` → `en`), unknown → `en`.
- **`formatRunsCount(n, locale)`** — locale-aware singular/plural ("1 run" vs "3 runs", "1 ejecución" vs "3 ejecuciones", "1 Lauf" vs "3 Läufe", Chinese/Japanese no plural form).

### CLI

- `--locale <code>` global flag on `run` / `trends` / `diff` subcommands.
- `ai-audit run` reads `default_locale` from `config.yaml` if `--locale` is unset.
- `ai-audit trends --locale ja` writes `trends.html` in Japanese.
- `ai-audit diff a b --format markdown --locale zh-CN > diff.md` posts a Chinese PR comment.

### Public API

```ts
type Locale = "en" | "zh-CN" | "ja" | "es" | "de"
SUPPORTED_LOCALES: readonly Locale[]
DEFAULT_LOCALE: "en"
t(key, locale?) → string
normaliseLocale(raw) → Locale
formatRunsCount(n, locale?) → string
```

Plus `locale?: Locale` option on `PdfReportOptions`, `TrendsDashboardOptions`, `DiffReportOptions`.

## Alternatives rejected

1. **Per-reporter local translation tables** — would have spread translation maintenance across 4 files. Adding "Korean" later would mean editing 4 dictionaries with no compile-time check that they stay in sync. Single source of truth wins.
2. **A full i18n library (`i18next`, `lingui`, etc)** — these solve plural-form rules, ICU MessageFormat, lazy loading. We need 90 strings × 5 locales of static data. Adding a 200KB dep + build-time compilation step for that is over-engineering. The 30 LoC of `t()` + manual `formatRunsCount` for Spanish/German plurals is fit-to-purpose. Revisit when the dictionary crosses ~500 keys or we want runtime locale switching.
3. **Translate the LLM-generated findings too** — sounds nice, breaks down on inspection: the LLM is already configurable to respond in the user's language via the audit's vision-prompt template, so re-translating the output post-hoc would create a second-stage hallucination risk (mistranslating "footer overlap" as "footer collision" loses precision). Keep findings in the language the LLM was asked for; localise only the report skeleton.
4. **Auto-detect locale from `process.env.LANG`** — surprising at CI time (a Jenkins runner with `LANG=de_DE.UTF-8` would silently emit German reports for a US-team project). Explicit `--locale` / `default_locale` is predictable; auto-detect can be added as `--locale auto` later.
5. **More locales out of the gate (fr / ko / pt / it)** — each adds ~90 strings of translation review to the v1 commitment. The 5 chosen locales cover the highest-priority commercial markets without over-extending the v1 maintenance surface. Adding a 6th locale is a 90-string PR — easy to do in M2-4.1.
6. **Translate `audit.html` (the per-run dark-theme report) and `audit-explorer.html` (the SPA filter view)** — both are ~500 LoC of inline HTML/CSS/JS embedded in TypeScript template literals. i18n-ising them would touch 100+ string sites and meaningfully grow the translation table. Phase-2 scope; deferred to M2-4.1. The four stakeholder-facing reports (PDF, trends, diff, CI markdown) cover 95% of the localisation value.
7. **Right-to-left (RTL) language support (Arabic / Hebrew)** — would require CSS `dir="rtl"` plumbing through every report stylesheet plus testing. Out of scope for v1; revisit when the first commercial user asks.
8. **ICU MessageFormat for genders/cases** — German has gendered nouns (`der Lauf` vs `die Läufe`), Spanish has gendered articles. The current translations sidestep this by using neutral phrasings ("X ejecución(es)"). A real ICU integration would let us be more idiomatic — defer until a native speaker pushes back.

## Consequences

- 4 stakeholder reports (PDF / trends / diff Markdown / diff HTML) emit native-language content for the 5 priority markets.
- `ProjectConfig.default_locale` lets a project pin a default; CLI `--locale` overrides per-invocation.
- Translation drift is caught at CI: `lintTranslations(locale)` test asserts `[]` for every locale, `npm test` fails if a key is added only to en.
- Public API surface grows 55 → 60 exports (`t` / `normaliseLocale` / `formatRunsCount` + `SUPPORTED_LOCALES` / `DEFAULT_LOCALE` + `Locale` / `TranslationKey` types).
- 1356 → 1395 → 1432 tests pass after C1+C2+C3 (combined +76 tests across i18n + 3 reporter integrations + CLI).
- New v1 schema field: `ProjectConfig.default_locale` (additive, defaults to `"en"`, any existing config.yaml keeps working without touching it).

## Files added / changed

- `src/core/i18n.ts` (new — ~470 LoC, 90 keys × 5 locales)
- `tests/i18n.test.ts` (new — 37 tests)
- `src/core/reporter-pdf.ts` — locale option + 30+ `t()` callsites
- `src/core/reporter-trends.ts` — locale option + 25+ `t()` callsites + `formatRunsCount`
- `src/core/reporter-diff.ts` — locale option + 20+ `t()` callsites
- `src/core/types.ts` — `default_locale` enum field on `ProjectConfigSchema`
- `src/cli.ts` — `--locale` flag on `run` / `trends` / `diff`
- `src/index.ts` — 5 new public exports + 2 types
- `tests/reporter-pdf.test.ts` / `tests/reporter-trends.test.ts` / `tests/reporter-diff.test.ts` — 22 new i18n integration tests
- `tests/public-api-samples.test.ts` — snapshot 55 → 60
