# ADR-006 — Secrets redaction in logs and CLI output

- **Status**: Accepted
- **Date**: 2026-04-27
- **Task**: M1-4 (Secrets redaction)
- **Builds on**: ADR-005 (structured logging)

## Context

ADR-005 introduced a structured logger but added no protection against secret values leaking through log output. Concretely, three failure modes were possible:

1. A caller writes `log.info({ apiKey: process.env.ANTHROPIC_API_KEY })` — the field is recognizable but pino emits the raw value.
2. A caller writes `log.warn({ note: \`failed to call API with key ${env.ANTHROPIC_API_KEY}\` })` — the secret hides inside a string field with an innocent name.
3. A caller writes `log.error(\`fatal: bad token ${env.SLACK_WEBHOOK}\`)` — the secret hides inside the message itself, not in any payload.

Reports were already protected via `secrets.redactDeep()` (applied in `reporter.ts` / `reporter-spa.ts` before disk write). Logs and CLI error output were not.

The 7.1 engineering discipline list in the v3.0 plan explicitly requires "Secrets redaction (log + 输出 + report 不含 API key)".

## Decision

Two layers of redaction, both wired into `src/core/logger.ts`:

### Layer 1 — Path-based (well-known field names)

Use pino's built-in `redact: { paths: [...], censor: '[REDACTED]' }`. Covers obvious field names regardless of value:

```
apiKey | api_key | password | token | secret | cookie | cookies
authorization | auth | anthropic_api_key | ANTHROPIC_API_KEY
```

Both at top level (`apiKey`) and one level deep (`*.apiKey`). Backed by fast-redact, near-zero cost.

### Layer 2 — Value-based (registered secret strings)

A `registerSecret(value: string)` API stores concrete secret values in a module-level `Set<string>`. A `hooks.logMethod` interceptor runs on every log call:

- For string args (the message), substring-replace each registered secret with `[REDACTED]`.
- For object args (the payload), walk the structure recursively and substring-replace inside every string value.

Why a hook and not `formatters.log`: pino's formatter only sees the merging-object payload, not the message string. A leaked secret in the message itself (`log.error(\`fatal: ${secret}\`)`) requires intercepting at call time, before pino composes the line. `hooks.logMethod` is the only place that sees both arg shapes.

### Bootstrap (call sites that must register at startup)

Two entry points must call `registerSecret` after `dotenv.config()` and **before** any log emission:

- `src/cli.ts` — every CLI command path
- `src/mcp/server.ts` — every MCP tool invocation

Both call `buildRedactPatterns([])` from `src/core/secrets.ts` (the existing helper that enumerates env-derived secrets) and feed each pattern to `registerSecret`.

### Layer 3 — CLI safe-print helpers

`src/cli.ts` adds `safePrint` / `safeError` wrappers that run the same `secrets.redact()` call on string args before `console.{log,error}`. Used in the `catch` blocks that print `err.message` (where a leaked secret in an upstream library's exception message would otherwise reach stdout/stderr unredacted).

The CLI's other `console.log` calls — printing scoreboards, score deltas, repro hints — don't interpolate untrusted text and don't need wrapping.

## Constraints applied

- Values shorter than 8 characters are ignored by `registerSecret` to prevent common words from being blanket-redacted.
- The deep-walker has a hard recursion cap of 8 levels to bound worst-case cost on pathological payloads.
- The hook short-circuits when the registered-secret set is empty, so apps that haven't bootstrapped pay nothing.

## Alternatives considered

- **Pino's `redact.paths` alone** — leaves layers 2 and 3 entirely uncovered. The most common leak in practice (a secret stringified into an error message) goes through.
- **Reuse `secrets.redactDeep` directly inside `formatters.log`** — works for payloads but misses the message string. Tested; the test for "secret in message" failed until I switched to `hooks.logMethod`.
- **Mask before write at the destination level** (override pino's transport) — heavier, requires writing a custom transport, and breaks `pino-pretty` integration.
- **Force-redact at compile time via a lint rule** — can't catch dynamic interpolation; brittle.

## Consequences

**Positive**
- Three independent leak channels (named field, embedded value, message string) all blocked at one chokepoint.
- Existing `secrets.ts` helpers reused — no parallel implementations to keep in sync.
- Reports continue to use `redactDeep` as before; logger now uses the same secret list, so any new env var added to `buildRedactPatterns()` automatically protects both.

**Negative / trade-offs**
- Per-log-call hook overhead: when the registered-secret set is non-empty, every payload object is walked and every string scanned. Substring scan is O(n × s × k) where n = payload size, s = number of secrets, k = avg secret length. For typical audit logs (n ≈ 10 fields, s ≈ 5 secrets, k ≈ 50) that's ~2,500 char comparisons per line — cheap.
- The hook runs even on `LOG_LEVEL=silent` if any handler call is made (pino's level filter happens after the hook). Negligible at our volume.
- CLI's `safePrint` rebuilds the patterns array on every call (cheap; `buildRedactPatterns` is < 1ms). Could be cached but not worth the complexity.

## Follow-ups

- **M5-2 Local debug log**: file-based log will inherit redaction automatically (same logger).
- **M9-3 Concurrency safety**: child loggers inherit the redact config, no extra work needed.
- **M3-6 MCP server refactor**: any new tool surface must call `safePrint`-equivalent for user-facing string returns if those strings could include unredacted upstream output. (Most MCP tool returns go through the structured logger and reports, both already covered.)
- **N-1 / N-2 / N-4 primitives**: their result objects should never echo raw env-secret values back to the AI caller. Add to primitive-implementation checklist.
