/**
 * Cassette helper for LLM e2e tests (T3 — closes RISK-REGISTER R1).
 *
 * Why this exists:
 * Pre-T3 the project had ZERO real-LLM-end-to-end tests. Every Anthropic
 * SDK call was vi.mock'd. A breaking change in the SDK request/response
 * shape, or a model upgrade that subtly altered output structure, would
 * ship undetected. Real-API tests catch that — but burning $30-50 on
 * every CI run is wasteful.
 *
 * Industry standard: 3-layer LLM testing
 *   Layer 1: unit tests (vi.mock) — already comprehensive
 *   Layer 2: cassette replay (this file) — record once, replay forever
 *   Layer 3: weekly real re-record (manual, monitored cost)
 *
 * Cost model:
 *   - Initial record: ~$5-10 for 12 cassettes (Sonnet 4.6 with small fixtures)
 *   - Every CI run: $0 (replay from disk)
 *   - Re-record on model upgrade: same as initial
 *
 * Modes (selected via env var):
 *   AUDIT_E2E_RECORD=1     — call real API + persist cassette to disk
 *                             (also reads ANTHROPIC_API_KEY)
 *   AUDIT_E2E_REPLAY=1     — load cassette from disk + intercept HTTP via
 *                             nock (no API key needed; default for CI)
 *   neither / both unset  — skip the test (lets contributors run the
 *                            normal test suite without LLM gates)
 *
 * Cassette format:
 *   tests/cassettes/<case-name>.json
 *   {
 *     "case_name": "see-no-goal",
 *     "recorded_at": "2026-05-...",
 *     "model": "claude-sonnet-4-6",
 *     "schema_version": "1.0.0",  // cassette format version, NOT result schema
 *     "request": { url, method, body_hash },
 *     "response": { status, headers (subset), body }
 *   }
 *   API key + secrets redacted before write — verified by `redactCassette()`.
 *
 * Replay strategy:
 *   We don't try to byte-compare requests (image base64 / unique prompts
 *   would prevent any match). Instead we register a nock interceptor for
 *   POST /v1/messages that returns the recorded response regardless of
 *   exact request body — the cassette is a "what should the API say
 *   given a known-shaped request" snapshot, not a request fingerprint.
 *   Schema validation in the consumer (callers of callVision / etc.) is
 *   what catches response-shape regressions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import nock from "nock";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASSETTE_DIR = path.resolve(__dirname, "../cassettes");

const ANTHROPIC_HOST = "https://api.anthropic.com";
const MESSAGES_PATH = "/v1/messages";

const CASSETTE_SCHEMA_VERSION = "1.0.0";

export type RunMode = "record" | "replay" | "skip";

export function detectMode(): RunMode {
  if (process.env.AUDIT_E2E_RECORD === "1") return "record";
  if (process.env.AUDIT_E2E_REPLAY === "1") return "replay";
  return "skip";
}

export interface Cassette {
  case_name: string;
  recorded_at: string;
  schema_version: string;
  model: string;
  request: {
    url: string;
    method: string;
    body_hash: string;
  };
  response: {
    status: number;
    body: unknown;
  };
}

/**
 * Redact sensitive fields from a cassette before writing to disk. Run
 * defensively — even if the SDK never echoes the API key (it doesn't),
 * the body_hash + headers + recorded prompt strings could contain
 * incidental secrets if a test fixture is sloppy.
 */
function redactCassette(c: Cassette): Cassette {
  const json = JSON.stringify(c);
  // Strip anything that looks like an API key
  const redacted = json
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "sk-ant-[REDACTED]")
    .replace(/Bearer [a-zA-Z0-9_-]{20,}/g, "Bearer [REDACTED]");
  return JSON.parse(redacted) as Cassette;
}

export function cassettePath(caseName: string): string {
  return path.join(CASSETTE_DIR, `${caseName}.json`);
}

/**
 * Write a recorded cassette to disk. Defensively redacts before write
 * — never trusts the caller to have already cleaned the response.
 */
export function saveCassette(c: Cassette): void {
  if (!fs.existsSync(CASSETTE_DIR)) {
    fs.mkdirSync(CASSETTE_DIR, { recursive: true });
  }
  const safe = redactCassette(c);
  fs.writeFileSync(
    cassettePath(safe.case_name),
    JSON.stringify(safe, null, 2),
    { mode: 0o644 },
  );
}

/**
 * Load a previously-recorded cassette. Throws if the cassette is missing
 * or if its schema_version is incompatible with this helper.
 */
export function loadCassette(caseName: string): Cassette {
  const file = cassettePath(caseName);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Cassette not found: ${file}. Run with AUDIT_E2E_RECORD=1 to record it first.`,
    );
  }
  const raw = fs.readFileSync(file, "utf8");
  const c = JSON.parse(raw) as Cassette;
  if (c.schema_version !== CASSETTE_SCHEMA_VERSION) {
    throw new Error(
      `Cassette ${caseName} has schema_version ${c.schema_version}; expected ${CASSETTE_SCHEMA_VERSION}.`,
    );
  }
  return c;
}

/**
 * Register a nock interceptor that returns the recorded response for
 * the next call to POST /v1/messages, regardless of request body. The
 * cassette is the contract; the SDK call shape is validated separately
 * by the consumer's schema-validation layer.
 */
export function mountReplay(c: Cassette): nock.Scope {
  // `persist` = false (default): the interceptor unregisters itself after
  // the first match, so a single test that makes 2 messages calls won't
  // accidentally reuse the same response. For multi-call tests, mount
  // each cassette in order.
  const scope = nock(ANTHROPIC_HOST)
    .post(MESSAGES_PATH)
    .reply(c.response.status, c.response.body);
  return scope;
}

/**
 * After replay, assert that all registered interceptors were used. nock
 * calls these "pending mocks" — if there are pending mocks, the test
 * called fewer messages than the cassette expected, which is itself
 * a regression (the consumer used to call the API and now doesn't).
 */
export function assertNoPendingMocks(): void {
  const pending = nock.pendingMocks();
  if (pending.length > 0) {
    throw new Error(
      `Replay finished with ${pending.length} unmatched interceptor(s): ${pending.join(", ")}. ` +
        `The consumer made fewer Anthropic API calls than the cassette expected — possible regression.`,
    );
  }
}

/**
 * Reset nock between tests so interceptors / pending state don't leak.
 */
export function cassetteCleanup(): void {
  nock.cleanAll();
  nock.enableNetConnect();
}

/**
 * For record mode — disables nock so real HTTPS calls go through.
 */
export function enableLiveCalls(): void {
  nock.cleanAll();
  nock.enableNetConnect();
}

/**
 * Build a Cassette object from a real API response. Used in record
 * mode — caller (the test) makes the real call, captures the response
 * body, and passes it here for serialisation.
 */
export function buildCassette(args: {
  caseName: string;
  model: string;
  requestUrl: string;
  responseBody: unknown;
  responseStatus?: number;
}): Cassette {
  return {
    case_name: args.caseName,
    recorded_at: new Date().toISOString(),
    schema_version: CASSETTE_SCHEMA_VERSION,
    model: args.model,
    request: {
      url: args.requestUrl,
      method: "POST",
      body_hash: "<not-tracked-by-design>",
    },
    response: {
      status: args.responseStatus ?? 200,
      body: args.responseBody,
    },
  };
}
