# Privacy & Data Handling

`pixelcheck` runs **on your machine** and acts on behalf of you, the
operator. This document explains what data the tool processes, where it
goes, and how to control it.

This is the v1.0 commitment; v2.0+ will follow the same disclosure unless
explicitly noted in [MIGRATION.md](MIGRATION.md).

---

## Table of contents

- [Summary](#summary)
- [What data the tool sees](#what-data-the-tool-sees)
- [Where data is stored](#where-data-is-stored)
- [What data leaves your machine](#what-data-leaves-your-machine)
- [Data minimization controls](#data-minimization-controls)
- [Retention + deletion](#retention--deletion)
- [Telemetry](#telemetry)
- [GDPR / CCPA position](#gdpr--ccpa-position)
- [User consent](#user-consent)
- [Reporting privacy concerns](#reporting-privacy-concerns)

---

## Summary

| Question | Answer |
|---|---|
| Does it call home / phone home? | **No.** Zero telemetry. |
| Does it log user data without consent? | **No.** First-run prompt explicitly informs the user data leaves the machine via Anthropic API. |
| Where is data stored? | **Locally**, in the project's `reports/` directory + `~/.pixelcheck/` cache (legacy `~/.ai-browser-auditor/` still resolved via `AUDIT_HOME` alias). |
| What leaves your machine? | Page screenshots + DOM + LLM prompts → Claude API only. URLs / metadata never logged anywhere else. |
| Default behaviour for sensitive inputs? | **Password / secret / API-key inputs are redacted before screenshots** (`--redact-inputs` enabled by default). |
| GDPR / CCPA scope | You (the operator) are the **data controller**. We ship the tool; we never receive your audit data. |

---

## What data the tool sees

When you run `pixelcheck run` (legacy alias `ai-audit run`) against a target site, the tool:

1. **Launches a headless Chromium** via Playwright on your machine.
2. **Navigates to the target URL(s)** as defined in your scenarios.
3. **Captures screenshots** (full page + 5 viewport segments per page) for vision-based analysis.
4. **Extracts DOM summaries** (tag tree + interactive elements) for LLM context.
5. **Sends screenshots + DOM + your prompts** to the Anthropic Claude API for evaluation.
6. **Receives + stores the LLM's response** locally as part of `audit.json` / `audit.html` / per-step artifacts.

The tool does **not**:

- Log URLs / DOM / screenshots to any third-party service other than Anthropic API
- Persist your `ANTHROPIC_API_KEY` or similar secrets to disk (the auditor's
  built-in [secrets redaction](docs/decisions/ADR-006-secrets-redaction.md)
  scrubs them from log output)
- Send anonymous telemetry pings on startup, error, or shutdown

---

## Where data is stored

Three locations, all on your local filesystem:

| Path | What's there | Permissions | Retention default |
|---|---|---|---|
| `<projectDir>/reports/<runId>/` | Per-run artifacts: audit.json, audit.html, audit.pdf, audit.sarif, screenshots, console.log | `0700` (T22 — owner-only) | Forever (manual delete) |
| `~/.pixelcheck/result-cache.db` | Memoised LLM results to avoid re-burning vision tokens (M9-4) | `0700` | TTL 24h, auto-pruned |
| `~/.pixelcheck/cost-ledger.json` | Daily cost counter for budget enforcement (M5-6) | `0700` | TTL 30d, auto-pruned |
| `~/.pixelcheck/plan-cache.db` | Cached autonomous plans by site host + DOM hash | `0700` | TTL 7d, auto-pruned |
| `~/.pixelcheck/memory.db` | Per-site facts learned across runs | `0700` | TTL 30d, auto-pruned |
| `~/.pixelcheck/consent.json` | Records that you acknowledged the first-run consent prompt | `0700` | Forever (delete to re-prompt) |

`<projectDir>` defaults to your shell `cwd` when you ran `pixelcheck run`
(or the legacy alias `ai-audit run`). You can override the report
destination with `--out <dir>`.

The `~/.pixelcheck/` cache root is overridable via `PIXELCHECK_HOME=/some/path`
(legacy alias `AUDIT_HOME` still honoured for users upgrading from v0.x;
slated for removal in v2.0 per [DEPRECATION-POLICY.md](docs/DEPRECATION-POLICY.md)).

---

## What data leaves your machine

**Only one outbound network destination**: `api.anthropic.com`.

Data sent to Claude API per audit step:

- Page screenshots (full-page + viewport segments) — base64-encoded in the request body
- DOM summary text (tag tree + visible text + interactive element hints)
- Your scenario step text (prompts you wrote)
- Persona profile fields you defined (locale, age band, etc — no PII unless you put it there)
- Model name + max_tokens

Data **NOT** sent to Anthropic:

- Your `ANTHROPIC_API_KEY` (used to authenticate; not echoed in payloads)
- Filesystem paths
- Other env vars on your shell
- History of past audits (each call is independent)

Anthropic's processing of this data is governed by their published policy:

- **Anthropic Privacy Policy**: https://www.anthropic.com/privacy
- **Anthropic Usage Policies**: https://www.anthropic.com/legal/usage-policies
- **API data usage**: Anthropic states API inputs are **not used for training** by default for customers on paid tiers. Confirm your specific tier's terms in the [Anthropic Trust Center](https://trust.anthropic.com/).

---

## Data minimization controls

### Password / secret input redaction (default ON)

Before each screenshot, the auditor automatically replaces the contents
of `<input type="password">`, fields with `autocomplete="current-password"
| "new-password"`, and fields whose `name`/`id` matches `/password|secret|
token|api[_-]?key/i` with `********`. This means the screenshot sent to
Claude shows masked dots, not the user's actual credentials.

To disable (e.g., a test fixture page where redaction would interfere
with the audit):

```bash
ai-audit run --no-redact-inputs
```

### Restricting which URLs to audit

Don't run `ai-audit` against pages that contain user PII, financial
records, medical data, or any data outside your audit scope. The tool
will faithfully send what it sees to Claude API; it can't know which
elements you consider sensitive.

For internal pages with sensitive content, consider:

- Running against a **staging environment** stripped of real user data
- Using **synthetic test accounts** (no real PII)
- Adding `exclude:` selectors to your `assert_a11y` step to skip
  sensitive components

### Skipping screenshots entirely

```bash
ai-audit run --no-screenshots
```

Disables visual capture entirely. Vision-based primitives (`see` /
`judge` / `compare`) will fail without screenshots, so this is suitable
only for pure DOM / a11y audits.

### Scoping the artifact dir

```bash
ai-audit run --out /tmp/short-lived-audit
```

Stores all per-run artifacts under `--out`. Combined with `tmpfs` (Linux)
or RAM-backed filesystems, you can ensure artifacts never touch persistent
storage.

---

## Retention + deletion

### Per-run artifact retention

`<projectDir>/reports/<runId>/` is **never auto-deleted**. You decide.
Manual cleanup:

```bash
# Delete a single run
rm -rf reports/<runId>

# Delete all runs older than 30 days
find reports/ -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;
```

### Cache retention (auto-pruned)

| Cache | TTL | Override |
|---|---|---|
| Result cache (LLM memoization) | 24 hours | `AUDIT_RESULT_CACHE_TTL_MS` |
| Cost ledger | 30 days (rolling) | hard-coded; rolls over on read |
| Plan cache | 7 days per entry | `AUDIT_PLAN_CACHE_TTL_DAYS` |
| Memory (per-site facts) | 30 days | `AUDIT_MEMORY_TTL_DAYS` |

To wipe ALL local cache state:

```bash
rm -rf ~/.pixelcheck/
# (also wipe the legacy backward-compat path if you upgraded from v0.x)
rm -rf ~/.ai-browser-auditor/
```

The next run will rebuild from scratch (slower for the first audit;
subsequent runs catch up).

### Right to be forgotten (GDPR Article 17)

If you audited a page that included data subject to a deletion request:

1. Delete the per-run report directory: `rm -rf reports/<runId>`
2. Wipe the result cache: `rm ~/.pixelcheck/result-cache.db`
3. Wipe the memory db (if the page contributed facts): `rm ~/.pixelcheck/memory.db`
4. (Optional) Forward the deletion request to Anthropic per their published
   process: https://www.anthropic.com/privacy#user-rights

The tool itself never retains the data once deleted from these locations.

---

## Telemetry

**Zero telemetry.** v1.0 sends NO anonymous usage / crash / performance
pings to any server other than Anthropic API for the audit calls you
explicitly trigger.

If telemetry is added in v1.x or v2.0+ it will:

- Be **opt-in by default** (off until user explicitly enables)
- Document exactly what fields are sent (no URLs / no audit content)
- Provide both env-var (`AI_BROWSER_AUDITOR_TELEMETRY=off`) and CLI flag opt-out
- Be announced in [MIGRATION.md](MIGRATION.md) under the release that adds it

---

## GDPR / CCPA position

You (the operator running `ai-audit`) are the **data controller** under
GDPR / CCPA / similar regimes. The auditor is a tool you run locally; we
(the project maintainers) are not in your data path.

Specifically:

- **We** (the maintainers, `xcodethink`) **never see your audit data**. The
  tool runs entirely on your infrastructure. We have no logging, telemetry,
  or remote-config mechanism.
- **Anthropic** is your **subprocessor** when you call the Claude API.
  Their published terms govern that processing; they document their
  GDPR / CCPA stance at the links above.
- **You** are the controller for any data sent to / received from Anthropic
  on your behalf via this tool.

If your jurisdiction or company policy requires:

- A signed Data Processing Agreement (DPA) with the controller — that's
  between you and Anthropic, not the tool maintainers.
- Sub-processor disclosure — Anthropic, Inc. (model inference); cdn.playwright.dev
  (Chromium binary download at install time, no per-run calls).
- Records of processing activities — the audit's `audit.json` includes
  timestamps + URLs + cost; you can use this as your processing log.

---

## User consent

Per industry best practice for tools that send page content to third-party
LLMs, the auditor prompts for explicit consent on first audit run:

```
This will send screenshots + DOM of <https://example.com> to Anthropic
Claude API for evaluation. See PRIVACY.md for what data leaves your
machine. Continue? [y/N]:
```

Acknowledging once writes a marker to `~/.pixelcheck/consent.json`
(version + timestamp + agreed; legacy `~/.ai-browser-auditor/consent.json`
also recognised for users upgrading from v0.x). Subsequent runs do not
re-prompt unless the consent version changes (a major privacy policy
update bumps it).

For non-interactive contexts (CI / MCP server / scripted), bypass the
prompt with:

```bash
AUDIT_AUTO_CONSENT=1 ai-audit run        # env var
ai-audit run --auto-consent              # CLI flag
```

`AUDIT_AUTO_CONSENT=1` writes the same consent marker so subsequent
interactive runs also don't re-prompt. **Do NOT use auto-consent in CI
without first reading this document and ensuring your organization
policy permits it.**

To revoke + re-consent:

```bash
rm ~/.pixelcheck/consent.json ~/.ai-browser-auditor/consent.json 2>/dev/null
```

---

## Reporting privacy concerns

For privacy-sensitive issues (e.g., found a leak, want to discuss DPA):

- See [SECURITY.md](SECURITY.md) — the same private-disclosure channel
  (GitHub Security Advisories) handles privacy reports.
- For Anthropic API usage / data deletion requests at Anthropic's side:
  https://www.anthropic.com/privacy

---

**Last updated**: 2026-05-02 (T22 — Wave 3 PRIVACY + consent + PII redaction)
