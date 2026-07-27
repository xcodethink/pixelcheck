# ADR-004 — Worktree-isolated development and a big-bang cutover

- **Status**: Accepted
- **Date**: 2026-04-25
- **Builds on**: [ADR-001](./ADR-001-AI-first-positioning.md), [ADR-002](./ADR-002-primitive-first-architecture.md)

## Context

v0.3 already ran as a live MCP server in the maintainer's editor configuration:

```json
"ai-browser-auditor": {
  "type": "stdio",
  "command": "node",
  "args": ["<repo-root>/dist/mcp/server.js"]
}
```

That has consequences for how v1 can be developed:

- Several editor windows call the v0.3 MCP server concurrently.
- Each stdio session spawns its own server process, loaded from
  `dist/mcp/server.js`.
- They share SQLite databases (`plan-cache.db`, `memory.db`).
- They share browser processes, though Playwright isolates those well enough
  that it is not the problem here.

v1.0 is an architectural rewrite (ADR-002), so development spends long stretches
in a half-finished state. Working directly on `main` would mean:

- Editing `src/` does not disturb a running server, which already has the old
  code in memory — fine.
- But `npm run build` writes `dist/` immediately, so the *next* session to start
  picks up a half-finished build.
- Changing the database schema makes the v0.3 server read unexpected data,
  risking crashes or corruption.
- Changing the result schema breaks whatever depends on the contract.

Those side effects would interrupt daily work continuously for the duration of
the rewrite. Not acceptable.

## Decision

**All v1.0 development happens in a separate git worktree. `dist/` on `main` is
not touched until cutover. When all four phases are complete, cut over in one
step.**

### Physical isolation

```
<repo-root>/                                      ← main branch (v0.3 production)
├─ dist/mcp/server.js                             ← what running sessions load
├─ src/                                           ← v0.3 sources, untouched this round
└─ .claude/worktrees/
   └─ v1-ai-first/                                ← all v1 work happens here
      ├─ src/
      ├─ dist/                                    ← the worktree's own build output
      └─ ...
```

```bash
git worktree add .claude/worktrees/v1-ai-first -b worktree-v1-ai-first
```

### Separate data paths

Switched by environment variable, which the code already supports:

```bash
# When the worktree starts a server or runs tests
export AUDIT_PLAN_CACHE_PATH=~/.ai-browser-auditor-v1/plan-cache.db
export AUDIT_MEMORY_PATH=~/.ai-browser-auditor-v1/memory.db
export AUDIT_REPORTS_DIR=~/.ai-browser-auditor-v1/reports
```

The v0.3 server keeps the default location; the worktree uses the `-v1` suffix,
so neither can corrupt the other's data.

### Cutover protocol

**Precondition**: all four phases complete, the full test suite green inside the
worktree, and a manual smoke test passed.

```bash
# 1. Stop every session using the MCP server (coordinated manually).

# 2. Back up the v0.3 data and mark the final v0.3 commit.
cp -R ~/.ai-browser-auditor ~/.ai-browser-auditor.v0.3.backup-$(date +%s)
git tag v0.3-final-$(date +%Y%m%d)

# 3. Merge the worktree branch into main.
git checkout main
git merge worktree-v1-ai-first --no-ff -m "Merge v1.0 AI-first rewrite"

# 4. Rebuild dist.
npm install
npm run build

# 5. Migrate the v0.3 database to the v1 schema.
node dist/migrations/v0.3-to-v1.js

# 6. Smoke-test the new server, then stop it.
node dist/mcp/server.js

# 7. Restart the editor sessions.

# 8. Remove the worktree, keeping the backup.
git worktree remove .claude/worktrees/v1-ai-first
```

### Rollback

If v1 fails fatally after cutover — the server will not start, data is corrupt,
or a core primitive crashes:

```bash
# Stop all sessions.
git revert HEAD          # undo the merge commit
npm run build

# Restore the data.
mv ~/.ai-browser-auditor ~/.ai-browser-auditor.v1.broken-$(date +%s)
mv ~/.ai-browser-auditor.v0.3.backup-* ~/.ai-browser-auditor

# Restart sessions — back on v0.3.
```

Then fix the problem in a fresh worktree and repeat the cutover.

## Consequences

### Positive

- Zero interruption to daily work during the rewrite.
- The v0.3 → v1 transition is a single deterministic event (back up, test, cut
  over) rather than a slow degradation.
- Separate data paths mean v1 testing cannot pollute v0.3 data.
- Worktree isolation keeps git history clean and makes the rewrite reviewable as
  a whole.

### Negative

- A long window before anything ships: v1 must be complete before cutover, so
  the new primitives are unavailable outside the worktree until then.
- Cutover requires a coordinated 5–10 minute pause of all sessions.
- The migration script must be thoroughly tested beforehand, since the v0.3 and
  v1 data formats are incompatible.

### Neutral

- Phase-by-phase cutover would deliver capability sooner but needs four
  interruption windows and four migrations; the big-bang option was chosen
  instead.
- This ADR governs the v0.3 → v1.0 rewrite only. Later v1.x work returns to
  ordinary rolling development.

## Alternatives considered

**A. Cut over after each phase (rolling upgrade).**
Rejected — four interruption windows, four migrations, and scheduling cost each
time.

**B. Develop on `main` behind feature flags.**
Rejected — flags do little for a server that already holds the old code in
memory, and the tree would carry both the v0.3 and v1 abstractions at once.

**C. Ship v1 as a separate npm package.**
Rejected — two MCP servers coexisting plus two configurations to maintain by
hand is more complex than a worktree.

**D. Pause all work until v1 is done.**
Rejected — other projects depend on the tool being available throughout.

## Implementation checklist

Before v1 development starts:

- [ ] Create the worktree: `git worktree add .claude/worktrees/v1-ai-first -b worktree-v1-ai-first`
- [ ] Add `.env.development` inside it with the `AUDIT_*_PATH` variables pointing at the `-v1` data directory
- [ ] Create that data directory
- [ ] Run `npm install && npm run build` once inside the worktree to confirm the baseline builds
- [ ] Record the development location in the project status file

Every working session must confirm the current directory is the worktree, not
`main`, before starting.

## References

- ADR-001 — [AI-first positioning](./ADR-001-AI-first-positioning.md)
- ADR-002 — [Primitive-first architecture](./ADR-002-primitive-first-architecture.md)
