# ADR-001 — AI-first product positioning

- **Status**: Accepted
- **Date**: 2026-04-25
- **Supersedes**: the v0.3 "browser audit tool for human developers" framing

## Context

v0.3 was a browser audit tool built for human developers:

- Primary user: a developer running the CLI, or wiring an audit into CI.
- Primary output: an HTML report, a planned PDF, and CI failure messages.
- Primary occasion: run an audit after each deploy to catch UX regressions.

Planning v1 along that line would have produced a more polished human audit
tool while leaving a much larger problem untouched: **an AI writing frontend
code cannot see what it produced.** Claude Code, Codex and other coding agents
finish a UI change and then cannot render it and look at it, judge whether a
button reads correctly, walk a real user flow, survey a competitor or reference
site, complete a realistic signup evaluation, or track how one site changes over
time.

That gap matters more than a better audit tool for humans, for three reasons:

- An agent calls tools far more often than a person invokes them by hand.
- The agent's blind spots — no vision, no taste, no hands — cap what AI
  engineering can reach at all, not just how pleasant it is.
- Giving an agent eyes and hands changes how frontend code gets written, rather
  than making one existing step nicer.

## Decision

**v1.0 is repositioned as general infrastructure for AI to interact with the
visual web.** Concretely:

1. **The primary interface is the MCP server, not the CLI.** Effectively all
   calls come from an agent; the CLI exists for manual debugging.

2. **The capability surface is framed as an agent's senses and actions:**
   - *Eyes* — see / OCR / visual diff / element location
   - *Hands* — act / form filling / research-only signup
   - *Taste* — a general critic, not only WCAG conformance
   - *Memory* — cross-session login state, per-site learning
   - *Voice* — a standardised result schema plus free-form research summaries
   - *Identity* — personas, anti-fingerprinting, a pool of test identities

3. **Audit becomes a preset composition, not the core abstraction** (see
   ADR-002). The v0.3 audit flow survives in v1 as one particular arrangement of
   primitives.

4. **Output favours machine consumers first**: results are JSON-Schema shaped
   with a strong contract and SemVer; HTML and PDF are derived artefacts;
   human-reading polish such as report localisation drops in priority.

5. **Commercial, OSS and team use are served, but no SaaS infrastructure is
   built**: unit tests, contract tests, a PR bot, a Marketplace Action, docs and
   a whitepaper stay in scope; multi-tenancy, an HTTP server, PostgreSQL, remote
   storage and server-side monitoring are out.

6. **Lifecycle**: single-maintainer use → team use → public OSS → possibly SaaS
   much later, which this round does not commit to.

## Consequences

### Positive

- Addresses a larger surface: repeated agent use rather than occasional human
  use.
- Differentiates from Anthropic Computer Use, Browserbase and Playwright MCP by
  adding taste, personas and cross-session memory on top of raw browser control.
- Leaves the door open to a later SaaS evolution without committing to it.
- Existing v0.3 users keep working through the audit shim.

### Negative

- Scope grows from 47 items to 56 (+19%).
- Requires an architectural rewrite (v0.3 → v1.0), not an incremental upgrade.
- Requires worktree-isolated development (ADR-004), which adds coordination
  cost.
- Some v0.3 investment in human-facing UX polish loses value, though it is kept
  for OSS friendliness.

### Neutral

- The v0.3 audit interface remains available as a primitive preset.
- v1.0 is a breaking change, which pre-1.0 OSS convention permits.

## Alternatives considered

**A. Stay on the v0.3 line and build a more polished human audit tool.**
Rejected — it leaves the underlying problem unsolved, and the ceiling for a
human audit tool is far lower than for agent infrastructure.

**B. Cut everything except the MCP server and ship a pure agent tool.**
Rejected — team review and OSS contribution still benefit from a human entry
point, and keeping one is cheap.

**C. Evolve gradually: ship v0.3.1 improvements now, defer v1 indefinitely.**
Rejected — each small improvement carries opportunity cost against a rewrite
that has to happen anyway.

## References

- ADR-002 — [Primitive-first architecture](./ADR-002-primitive-first-architecture.md)
- ADR-004 — [Worktree-isolated development and big-bang cutover](./ADR-004-worktree-isolated-development.md)
