/**
 * Vitest global setup — runs once before any test imports.
 *
 * Disable the result cache by default so primitive unit tests
 * (judge/extract/see) do not persist artefacts across runs and
 * accidentally hit cache from a previous run. Tests that exercise
 * the cache layer itself (tests/result-cache.test.ts) clear the env
 * var locally and pass an explicit `config.dbPath` to use a tmpdir
 * SQLite file, so this setup does not interfere with them.
 */
process.env.AUDIT_RESULT_CACHE_DISABLED = "1";
