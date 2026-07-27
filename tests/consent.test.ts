/**
 * Unit tests for src/core/consent.ts.
 *
 * Drives the consent flow via the `promptFn` test seam (no readline /
 * stdin). Covers:
 *   - existing valid consent at current version → silent skip
 *   - older consent_version → re-prompts
 *   - AUDIT_AUTO_CONSENT=1 env → writes + skips prompt
 *   - --auto-consent CLI flag → writes + skips prompt
 *   - non-TTY stdin → implicit auto-consent + warn
 *   - interactive y/yes/Y → writes + agreed
 *   - interactive n/no/anything else → throws ConsentDeclinedError
 *   - consent file persistence shape (schema_version + consent_version
 *     + agreed + timestamp + agreed_via)
 *   - consent file mode 0600 (defense-in-depth on shared machines)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONSENT_VERSION,
  ConsentDeclinedError,
  ensureConsent,
  readConsent,
  writeConsent,
  type ConsentRecord,
} from "../src/core/consent.js";

let tmpRoot: string;
let consentPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "consent-test-"));
  consentPath = path.join(tmpRoot, "consent.json");
  delete process.env.AUDIT_AUTO_CONSENT;
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
  delete process.env.AUDIT_AUTO_CONSENT;
});

describe("readConsent / writeConsent", () => {
  it("returns null when consent file does not exist", () => {
    expect(readConsent(consentPath)).toBeNull();
  });

  it("writeConsent persists shape: schema/consent_version/agreed/timestamp/via", () => {
    const fixedNow = new Date("2026-05-02T00:00:00Z");
    const record = writeConsent(consentPath, "prompt", () => fixedNow);
    expect(record.schema_version).toBe("1.0.0");
    expect(record.consent_version).toBe(CONSENT_VERSION);
    expect(record.agreed).toBe(true);
    expect(record.timestamp).toBe(fixedNow.toISOString());
    expect(record.agreed_via).toBe("prompt");

    const onDisk = readConsent(consentPath);
    expect(onDisk).toEqual(record);
  });

  it("readConsent returns null on corrupted JSON", () => {
    fs.mkdirSync(path.dirname(consentPath), { recursive: true });
    fs.writeFileSync(consentPath, "{not json");
    expect(readConsent(consentPath)).toBeNull();
  });

  it("readConsent returns null when consent_version is not a number", () => {
    fs.mkdirSync(path.dirname(consentPath), { recursive: true });
    fs.writeFileSync(
      consentPath,
      JSON.stringify({ agreed: true, consent_version: "1" }),
    );
    expect(readConsent(consentPath)).toBeNull();
  });

  it("writes consent file with mode 0600 (defense-in-depth)", () => {
    if (process.platform === "win32") {
      // chmod is best-effort on Windows; skip the mode assertion.
      writeConsent(consentPath, "prompt");
      expect(fs.existsSync(consentPath)).toBe(true);
      return;
    }
    writeConsent(consentPath, "prompt");
    const stat = fs.statSync(consentPath);
    // mode contains the file-type bits + permission bits; mask & 0o777
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});

describe("ensureConsent — existing consent file", () => {
  it("returns 'existing' silently when consent_version matches CONSENT_VERSION", async () => {
    writeConsent(consentPath, "prompt");
    const result = await ensureConsent({ consentPath });
    expect(result.agreed).toBe(true);
    expect(result.via).toBe("existing");
  });

  it("re-prompts when consent_version on disk is older than CONSENT_VERSION", async () => {
    fs.mkdirSync(path.dirname(consentPath), { recursive: true });
    const oldRecord: ConsentRecord = {
      schema_version: "1.0.0",
      consent_version: 0, // older than current
      agreed: true,
      timestamp: "2025-01-01T00:00:00Z",
      agreed_via: "prompt",
    };
    fs.writeFileSync(consentPath, JSON.stringify(oldRecord));

    const result = await ensureConsent({
      consentPath,
      isTTY: true,
      promptFn: async () => "y",
    });
    expect(result.via).toBe("prompt");
    const reread = readConsent(consentPath);
    expect(reread!.consent_version).toBe(CONSENT_VERSION);
  });

  it("does NOT re-prompt when consent_version is HIGHER than current (forward-compat)", async () => {
    fs.mkdirSync(path.dirname(consentPath), { recursive: true });
    const futureRecord: ConsentRecord = {
      schema_version: "1.0.0",
      consent_version: CONSENT_VERSION + 5,
      agreed: true,
      timestamp: "2027-01-01T00:00:00Z",
      agreed_via: "prompt",
    };
    fs.writeFileSync(consentPath, JSON.stringify(futureRecord));
    const result = await ensureConsent({ consentPath, isTTY: true });
    expect(result.via).toBe("existing");
  });
});

describe("ensureConsent — env / flag bypass", () => {
  it("AUDIT_AUTO_CONSENT=1 writes consent + skips prompt", async () => {
    process.env.AUDIT_AUTO_CONSENT = "1";
    const result = await ensureConsent({
      consentPath,
      isTTY: true, // even in TTY, env wins over prompt
    });
    expect(result.agreed).toBe(true);
    expect(result.via).toBe("env");
    const onDisk = readConsent(consentPath);
    expect(onDisk!.agreed_via).toBe("env");
  });

  it("AUDIT_AUTO_CONSENT=1 ignored when honorEnvVar=false", async () => {
    process.env.AUDIT_AUTO_CONSENT = "1";
    const result = await ensureConsent({
      consentPath,
      honorEnvVar: false,
      isTTY: true,
      promptFn: async () => "y",
    });
    // Falls through to prompt (which we mock as 'y')
    expect(result.via).toBe("prompt");
  });

  it("--auto-consent flag writes consent + skips prompt", async () => {
    const result = await ensureConsent({
      consentPath,
      cliAutoConsent: true,
      isTTY: true,
    });
    expect(result.agreed).toBe(true);
    expect(result.via).toBe("flag");
    const onDisk = readConsent(consentPath);
    expect(onDisk!.agreed_via).toBe("flag");
  });
});

describe("ensureConsent — non-TTY requires explicit consent (Audit 2026-06-02 B1)", () => {
  it("non-TTY with NO consent signal refuses (does not silently auto-grant)", async () => {
    // Previously this auto-consented; that let an MCP server (always non-TTY)
    // send page data to Anthropic with no human in the loop.
    await expect(
      ensureConsent({ consentPath, isTTY: false }),
    ).rejects.toBeInstanceOf(ConsentDeclinedError);
    // and nothing was persisted as "agreed"
    expect(readConsent(consentPath)).toBeNull();
  });

  it("non-TTY WITH AUDIT_AUTO_CONSENT=1 still proceeds", async () => {
    const prev = process.env.AUDIT_AUTO_CONSENT;
    process.env.AUDIT_AUTO_CONSENT = "1";
    try {
      const result = await ensureConsent({ consentPath, isTTY: false });
      expect(result.agreed).toBe(true);
      expect(result.via).toBe("env");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_AUTO_CONSENT;
      else process.env.AUDIT_AUTO_CONSENT = prev;
    }
  });

  it("non-TTY with a prior persisted consent proceeds", async () => {
    // First grant via env, then a fresh non-TTY call should honor the persisted consent.
    const prev = process.env.AUDIT_AUTO_CONSENT;
    process.env.AUDIT_AUTO_CONSENT = "1";
    try {
      await ensureConsent({ consentPath, isTTY: false });
    } finally {
      if (prev === undefined) delete process.env.AUDIT_AUTO_CONSENT;
      else process.env.AUDIT_AUTO_CONSENT = prev;
    }
    const result = await ensureConsent({ consentPath, isTTY: false });
    expect(result.agreed).toBe(true);
    expect(result.via).toBe("existing");
  });
});

describe("ensureConsent — interactive prompt", () => {
  it("'y' answer writes consent + agreed via prompt", async () => {
    const result = await ensureConsent({
      consentPath,
      isTTY: true,
      promptFn: async () => "y",
    });
    expect(result.agreed).toBe(true);
    expect(result.via).toBe("prompt");
    expect(readConsent(consentPath)!.agreed_via).toBe("prompt");
  });

  it("'yes' / 'Y' / 'YES' all accepted as yes", async () => {
    for (const ans of ["yes", "Y", "YES"]) {
      const path2 = path.join(tmpRoot, `consent-${ans}.json`);
      const result = await ensureConsent({
        consentPath: path2,
        isTTY: true,
        promptFn: async () => ans,
      });
      expect(result.agreed).toBe(true);
    }
  });

  it("'n' / 'no' / empty / anything else throws ConsentDeclinedError", async () => {
    for (const ans of ["n", "no", "", "maybe", "?"]) {
      await expect(
        ensureConsent({
          consentPath,
          isTTY: true,
          promptFn: async () => ans,
        }),
      ).rejects.toThrow(ConsentDeclinedError);
    }
  });

  it("declined consent does NOT write a consent file", async () => {
    await expect(
      ensureConsent({
        consentPath,
        isTTY: true,
        promptFn: async () => "n",
      }),
    ).rejects.toThrow(ConsentDeclinedError);
    expect(fs.existsSync(consentPath)).toBe(false);
  });
});

describe("ensureConsent — priority order", () => {
  it("existing valid consent wins over env var", async () => {
    writeConsent(consentPath, "prompt");
    process.env.AUDIT_AUTO_CONSENT = "1";
    const result = await ensureConsent({
      consentPath,
      isTTY: true,
    });
    // 'existing' (priority 1) — env var (priority 2) doesn't get a turn
    expect(result.via).toBe("existing");
  });

  it("env var wins over CLI flag (env evaluated first)", async () => {
    process.env.AUDIT_AUTO_CONSENT = "1";
    const result = await ensureConsent({
      consentPath,
      cliAutoConsent: true,
      isTTY: true,
    });
    expect(result.via).toBe("env");
  });

  it("CLI flag wins over non-TTY auto-consent", async () => {
    const result = await ensureConsent({
      consentPath,
      cliAutoConsent: true,
      isTTY: false,
    });
    expect(result.via).toBe("flag");
  });
});
