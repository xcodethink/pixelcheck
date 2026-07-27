# ADR-002 — Primitive-first architecture (audit demoted to a preset)

- **Status**: Accepted
- **Date**: 2026-04-25
- **Builds on**: [ADR-001 — AI-first positioning](./ADR-001-AI-first-positioning.md)

## Context

The core abstraction in v0.3 was **AuditRun**:

```
audit run = scenario × persona × URL → AuditResult
```

Every capability had to be expressed as "perform one audit":

- Look at a URL → invent a minimal scenario and persona, then run an audit.
- Compare A against B → run two audits and diff them.
- Survey five sites → run five audits.
- Have an agent complete a signup → write the signup as scenario YAML.

Under the AI-first positioning fixed by ADR-001, what an agent actually wants is
the underlying primitives:

```
"Look at stripe.com's pricing page"
    → see('https://stripe.com/pricing') directly, no audit to construct

"Compare five SaaS pricing pages and tell me which is most humane"
    → per site: see + extract → compare across all of them
    → not "five audit runs"

"I just changed some CSS — show me how it renders"
    → a single see

"Sign up for an account on this site"
    → a register primitive, not scenario YAML
```

Keeping audit-run as the core abstraction forces an agent to call tools at the
wrong granularity, burning tokens on an over-abstracted flow on every call.

## Decision

**v1.0 makes primitives first-class; audit becomes a preset composition of
them.**

### The model

```
primitives:
  - see(url, opts)              ← visual + DOM + network
  - act(url, steps)             ← action sequence
  - compare(a, b, criteria)     ← A/B comparison + taste
  - extract(url, schema)        ← structured extraction
  - register(service, profile)  ← research-only signup
  - critic(target, rubric)      ← general judgement
  - ...

presets (convenience wrappers over primitive compositions):
  - audit_run         = preset(see + act + critic + report)
  - research_workflow = preset(see × N + extract × N + compare)
  - ux_test           = preset(act + see + critic)
  - register_evaluate = preset(register + see + critic)
```

### MCP surface

Each primitive is its own MCP tool:

```
mcp__pixelcheck__see
mcp__pixelcheck__act
mcp__pixelcheck__compare
mcp__pixelcheck__extract
mcp__pixelcheck__register
mcp__pixelcheck__audit_url       ← thin wrapper over the preset
mcp__pixelcheck__list_personas
...
```

Callers compose freely, or take a preset.

### v0.3 compatibility

- The `pixelcheck audit ...` CLI command stays as a thin shim over the preset.
- Existing persona and scenario YAML keeps working; the shim translates it into
  primitives.
- With a single maintainer at this point, no elaborate deprecation policy is
  needed.

## Consequences

### Positive

- Call granularity matches actual intent, saving tokens and wall-clock time.
- Primitives are reused across presets, so the code stays DRY.
- Adding a preset (research, register-evaluate, …) costs almost nothing.
- Testing gets easier: each primitive is tested alone, presets are tested as
  compositions.
- The MCP tool surface reads more clearly.

### Negative

- Substantial rewrite: runner, handlers and the agent loop all decompose into
  primitives.
- All audit-centric v0.3 documentation needs updating.
- Steeper learning curve — newcomers meet both primitives and presets.
- Design risk in choosing granularity: too fine means excessive round-trips, too
  coarse loses the flexibility this change exists to buy.

### Neutral

- The word "audit" survives in v1 as a preset name, so v0.3 users are not
  completely disoriented.
- HTML reports are still produced, by the audit preset, but are no longer
  central.

## Primitive design rules (binding from v1.0)

1. **Independently testable** — no reliance on another primitive's side effects.
2. **Zod / JSON Schema on both sides** — the contract machine consumers read.
3. **Side effects owned internally** — browser launch, network calls and DB
   writes each have one clear owner.
4. **Dry-run support** — every primitive accepts `dry_run: true` so a caller can
   preview without executing.
5. **Composability first** — return shapes must be consumable by the next
   primitive.
6. **Versioned result schema** — each primitive carries its own SemVer.

## Alternatives considered

**A. Stay audit-centric and add primitives as an "advanced API".**
Rejected — two coexisting abstractions confuse users and double maintenance.

**B. Drop the audit concept entirely.**
Rejected — audit remains a useful, common composition; keep it as a preset
rather than as the core.

**C. Derive primitives automatically from audit YAML.**
Rejected — an extra translation layer adds complexity without addressing the
granularity problem.

## References

- ADR-001 — [AI-first positioning](./ADR-001-AI-first-positioning.md)
