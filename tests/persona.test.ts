/**
 * Tests for src/core/persona.ts — YAML loader, env-placeholder resolution,
 * and url_locale derivation. Uses tmpdir scratch space so tests don't touch
 * the worktree's real personas/. Restores process.env in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadPersonas,
  loadPersonaFile,
  resolvePersonaSecrets,
  resolveEnvPlaceholders,
  resolvePersonasDir,
  resolveBundledPersonasDir,
} from "../src/core/persona.js";
import type { Persona } from "../src/core/types.js";

describe("resolvePersonasDir (Audit 2026-06-02 F1 — MCP/global fallback)", () => {
  it("falls back to the bundled personas/ when no userPath exists", () => {
    const dir = resolvePersonasDir();
    expect(dir).toBe(resolveBundledPersonasDir());
    expect(fs.existsSync(dir)).toBe(true);
    const yamls = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(yamls.length).toBeGreaterThan(0); // the shipped personas
  });

  it("falls back to bundled when the user path does not exist", () => {
    const dir = resolvePersonasDir("/nonexistent/personas/xyz");
    expect(dir).toBe(resolveBundledPersonasDir());
  });

  it("prefers an existing user-supplied path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "personas-pref-"));
    expect(resolvePersonasDir(tmp)).toBe(path.resolve(tmp));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

let scratch: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "persona-test-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const minimalPersona = `
id: u1
display_name: Tester
country: JP
language: ja
locale: ja-JP
timezone: Asia/Tokyo
device_class: desktop
payment_tier: free
mental_model: casual user
`;

function writePersona(file: string, body: string): string {
  const fullPath = path.join(scratch, file);
  fs.writeFileSync(fullPath, body, "utf-8");
  return fullPath;
}

describe("loadPersonaFile", () => {
  it("loads a valid persona", () => {
    const f = writePersona("u1.yaml", minimalPersona);
    const p = loadPersonaFile(f);
    expect(p.id).toBe("u1");
    expect(p.country).toBe("JP");
    expect(p.locale).toBe("ja-JP");
    expect(p.critical_concerns).toEqual([]); // schema default
  });

  it("rejects persona with non-2-letter country", () => {
    const f = writePersona(
      "bad.yaml",
      minimalPersona.replace("country: JP", "country: JPN"),
    );
    expect(() => loadPersonaFile(f)).toThrow(/Invalid persona bad\.yaml/);
  });

  it("rejects persona with bad device_class", () => {
    const f = writePersona(
      "bad.yaml",
      minimalPersona.replace("device_class: desktop", "device_class: smarttv"),
    );
    expect(() => loadPersonaFile(f)).toThrow(/device_class/);
  });

  it("rejects persona missing payment_tier", () => {
    const lines = minimalPersona.split("\n").filter((l) => !l.includes("payment_tier"));
    const f = writePersona("nopt.yaml", lines.join("\n"));
    expect(() => loadPersonaFile(f)).toThrow(/payment_tier/);
  });

  it("error message lists every invalid field path", () => {
    const f = writePersona("multi.yaml", "id: u\nlanguage: x\n");
    let err: Error | null = null;
    try {
      loadPersonaFile(f);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/display_name/);
    expect(err!.message).toMatch(/country/);
    expect(err!.message).toMatch(/locale/);
  });
});

describe("loadPersonas", () => {
  it("loads multiple persona files", () => {
    writePersona("a.yaml", minimalPersona.replace("id: u1", "id: a"));
    writePersona("b.yaml", minimalPersona.replace("id: u1", "id: b"));
    const map = loadPersonas(scratch);
    expect(map.size).toBe(2);
    expect(map.get("a")?.id).toBe("a");
    expect(map.get("b")?.id).toBe("b");
  });

  it("accepts both .yaml and .yml extensions", () => {
    writePersona("a.yaml", minimalPersona.replace("id: u1", "id: a"));
    writePersona("b.yml", minimalPersona.replace("id: u1", "id: b"));
    expect(loadPersonas(scratch).size).toBe(2);
  });

  it("ignores non-YAML files", () => {
    writePersona("a.yaml", minimalPersona.replace("id: u1", "id: a"));
    fs.writeFileSync(path.join(scratch, "README.md"), "ignored");
    expect(loadPersonas(scratch).size).toBe(1);
  });

  it("throws on duplicate persona id", () => {
    writePersona("01.yaml", minimalPersona);
    writePersona("02.yaml", minimalPersona);
    expect(() => loadPersonas(scratch)).toThrow(/Duplicate persona id "u1"/);
  });

  it("throws when directory does not exist", () => {
    expect(() => loadPersonas(path.join(scratch, "nope"))).toThrow(
      /Personas directory not found/,
    );
  });

  it("returns an empty map for an empty directory", () => {
    expect(loadPersonas(scratch).size).toBe(0);
  });
});

describe("resolveEnvPlaceholders", () => {
  it("replaces ${VAR} with the env value", () => {
    process.env.MY_VAR = "hello";
    expect(resolveEnvPlaceholders("X=${MY_VAR}")).toBe("X=hello");
  });

  it("leaves unresolved placeholders in place when env is missing", () => {
    delete process.env.GONE;
    expect(resolveEnvPlaceholders("X=${GONE}")).toBe("X=${GONE}");
  });

  it("only matches uppercase + digit + underscore names", () => {
    process.env.lower = "no";
    // ${lower} is *not* matched by the regex (only [A-Z0-9_]+)
    expect(resolveEnvPlaceholders("X=${lower}")).toBe("X=${lower}");
  });

  it("handles multiple placeholders in one string", () => {
    process.env.A = "1";
    process.env.B = "2";
    expect(resolveEnvPlaceholders("${A}-${B}")).toBe("1-2");
  });

  it("returns input unchanged with no placeholders", () => {
    expect(resolveEnvPlaceholders("plain")).toBe("plain");
  });
});

describe("resolvePersonaSecrets", () => {
  function basePersona(overrides: Partial<Persona> = {}): Persona {
    return {
      id: "u1",
      display_name: "T",
      country: "US",
      language: "en",
      locale: "en-US",
      timezone: "America/New_York",
      device_class: "desktop",
      payment_tier: "free",
      mental_model: "x",
      critical_concerns: [],
      ...overrides,
    } as Persona;
  }

  it("derives url_locale as the short ISO 639-1 prefix of locale", () => {
    const p = basePersona({ locale: "ja-JP" });
    const enriched = resolvePersonaSecrets(p) as Persona & { url_locale: string };
    expect(enriched.url_locale).toBe("ja");
  });

  it("falls back to the full locale when no hyphen present", () => {
    const p = basePersona({ locale: "en" });
    const enriched = resolvePersonaSecrets(p) as Persona & { url_locale: string };
    expect(enriched.url_locale).toBe("en");
  });

  it("returns persona unchanged (apart from url_locale) when no test_credentials", () => {
    const p = basePersona();
    const out = resolvePersonaSecrets(p);
    expect(out.test_credentials).toBeUndefined();
    expect((out as Persona & { url_locale: string }).url_locale).toBe("en");
  });

  it("substitutes env placeholders in test_credentials values", () => {
    process.env.TEST_USER_PASSWORD = "swordfish";
    const p = basePersona({
      test_credentials: { password: "${TEST_USER_PASSWORD}", username: "alex" },
    });
    const out = resolvePersonaSecrets(p);
    expect(out.test_credentials).toEqual({
      password: "swordfish",
      username: "alex",
    });
  });

  it("leaves unresolved placeholders in credential values when env missing", () => {
    delete process.env.MISSING_CREDENTIAL;
    const p = basePersona({
      test_credentials: { token: "${MISSING_CREDENTIAL}" },
    });
    const out = resolvePersonaSecrets(p);
    expect(out.test_credentials?.token).toBe("${MISSING_CREDENTIAL}");
  });

  it("does not mutate the input persona object", () => {
    process.env.X = "y";
    const p = basePersona({ test_credentials: { a: "${X}" } });
    const before = JSON.stringify(p);
    resolvePersonaSecrets(p);
    expect(JSON.stringify(p)).toBe(before);
  });
});
