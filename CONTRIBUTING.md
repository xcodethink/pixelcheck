# Contributing to PixelCheck

Thank you for your interest in contributing! This guide covers everything
you need to know to set up a development environment, run tests, and submit
a PR.

For installation troubleshooting (corporate proxy, Alpine, air-gapped, etc),
see [docs/INSTALLATION.md](docs/INSTALLATION.md).

For security-sensitive issues, see [SECURITY.md](SECURITY.md) — please use
private disclosure channels, **not** GitHub Issues.

Community standards: we adopt the
[Contributor Covenant 2.1](CODE_OF_CONDUCT.md) as our Code of Conduct.
Reporting channels are documented in `CODE_OF_CONDUCT.md`.

---

## Table of contents

- [Getting started](#getting-started)
- [Development workflow](#development-workflow)
- [Testing](#testing)
- [Code style](#code-style)
- [Commit conventions](#commit-conventions)
- [Pull request process](#pull-request-process)
- [Architecture Decision Records (ADRs)](#architecture-decision-records-adrs)
- [Branch protection + CI](#branch-protection--ci)
- [Release process](#release-process)

---

## Getting started

### Prerequisites

- Node.js 20+ (LTS recommended; CI tests on 20 / 22). The dev toolchain
  (vitest, eslint) requires Node 20+, so 18 is not supported.
- npm 9+ (ships with Node 20)
- macOS / Linux / Windows / WSL2 — see [INSTALLATION.md](docs/INSTALLATION.md) for platform-specific prereqs

### Clone + install

```bash
git clone https://github.com/xcodethink/pixelcheck.git
cd pixelcheck
npm ci          # use ci, not install — uses package-lock for reproducibility
npm run build   # compile TypeScript
```

### Set up your local environment

Create a `.env.development` file (gitignored — see `.gitignore`) for any
local API keys / config overrides. Example:

```
ANTHROPIC_API_KEY=sk-ant-...
AUDIT_PLAN_CACHE_PATH=/tmp/local-plan-cache.db
AUDIT_DEBUG=1
```

Don't commit your real API key. The CI uses GitHub Secrets (see
`.github/workflows/ci.yml` — `ANTHROPIC_API_KEY` is referenced via
`${{ secrets.ANTHROPIC_API_KEY }}` only in workflows that genuinely need
real LLM calls; never in PR-trigger workflows that run on forks).

---

## Development workflow

### Common commands

```bash
npm run build                   # tsc — check types + emit dist/
npm run typecheck               # tsc --noEmit (faster, no emit)
npm test                        # full vitest unit suite (2200+ tests)
npm run test:watch              # vitest in watch mode for active dev
npm run test:coverage           # generate coverage HTML report
npm run test:coverage:check     # enforce thresholds (74/62/75/75 per ADR-017)
npm run test:integration        # vitest forks pool (file-lock-race, M9-3.2)
npm run test:integration:playwright  # real chromium e2e (recorder/wcag/trends/...)
npm run bench                   # vitest bench → docs/perf-current.json
npm run bench:check             # compare current vs baseline (50% tolerance)
npm run lint:no-console         # no stray console.log in source
npm run schemas                 # regenerate docs/schemas/*.json from Zod
npm run license:check           # verify dep tree against allowlist
npm run sbom                    # generate sbom.json (CycloneDX 1.6)
npm run clean                   # rm -rf dist sbom.json
```

### Iterating on a change

1. Run tests in watch mode in one terminal:
   ```bash
   npm run test:watch
   ```
2. Edit code in another window. Vitest reruns affected tests automatically.
3. Before committing, run the full check suite:
   ```bash
   npm run typecheck && npm test && npm run lint:no-console && npm run schemas
   ```

---

## Testing

The project has **three test suites**:

| Suite | Runner | Scope | When |
|---|---|---|---|
| **Unit + module integration** | vitest (default config) | mocked Page / mocked LLM SDK / fast | every commit, every PR |
| **Cross-process race** | vitest forks pool (`vitest.integration.config.ts`) | file-lock-race spawning real Node child processes | every PR via CI |
| **Real-browser e2e** | Playwright Test (`playwright.config.ts`) | chromium spawn + axe-core + Stagehand | every PR via CI; weekly cron |

### When to add a test where

- Bug or feature fits in pure logic / module boundary → **vitest unit**
  (e.g., `tests/wcag.test.ts`, `tests/db-migrate.test.ts`)
- Cross-process behaviour or vitest worker isolation needed →
  **vitest integration** (`tests/integration/*.test.ts`)
- Real DOM / real chromium / real `page.evaluate` → **Playwright Test**
  (`tests/integration/playwright/*.test.ts`) — see
  [tests/integration/playwright/README.md](tests/integration/playwright/README.md)

### Writing testable code

- Prefer pure functions for business logic; mock browser / LLM at the seam
- Use the `_setXForTests()` test seams in `src/core/cost-guard.ts` and
  `src/core/llm.ts` for module-level state reset between test files
- For LLM-related testing, use `vi.mock("@anthropic-ai/sdk")` at the top
  of the test file (not in setup.ts — keep mocks local + reviewable)

### Coverage requirements

Per [ADR-017](docs/decisions/ADR-017-coverage-tooling-and-m1-2-phase-1.md),
the global coverage floor is **74% statements / 62% branches / 75% functions
/ 75% lines**. The floor ratchets up by ≥1 point on each task that produces
≥1 point of coverage gain. CI fails any PR that drops below this floor.

To inspect locally:

```bash
npm run test:coverage
open coverage/index.html
```

---

## Code style

The project ships **without ESLint or Prettier** by deliberate choice.
Style consistency comes from:

- **TypeScript strict mode** (`tsconfig.json` has `strict: true`) — most
  inconsistencies surface as type errors
- **`lint:no-console`** — guards against `console.*` calls in `src/`
  (use the `pino` logger via `getLogger("module-name")` instead, see
  ADR-005)
- **Reviewer judgment** in PR — small project, single maintainer

### Patterns we follow

- **ESM only**: `import` / `export`, never `require()`. The package is
  `"type": "module"`.
- **Explicit `.js` extensions** in TypeScript imports (required for ESM):
  ```ts
  import { foo } from "./bar.js";  // .js, NOT .ts
  ```
- **No emojis** in source, fixtures, or commit messages — see CLAUDE.md.
  Use `[INFO]` / `[WARNING]` / `[CRITICAL]` text labels instead.
- **No 3rd-party numerics formatting libs** for trivial cases (use
  `n.toFixed(2)`, not `numeral.js`).
- **Comments explain WHY, not WHAT** — well-named functions are
  self-documenting; comments are for non-obvious constraints, hidden
  invariants, or workarounds.
- **No "TODO" markers without an issue link** — `// TODO: fix later` rots;
  `// TODO(#123): implement after M3-1 lands` is acceptable.

### Test files

- One concept per `describe()` block; flat structure preferred over deeply
  nested
- Test names describe behaviour: `"throws BudgetExceededError when run cap is exceeded"`,
  not `"test 1"`
- Fixture-builders (`makeAudit`, `makeIssue`) over inline literals for
  multi-test consistency

---

## Commit conventions

We use **Conventional Commits** with these types:

| Type | Use for |
|---|---|
| `feat` | New user-facing feature |
| `fix` | Bug fix (user-visible) |
| `docs` | Documentation only |
| `test` | Adding / updating tests (no production code) |
| `refactor` | Code change that doesn't fix a bug or add a feature |
| `chore` | Dependency bumps, tooling, ignore files |
| `ci` | CI workflow / build config |
| `perf` | Performance improvement |

### Scope

Optional `(scope)` after type — usually a module name:

```
feat(reporter-pdf): add WCAG compliance section
fix(handlers): handleAssertA11y axe expansion (T-NEW-11)
chore(deps): bump Anthropic SDK 0.39 → 0.92
```

### Subject + body

- Subject ≤ 80 chars, present tense ("add", not "added")
- Body wraps at ~80 chars, explains **why** not what
- Reference task IDs (`T19`, `M5-7`) and risk IDs (`R23`, `R-NEW-11`)
  when relevant — links to RISK-REGISTER-V2 / EXECUTION-PLAN

### Co-author trailer (when AI-assisted)

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Pull request process

1. **Branch**: name it after the task (`worktree-v1-ai-first`, `t19-governance-docs`, `feat/wcag-section`)
2. **Open a draft PR** if you want early feedback; mark "Ready for review"
   when CI is green
3. **Self-review the diff** before requesting review — re-read every line
   yourself. The reviewer's time is more expensive than yours
4. **CI must be green**: ci.yml (8 configs) + integration.yml (Playwright + race) + coverage.yml
5. **Update CHANGELOG.md** under `## [Unreleased]` with a user-facing
   summary of the change
6. **Update `docs/decisions/ADR-XXX.md`** for non-trivial design decisions
   (more than ~50 LoC of new behaviour, or anything that ties downstream
   code to your choice)
7. **Close any RISK-REGISTER-V2 entries** your PR resolves — mark them
   ✅ in the same PR

### What gets merged fast

- Small, single-purpose PRs (< 300 LoC diff including tests)
- Tests that prove the fix / new feature
- A CHANGELOG line in your own words

### What slows down a merge

- Mixed concerns (refactor + new feature + bug fix in one PR)
- New dependencies without a `## Alternatives rejected` justification
- Behaviour changes without an ADR
- Skipped CI checks ("just merge it")

---

## Architecture Decision Records (ADRs)

Significant design decisions are recorded as ADRs in
[`docs/decisions/`](docs/decisions/). Each ADR follows the same structure:

```markdown
# ADR-NNN — <decision title>

- Status: Proposed / Accepted / Superseded
- Date: YYYY-MM-DD
- Task: M1-2 / T-NEW-11 / etc.

## Context
What problem are we solving? What are the constraints?

## Decision
What did we decide? (Concrete + actionable, not vague.)

## Alternatives rejected
Each rejected option with reasoning. Future maintainers will ask
"why didn't we just do X?" — answer it here.

## Consequences
What changes downstream? What new constraints does this create?

## Files added / changed
List of paths affected by this decision.
```

When **NOT** to write an ADR:
- Renaming a variable
- Adding a test
- Bumping a patch version of a dep without behaviour change

When you **MUST** write an ADR:
- Adding a new dependency to `dependencies` (not devDependencies)
- Changing the public API surface (`src/index.ts` exports)
- Changing the published JSON Schema shape
- New SQLite migration
- New CI gate / threshold change

Browse the existing 26 ADRs (ADR-005 through ADR-030) for examples.

---

## Branch protection + CI

The `main` branch should have these GitHub Settings → Branches → Branch
protection rules enabled (configure once when forking):

- ✅ Require status checks before merging:
  - `Test (ubuntu-latest · Node 20)` (and 7 other matrix configs from `ci.yml`)
  - `Playwright integration (real chromium)` from `integration.yml`
  - `Coverage gate (ADR-017 ratchet)` from `coverage.yml`
- **Observation-only (do NOT require as gates)**: the `windows-latest`
  matrix configs run with `continue-on-error` (non-blocking — see
  [docs/INSTALLATION.md](docs/INSTALLATION.md) Tier-1 note), and the
  `bench.yml` (perf) + `dogfood.yml` workflows run in observation mode by
  design. They surface signal but must not block merges.
- ✅ Require conversation resolution before merging
- ✅ Do not allow bypassing the above settings
- ❌ Allow force pushes — keep this OFF on main
- ❌ Allow deletions — keep this OFF on main

For new contributors: **don't push directly to `main`**. Always go through
a PR.

---

## Release process

Releases are tagged on `main` after CI is green. The `sbom.yml` workflow
auto-generates and attaches a CycloneDX SBOM to each GitHub Release.

Release tag format: `v1.2.3` (SemVer). See [package.json](package.json) for
the current version.

For a full release-readiness checklist (cross-platform install verify,
license audit, privacy disclosure, etc) see
[progress/RELEASE-READINESS-CHECKLIST.md](https://github.com/xcodethink/pixelcheck/blob/main/progress/RELEASE-READINESS-CHECKLIST.md)
in the planning repo.

---

## Where to ask questions

- **Code question**: open a discussion on GitHub Discussions
- **Bug**: file a [GitHub Issue](https://github.com/xcodethink/pixelcheck/issues)
- **Security**: see [SECURITY.md](SECURITY.md) — private disclosure only
- **Stuck**: tag the issue with `[help wanted]` and describe what you've
  tried; someone will pick it up

---

**Last updated**: 2026-05-01 (T19 — Wave 3 governance docs)
