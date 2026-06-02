/**
 * First-run consent for sending page content to Anthropic API.
 *
 * Why this exists (T22 — closes RISK-REGISTER R34 + R38):
 * PixelCheck sends screenshots + DOM to Claude API to evaluate pages.
 * That's the entire point of an MCP server giving AI agents eyes on the
 * web — but it's user data leaving the machine and the operator must
 * give informed consent the first time it happens. After acknowledgment,
 * subsequent runs skip the prompt (consent persists in
 * ~/.pixelcheck/consent.json; legacy ~/.ai-browser-auditor/consent.json
 * still read for backward compat via AUDIT_HOME env var).
 *
 * Bypass paths (in this priority):
 *   1. AUDIT_AUTO_CONSENT=1 env var — writes consent marker without prompting
 *   2. CLI flag --auto-consent — same as env var
 *   3. Non-TTY stdin (CI / MCP server / scripted) — implicit auto-consent
 *      with a logged warning
 *   4. Existing valid consent.json — silent skip
 *   5. Otherwise — interactive prompt to stdout/stderr
 *
 * Consent marker shape (versioned):
 *   {
 *     "schema_version": "1.0.0",
 *     "consent_version": 1,
 *     "agreed": true,
 *     "timestamp": "2026-05-02T...",
 *     "agreed_via": "prompt" | "env" | "flag" | "non-tty"
 *   }
 *
 * Bumping CONSENT_VERSION re-triggers the prompt on next run for users
 * who already acknowledged an older version (major privacy policy
 * update path).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pixelcheckHome } from "./home-dir.js";
import { getLogger } from "./logger.js";

const log = getLogger("consent");

/** Bump when privacy policy materially changes. */
export const CONSENT_VERSION = 1;

const CONSENT_SCHEMA_VERSION = "1.0.0";

export type ConsentVia = "prompt" | "env" | "flag" | "non-tty";

export interface ConsentRecord {
  schema_version: string;
  consent_version: number;
  agreed: boolean;
  timestamp: string;
  agreed_via: ConsentVia;
}

export interface ConsentOptions {
  /** Treat `AUDIT_AUTO_CONSENT=1` env as auto-consent. Default true. */
  honorEnvVar?: boolean;
  /** Treat `--auto-consent` flag as auto-consent. */
  cliAutoConsent?: boolean;
  /** Override consent file location (default `~/.pixelcheck/consent.json`). */
  consentPath?: string;
  /**
   * Test seam — supply a custom prompt fn (returns "y"/"n"/...) so
   * unit tests can drive the prompt without reading stdin.
   */
  promptFn?: (question: string) => Promise<string>;
  /** Test seam — override TTY detection. */
  isTTY?: boolean;
  /** Override the current time (test seam). */
  now?: () => Date;
}

export interface ConsentResult {
  /** True if consent was given (or already on file at the current version). */
  agreed: boolean;
  /** Where consent came from for this call. */
  via: ConsentVia | "existing";
  /** Path of the consent file. */
  path: string;
}

function defaultConsentPath(): string {
  return path.join(pixelcheckHome(), "consent.json");
}

/**
 * Read consent record from disk. Returns null if missing or unreadable.
 */
