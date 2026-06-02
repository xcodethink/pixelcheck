# Vendored: stealth-core

This directory is a **verbatim vendored copy** of the first-party
`stealth-core` library (anti-detection / fingerprint helper). It is bundled
into `pixelcheck` rather than installed from a registry — see
[ADR-032](../../../docs/decisions/ADR-032-vendor-stealth-core.md) for the full
rationale (the short version: publishing an anti-bot-detection library to a
public registry would let detection vendors fingerprint-match its profile
catalogue, so it stays first-party and vendored).

## Source

| Field | Value |
|---|---|
| Library | `stealth-core` |
| Origin | `@xcodethink/stealth-core` — private, first-party (same owner as this repo) |
| Vendored on | 2026-05-02 (per ADR-032 / task T31.5) |
| License | MIT — same owner as `pixelcheck`; see [LICENSE](./LICENSE) |
| Files | `browser.ts`, `fingerprints.ts`, `index.ts`, `launch-options.ts`, `retry.ts`, `stealth-script.ts` |

Because the library and `pixelcheck` share one owner (`xcodethink`) and one
license (MIT), there is no third-party copyleft obligation. The vendored
[LICENSE](./LICENSE) is included so the attribution travels with the code if
these files are ever extracted or re-vendored elsewhere. The vendored copy is
also disclosed in [docs/THIRD_PARTY_LICENSES.md](../../../docs/THIRD_PARTY_LICENSES.md)
under "First-party vendored code".

## Version pin & integrity

[`integrity.json`](./integrity.json) is the committed pin: it records the
vendoring date, the source, and a **SHA-256 of every vendored `.ts` file**.
Two checks guard the copy:

- **`npm run check:vendor-integrity`** — recomputes the SHA-256s and compares
  them to `integrity.json`. Needs no upstream source, so it runs in CI on
  every push and catches any in-place edit, corruption, or
  added/removed file. This is the enforceable gate.
- **`npm run check:vendor-drift`** — diffs this copy against the canonical
  upstream tree (`STEALTH_CORE_SRC`). Maintainer-local only; it is a no-op on
  GitHub-hosted runners where the canonical tree is absent.

## Refreshing the vendored copy

1. `STEALTH_CORE_SRC=/path/to/stealth-core bash scripts/sync-vendor.sh`
2. `npm run typecheck && npm test`
3. Regenerate the pin: `npm run check:vendor-integrity -- --write`
   (update `vendored_at` in `integrity.json`)
4. Commit the vendor change **with** the updated `integrity.json` — the
   manifest diff is the provenance record of exactly which bytes changed.
5. Bump `pixelcheck`'s patch version and re-publish.
