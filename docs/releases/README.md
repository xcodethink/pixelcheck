# Release Records

Per the global release-logging rule (`~/.claude/CLAUDE.md` 发布记录铁律),
every production deployment writes a dated record here documenting:

- **Deployment IDs** — concrete SHAs / npm version / GitHub release tag
  (no "latest" — write the actual immutable identifier)
- **Code Changes** — `git show --stat HEAD` summary of what landed
- **Database Migrations** — file list + how they were applied
- **Production Verification** — actual commands run + outputs (curl,
  smoke tests, dogfood install)
- **Rollback Plan** — concrete reversal commands for both code and data

## Naming convention

```
YYYY-MM-DD-<short-description>.md
```

Examples:
- `2026-05-02-v1.0-bigbang-rehearsal.md` — pre-publish merge / migration
  rehearsal (no actual deploy)
- `2026-05-XX-v1.0.0-publish.md` — actual v1.0.0 npm publish + GitHub
  release (when it happens)

## Discipline

- Pre-publish rehearsals are dated when the rehearsal ran, not when the
  publish happened
- Cross-month backfills are forbidden — if a release wasn't recorded the
  same day, the gap stays in history (don't fake past records)
- Write commands as they were actually run, not as you wish you'd run
  them
- Include verification output (paste-stdout, not summary) so future you
  can trust the record

This directory is part of the npm tarball under `files: [...]` only
indirectly via README links; it lives in git for history but isn't
shipped to package consumers.