export function readConsent(consentPath: string): ConsentRecord | null {
  try {
    if (!fs.existsSync(consentPath)) return null;
    const raw = fs.readFileSync(consentPath, "utf8");
    const parsed = JSON.parse(raw) as ConsentRecord;
    if (typeof parsed.consent_version !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write consent record. Creates parent dir if needed; mode 0700.
 */
export function writeConsent(
  consentPath: string,
  via: ConsentVia,
  now: () => Date = () => new Date(),
): ConsentRecord {
  fs.mkdirSync(path.dirname(consentPath), { recursive: true, mode: 0o700 });
  const record: ConsentRecord = {
    schema_version: CONSENT_SCHEMA_VERSION,
    consent_version: CONSENT_VERSION,
    agreed: true,
    timestamp: now().toISOString(),
    agreed_via: via,
  };
  fs.writeFileSync(consentPath, JSON.stringify(record, null, 2));
  // Chmod to 0700 — file content is non-secret but consent record is
  // user-specific; defense-in-depth on shared machines.
  try {
    fs.chmodSync(consentPath, 0o600);
  } catch {
    // Windows / some FS may not support chmod; ignore.
  }
  return record;
}

/**
 * Default prompt using readline.
 */
async function readlinePrompt(
  rl: readline.Interface,
  question: string,
): Promise<string> {
  return (await rl.question(question)).trim();
}

const PROMPT_TEXT = [
  "",
  "PixelCheck — first-run consent",
  "======================================",
  "",
  "Running an audit will send the following data to the Anthropic Claude API:",
  "  - Screenshots (full page + viewport segments)",
  "  - DOM summaries (tag tree + visible text)",
  "  - Your scenario step text",
  "  - Persona profile fields",
  "",
  "What does NOT leave your machine:",
  "  - Your ANTHROPIC_API_KEY (used to authenticate, not echoed in payloads)",
  "  - Filesystem paths / other env vars",
  "  - History of past audits (each call is independent)",
  "",
  "Password / secret inputs are redacted from screenshots by default",
  "  (--redact-inputs, configurable). See PRIVACY.md for full details.",
  "",
  "Anthropic Privacy Policy: https://www.anthropic.com/privacy",
  "",
].join("\n");

/**
 * Ensure the user has given consent before sending data to Anthropic.
 *
 * Order of resolution:
 *   1. Existing valid consent at current version — return immediately
 *   2. AUDIT_AUTO_CONSENT=1 env — write + return
 *   3. --auto-consent CLI flag — write + return
 *   4. Non-TTY stdin — write with logged warning + return (CI / MCP)
 *   5. Interactive prompt — write if "y"/"yes" + return; throw on "n"
 *
 * Throws if the user explicitly declines.
 */
export async function ensureConsent(
  opts: ConsentOptions = {},
): Promise<ConsentResult> {
  const consentPath = opts.consentPath ?? defaultConsentPath();
  const now = opts.now ?? (() => new Date());
  const honorEnv = opts.honorEnvVar ?? true;

  // 1. Existing valid consent at current version
  const existing = readConsent(consentPath);
  if (
    existing &&
    existing.agreed === true &&
    existing.consent_version >= CONSENT_VERSION
  ) {
    return { agreed: true, via: "existing", path: consentPath };
  }

  // 2. Env var auto-consent
  if (honorEnv && process.env.AUDIT_AUTO_CONSENT === "1") {
    writeConsent(consentPath, "env", now);
    log.info(
      { consentPath, via: "env" },
      "consent auto-acknowledged via AUDIT_AUTO_CONSENT=1",
    );
    return { agreed: true, via: "env", path: consentPath };
  }

  // 3. CLI flag auto-consent
  if (opts.cliAutoConsent) {
    writeConsent(consentPath, "flag", now);
    log.info(
      { consentPath, via: "flag" },
      "consent auto-acknowledged via --auto-consent flag",
    );
    return { agreed: true, via: "flag", path: consentPath };
  }

  // 4. Non-TTY (CI / MCP server / scripted) with NO explicit consent signal —
  // refuse rather than silently auto-grant. Previously this path implicitly
  // consented on the user's behalf, so an MCP server (always non-TTY) sent page
  // data to Anthropic with no human ever in the loop. Consent must be explicit:
  // a prior persisted consent (step 1), AUDIT_AUTO_CONSENT=1 (step 2), or
  // --auto-consent (step 3) — all handled above. (Audit 2026-06-02 B1.)
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    log.warn(
      { consentPath },
      "non-TTY environment with no consent signal; refusing. " +
        "Set AUDIT_AUTO_CONSENT=1 (after reading PRIVACY.md) or pass --auto-consent.",
    );
    throw new ConsentDeclinedError();
  }

  // 5. Interactive prompt
  let promptOnce: (q: string) => Promise<string>;
  let rl: readline.Interface | undefined;
  if (opts.promptFn) {
    promptOnce = opts.promptFn;
  } else {
    rl = readline.createInterface({ input, output });
    promptOnce = (q) => readlinePrompt(rl!, q);
  }

  try {
    output.write(PROMPT_TEXT + "\n");
    const answer = await promptOnce("Acknowledge and continue? [y/N]: ");
    const yes = /^y(es)?$/i.test(answer);
    if (yes) {
      writeConsent(consentPath, "prompt", now);
      return { agreed: true, via: "prompt", path: consentPath };
    }
    throw new ConsentDeclinedError();
  } finally {
    if (rl) rl.close();
  }
}

export class ConsentDeclinedError extends Error {
  constructor() {
    super(
      "Consent declined. The auditor cannot send data to Anthropic API " +
        "without user acknowledgment. Re-run when ready, or use " +
        "AUDIT_AUTO_CONSENT=1 / --auto-consent for non-interactive contexts.",
    );
    this.name = "ConsentDeclinedError";
  }
}
