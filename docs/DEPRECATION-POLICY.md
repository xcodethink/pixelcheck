# Deprecation Policy

This document defines how `pixelcheck` deprecates and removes
public-facing functionality. The goal is to give users **predictable,
non-disruptive** upgrade paths while still allowing the project to
evolve.

For breaking changes between specific releases, see
[MIGRATION.md](../MIGRATION.md).

---

## Scope

This policy covers the **public surface** declared in our
[Stability Commitment](../README.md#stability-commitment):

- **CLI** — flags, subcommands, exit codes, env var names
- **Config schema** — `config.yaml`, `personas/*.yaml`, `scenarios/*.yaml`
- **Result Schema** — version `1.2.0` and the 30 published JSON
  Schemas in `docs/schemas/`
- **MCP tool surface** — tool names, input schemas, output envelopes
- **Library exports** — the 67 named exports from `src/index.ts`

Internal modules (`src/core/*` not in `index.ts`) are **not** covered —
they may change without notice.

---

## Deprecation cycle

We follow a **two-version sunset** pattern, aligned with SemVer:

```
v1.x         (deprecation announced — feature still works, warns on use)
   ↓
v1.(x+N)     (warning becomes more prominent — same feature still works)
   ↓
v2.0         (feature removed — breaking change documented in MIGRATION.md)
```

The minimum **N** is **two minor releases** between announcement and
the next major. In practice this means a feature deprecated in v1.3
won't be removed before v2.0 + at least v1.5 ships first.

### Phase 1 — Announcement (minor release)

In the minor release where we decide to deprecate:

1. **CHANGELOG entry** under `### Deprecated` documenting:
   - What is deprecated
   - When it will be removed (target version)
   - What to use instead (always provide a migration path)
2. **Runtime warning** at the deprecation site:
   ```ts
   import { deprecationWarning } from "./core/deprecation.js";

   deprecationWarning("flag:--legacy-foo", {
     since: "1.3.0",
     removeIn: "2.0.0",
     replacement: "Use `--foo` instead. See MIGRATION.md.",
   });
   ```
   The warning prints to stderr (visible in CLI) AND emits a structured
   log entry (`level: warn`, `module: deprecation`) for telemetry.
3. **Inline JSDoc** marker on TypeScript symbols:
   ```ts
   /** @deprecated since v1.3.0 — use `newFunction` instead. Will be
    *  removed in v2.0.0. */
   export function legacyFunction() { ... }
   ```
4. **MIGRATION.md** preview entry under "Upcoming v2.0 breaking changes".

### Phase 2 — Continued warnings (subsequent minors)

For v1.(x+1), v1.(x+2), ..., the deprecated feature **continues to
work** but with the same warning. Users see the warning every CLI
invocation / library call until they migrate.

We do **not** remove deprecated features in patch releases. Patches
are bug fixes only, never API changes.

### Phase 3 — Removal (next major)

In v2.0:

1. Remove the deprecated code path
2. Move the migration entry from "Upcoming v2.0" to v2.0's main migration
   section in MIGRATION.md
3. CHANGELOG entry under `### Removed`
4. If users still call the removed surface, fail with an actionable
   error pointing to MIGRATION.md (don't crash with a stack trace).

---

## What can be deprecated under this policy

✓ CLI flag rename (`--foo` → `--bar`)
✓ CLI subcommand rename
✓ Config field rename
✓ Library export rename
✓ MCP tool input schema field rename (additive change, old field still accepted)
✓ Default value change for an opt-in flag
✓ Behaviour change that previously was unspecified

---

## What is NOT eligible (no advance deprecation; ship in major directly)

✗ **Critical security fix** — fix in patch / minor with a CHANGELOG `### Security` entry; document trade-off (e.g., T-NEW-11 a11y
fix in v1.0 changed audit results — pre-v1.0 deprecation cycle was impossible)
✗ **Result Schema major version bump** (v1.2 → v2.0) — coordinated with
the next major release; users see explicit `schema_version` change
✗ **Internal module rename** — those aren't part of the public surface

---

## Warning emission patterns

We use four warning levels (least → most aggressive). The actual code
path is in `src/core/deprecation.ts` (T-NEW — coming in v1.1):

### Level 1 — Inline annotation only (no runtime cost)

```ts
/** @deprecated since v1.3.0 — use `newFn` instead. Removed in v2.0.0. */
```

For symbols that are imported in user code and surfaced through TS
intellisense. No runtime emission. Use when the deprecated function is
called frequently and stderr noise would be unhelpful.

### Level 2 — Once-per-process warning

```ts
deprecationWarning("flag:--legacy-foo", { once: true, ... });
```

Warns the first time the deprecated path runs in a process; subsequent
calls in the same process are silent. Default for CLI flags.

### Level 3 — Once-per-call warning

```ts
deprecationWarning("api:legacyFunction", { ... });
```

Warns every invocation. Use when the user can fix the warning by
migrating one call site.

### Level 4 — Throws (last release before removal)

In the final minor before removal, optionally bump the warning to a
**`throw` if `AI_BROWSER_AUDITOR_STRICT_DEPRECATIONS=1`** env var is
set. Lets early adopters CI-fail on deprecated paths before v2.0.

---

## Communication

- Deprecation announcements appear in:
  - CHANGELOG.md `### Deprecated` section
  - GitHub release notes (auto-generated from CHANGELOG)
  - README "What's new in v1.x" section (when applicable)
- Two minors before scheduled removal: a release-notes summary lists
  all about-to-be-removed features so v2.0 isn't a surprise.

---

## Examples (hypothetical)

### Renaming a CLI flag

```
v1.3.0:
  - Adds new flag --personas-dir
  - --persona-dir (singular, old) still works but emits deprecation warning
  - CHANGELOG: ### Deprecated — --persona-dir (singular). Use --personas-dir.
              Will be removed in v2.0.0.

v1.4.0, v1.5.0, ...:
  - --persona-dir continues to work, same warning

v2.0.0:
  - --persona-dir removed
  - Passing it errors with "unrecognized flag --persona-dir;
    use --personas-dir (renamed in v1.3, removed in v2.0)"
```

### Removing a deprecated library export

```
v1.5.0:
  - export legacyTransform deprecated; replaced by newTransform
  - JSDoc + once-per-process runtime warning
  - CHANGELOG: ### Deprecated

v1.7.0:
  - Same warning; still works
  - README: "v2.0 removes legacyTransform — migrate now"

v2.0.0:
  - legacyTransform removed from src/index.ts
  - Importing it errors at module load with migration link
```

---

## See also

- [SECURITY.md § Supported Versions](../SECURITY.md#supported-versions)
- [README § Stability Commitment](../README.md#stability-commitment)
- [MIGRATION.md](../MIGRATION.md)
- [CONTRIBUTING.md § ADRs](../CONTRIBUTING.md#architecture-decision-records-adrs) — when an ADR is required for a deprecation

---

**Last updated**: 2026-05-01 (T20 — Wave 3 stability commitment)
