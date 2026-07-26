# ADR-033 — Rename to PixelCheck and reposition the launch narrative as AI-first MCP infrastructure

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: W1 pre-ship positioning audit
- **Depends on**: ADR-001 (AI-first positioning), ADR-002 (primitive-first architecture)
- **Supersedes**: the package name `ai-browser-auditor` and the "AI Browser Auditor" branding in launch material

## Context

v1.0 was ready to ship — no P0 blockers, 1853 tests, a 570 KB tarball, and a
passing dogfood install. A positioning review found that the external brand
assets had never caught up with the strategy:

- `package.json` was still `ai-browser-auditor`, subtitled "AI-driven
  post-deployment UX audit…".
- The README's H1 was still "AI Browser Auditor", subtitled "Your AI-powered
  product experience reviewer".
- All three launch drafts told the old UX-audit story.
- The README body already mentioned MCP 25 times and primitives 14 times, but
  the old H1 framed all of it.
- ADR-001 (2026-04-25) had repositioned the product as general infrastructure
  for AI to interact with the visual web, with the MCP server as the primary
  interface.
- ADR-002 (2026-04-25) had demoted audit to a preset composition of primitives,
  explicitly not the core of the product.

The contradiction mattered because npm publish was imminent. Shipping under the
old name would enter the market with the wrong story, and renaming an npm
package after publish is painful.

## Research summary

- **Ecosystem (2026 Q2)**: MCP had been donated to the Linux Foundation, an
  OAuth 2.1 preview had landed, the MCP Dev Summit drew 1200 people, and
  resistance to vendor lock-in was mainstream.
- **Adjacent projects**: browser-use (91k stars, state of the art at execution),
  Skyvern (21k+, form-focused), Stagehand v3 (44% faster), Baymard UX-Ray 2.0
  (ecommerce only).
- **The gap**: nothing in open source combined MCP-first design, five
  primitives, multi-persona, multi-locale, WCAG coverage and historical trends.
- **Name availability**: `pixelcheck` was unclaimed on npm and Homebrew
  (verified 2026-05-01). The GitHub username `pixelcheck` was taken by a
  personal account, so the repository stays at `xcodethink/pixelcheck` — the
  same org-name ≠ product-name pattern as facebook/react and
  microsoft/typescript.

## Impact analysis

| Area | Files / scope | Size |
|---|---|---|
| Metadata | `package.json` (name, description, keywords, bin entries) | ~12 lines |
| README head | H1, tagline, opening paragraph, plus body-wide "auditor" grep | ~80 lines |
| Launch drafts | three documents | full rewrite |
| CHANGELOG | v1.0.0 entry gains a "Renamed + Repositioned" section | ~25 lines |
| Migration guide | v0.x → v1.0 command mapping table | ~50 lines |
| New ADR | this file | ~150 lines |
| CLI bins | `package.json` `bin` plus the public API name snapshot | cross-file |
| Source strings | grep and clear every `ai-audit` / `ai_audit` / `ai-browser-auditor` / `AI Browser Auditor` | cross-file |
| Archived drafts | old launch copy moved under `docs/archive/v0.x-launch/` | 3 files moved |

This trips the project's change-control rules on several counts: it modifies
five or more existing files, changes the public API name snapshot (the bin
names), changes `package.json`'s `name`, and precedes an irreversible npm
publish. Explicit approval was obtained before execution.

## Decision

**Rename `ai-browser-auditor` to `pixelcheck` and rewrite every external brand
asset to match the ADR-001 positioning.**

1. **Package name** — `pixelcheck`.
2. **Description** — "MCP-first browser primitives for AI agents — real eyes and
   hands on the web. Local-first. Vendor-agnostic. Yours to own."
3. **Keywords** — add `mcp`, `mcp-server`, `ai-agent`, `primitive`,
   `vendor-agnostic`, `local-first`; drop `e2e` so the package is not mistaken
   for an E2E testing tool.
4. **Bins** — `ai-audit` → `pixelcheck`, `ai-audit-mcp` → `pixelcheck-mcp`.
5. **README H1** — "PixelCheck".
6. **README tagline** — "MCP server giving AI agents real eyes and hands on the
   web. Vendor-agnostic. Local-first. Yours to own."
7. **README body** — every "auditor" / "AI Browser Auditor" occurrence reviewed
   in context. "Audit" survives as the name of a preset composition, but no
   longer as the product's core narrative.
8. **Launch drafts** — rewritten around AI-first MCP infrastructure, leading
   with the five primitives, MCP-first design, resistance to vendor lock-in, and
   the multi-persona / multi-locale differentiator.
