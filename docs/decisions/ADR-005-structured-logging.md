# ADR-005 — Structured logging with pino

- **Status**: Accepted
- **Date**: 2026-04-26
- **Task**: M1-3 (Structured logging, pino + JSON)
- **Related**: M1-4 (Secrets redaction will hook into this logger)

## Context

v0.3 used ad-hoc `console.log/warn/error` with `chalk` color tags throughout the codebase (~30 internal call sites in `runner.ts`, `agent/events.ts`, `agent/agent-loop.ts`, `core/notify.ts`, `observer/screencast.ts`, `observer/server.ts`, `core/stagehand-wrapper.ts`, `mcp/server.ts`).

Three problems with that:

1. **MCP stdio protocol corruption**: the MCP server speaks JSON-RPC over stdio. Any rogue `console.log` to stdout corrupts the protocol frame stream and breaks the connection. The `console.error` to stderr is safe-ish, but informal — not enforceable.
2. **No machine-readability**: CI pipelines, log shippers, and AI agents that consume our output need parseable JSON, not chalk-coded strings with embedded ANSI escapes.
3. **No level control**: `console.log` is always-on. There's no way to silence verbose progress events for CI, or turn up debug for incident triage.

Phase 1 is "AI core + commercial-grade quality + OSS-ready", and the plan explicitly lists logger as a prerequisite for **all** other tasks ("不允许 console.log 重新长出").

## Decision

1. **Library: pino**
   - Industry standard for Node.js structured logging (Fastify, NestJS, Hono use it).
   - Zero-config JSON output by default, very low overhead (claims ~5x faster than winston/bunyan in their benchmarks).
   - Has a built-in `redact` option that we'll wire into M1-4.
   - Stable API, large maintainer base, actively maintained.

2. **Output stream: stderr only**
   - Keeps stdout clean for: CLI command output (e.g. JSON results piped to jq), MCP stdio protocol frames, future programmatic API consumers.
   - This is a hard line — never log to stdout, even at fatal.

3. **Format: TTY-aware default**
   - `LOG_PRETTY=auto` (default): pretty-print (colored, human-readable via pino-pretty) when stderr is a TTY; JSON otherwise.
   - `LOG_PRETTY=1` to force pretty (handy when you pipe stderr through `less -R`).
   - `LOG_PRETTY=0` to force JSON (handy when you want JSON in your terminal for inspection).
   - Outcome: `ai-audit run` in a terminal still feels human-friendly; CI / MCP / piped-stderr automatically gets JSON.

4. **Module-scoped child loggers**
   - `getLogger("runner")` returns a pino child logger with `module: "runner"` baked in.
   - Cached per-module so repeated calls in the same module reuse the instance (cheap to call from hot paths).

5. **Env-driven configuration only**
   - `LOG_LEVEL`, `LOG_PRETTY`, `LOG_FILE` — no config file, no runtime mutation.
   - Keeps the surface tiny and consistent with how every other CLI tool does it.

6. **CLI is the one exception**
   - `src/cli.ts` is the human-facing rendering layer. Chalk-styled `console.log` calls there are intentional UX (formatted tables, scoreboard, repro hints). They go to stdout because they ARE the command's output, not diagnostics about the command.
   - Enforced by `scripts/check-no-console.ts` (was `.sh`; ported to Node for cross-platform `npm test` — see F7), wired into `npm test`, which fails the build if any other source file reintroduces `console.{log,error,warn,info,debug}(`.

## Alternatives considered

- **winston** — heavier, slower, transport plugin model is more flexible but we don't need it.
- **bunyan** — older, less actively maintained, no built-in pretty-print.
- **Build our own thin wrapper around `process.stderr.write`** — would have to reimplement levels, child loggers, redaction, JSON formatting. No benefit.
- **Keep `console.*` and apply a Node `console.Console` shim** — fragile, hard to enforce, doesn't solve the structured-format problem.
- **Add ESLint with `no-console`** — would work but adds a whole toolchain (ESLint config, plugin set, peer-dep maintenance) just for one rule. The grep-based check is one shell file with zero install footprint.

## Consequences

**Positive**
- MCP server is now provably stdio-safe at the logger layer.
- Every log line carries `module`, `level`, `time`, `pid`, plus arbitrary structured fields — log shippers and `jq` queries become trivial.
- M1-4 (secrets redaction) only has to add a `redact` config block, not rewrite any call sites.
- `npm test` will now refuse to merge a PR that sneaks in a new `console.*` outside `cli.ts`.

**Negative / trade-offs**
- One new runtime dependency (`pino`) and one dev-style dep (`pino-pretty`) that ships with the package because pretty mode runs in dev terminals too. Acceptable; pino is small.
- Existing color-coded progress output (`[START]` / `[PASS]` / `[FAIL]` blue/green/red) is gone in favor of pino-pretty's standard format. This is a visible change for `ai-audit run` users in a terminal — they'll see lines like `INFO [runner] unit started scenarioId=... personaId=...` instead of `[START] scenario × persona`. Net: more information per line, slightly different aesthetic. If users prefer the old look, M7-6 (output modes) can wrap pretty mode in a custom formatter.
- The `AUDIT_DEBUG=1` env var that previously gated agent-loop crash stack traces is no longer needed — `LOG_LEVEL=error` (default) shows the crash, and `LOG_LEVEL=debug` would show more detail.

## Follow-ups

- **M1-4 Secrets redaction**: wire `pino.redact` with the patterns from `core/secrets.ts:buildRedactPatterns()`.
- **M9-3 Concurrency safety**: per-unit child loggers (`logger.child({ runId, unitId })`) so concurrent units' logs are unambiguously attributable.
- **M7-6 Output modes** (later): may add a custom pino-pretty formatter to restore the colored `[START]/[PASS]/[FAIL]` aesthetic for users who prefer it.
- **M5-2 Local debug log**: `LOG_FILE` already supports tee-to-file; M5-2 will define the file naming / rotation policy.