9. **CHANGELOG** — v1.0.0 gains "Renamed to PixelCheck" and "Repositioned as
   AI-first MCP infrastructure" sections.
10. **Migration guide** — a v0.x → v1.0 command mapping (`ai-audit run` →
    `pixelcheck run`, and so on).
11. **Public API name snapshot** — regenerated for the new bin names.
12. **Archive** — the three original launch drafts move to
    `docs/archive/v0.x-launch/` as v0.x history.

## Alternatives considered

**Option B — keep the name, upgrade only the launch narrative.**
Cheaper (about half a day) and leaves the bins and public API alone. Rejected:
it preserves the mismatch this ADR exists to remove.

**Option C — publish as-is and adjust later.**
Zero work now. Rejected: the launch window is one-shot, the result contradicts
ADR-001 and ADR-002 outright (which would make the ADR process decorative), and
renaming an npm package afterwards is very expensive.

**GitHub organisation.**
Keeping the `xcodethink` org and renaming the repository to `pixelcheck` was
chosen — pragmatic, and GitHub's redirect keeps external links working. A new
dedicated org was rejected: it needs manual creation, repo migration, and
re-setup of secrets, actions and dependabot, adding work without helping the
v1.0 ship gate.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| README body drifts from the new H1 | Grep the whole file for "auditor" after the rewrite and judge each occurrence in context |
| The 67-entry public API name snapshot goes stale | Regenerate it; CI compares automatically |
| An unclear migration guide strands v0.x users | Write the command mapping item by item, plus a one-line `ln -s` workaround for anyone keeping the old bin name |
| Discarding already-written launch copy wastes it | Archive it under `docs/archive/v0.x-launch/` |
| A missed `ai-audit` string somewhere | Grep the whole repository and print anything unreplaced for manual review |
| The taken GitHub username misdirects visitors | State the canonical repository URL at the top of the README and in this ADR; fix all official links |
| Published JSON schemas reference the old name | Grep the 30 published schemas and adjust `$id` where needed, keeping the old `$id` as a backward-compatible alias |

## Rollback plan

**Before publish** — every change is revertible with git; an unpublished
`pixelcheck` name leaves no trace, and the worktree arrangement from ADR-004
keeps `main` untouched.

**After publish** — painful, and therefore to be avoided: this ADR must be fully
executed, with regression and dogfood install green, *before* the publish gate
opens.

```bash
git log --oneline -10          # find the SHA before this ADR's first commit
git revert <first-commit>^..HEAD --no-commit
git commit -m "revert: roll back ADR-033 PixelCheck rename"
npm run build && npm test
```

## Test plan

- `tsc --noEmit`, `npm run build`
- Full unit suite: 1853 tests, count unchanged (bin names inside mocks updated)
- `npm run bench:check`: zero regressions
- Public API name snapshot: bin entries updated, the other 67 unchanged
- Schema idempotence: zero diff across the 30 schemas, unless an `$id` changes
- `lint:no-console`
- `npm pack` against the 1 MB tarball gate
- Fresh-directory dogfood install:
  ```bash
  npm pack
  cd "$(mktemp -d)"
  npm install <path-to>/pixelcheck-1.0.0.tgz
  npx pixelcheck --help
  npx pixelcheck doctor --skip-network --verbose
  npx pixelcheck init test-project
  ```
- MCP self-description: `pixelcheck-mcp` starts and `list_capabilities` returns
  17 tools

## Definition of done

- [ ] This ADR is Accepted
- [ ] `package.json` name, description, keywords and bin entries updated
- [ ] README H1, tagline and body cleared of "auditor" except where it refers to the audit preset
- [ ] All three launch drafts rewritten
- [ ] CHANGELOG v1.0.0 gains the rename and repositioning sections
- [ ] Migration guide gains the v0.x → v1.0 command table
- [ ] `pixelcheck --help` runs clean
- [ ] `pixelcheck-mcp` starts and self-describes 17 tools
- [ ] Public API name snapshot regenerated
- [ ] `npm pack` under 1 MB
- [ ] Fresh-directory dogfood install passes
- [ ] Full regression green (typecheck, build, test, bench, zero schema diff)
- [ ] Old launch copy archived

## Out of scope

Deliberately not handled here — these belong to the publish gate or to later
waves: the npm publish itself, renaming the GitHub repository, registering with
the public MCP registry, the multi-client compatibility matrix, and the
multi-provider LLM abstraction.
