/**
 * Tests for src/core/config.ts — project YAML loader and env validation.
 * Pure I/O surface, no browser/LLM. Touches process.env in the scoped tests
 * and restores it in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProjectConfig, validateEnv } from "../src/core/config.js";

let scratch: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const minimalConfig = `
project_name: pixelcheck-smoke
base_url: https://example.com
`;

function writeConfig(body: string): string {
  const fullPath = path.join(scratch, "config.yaml");
  fs.writeFileSync(fullPath, body, "utf-8");
  return fullPath;
}

describe("loadProjectConfig", () => {
  it("loads a minimal valid config and applies defaults", () => {
    const f = writeConfig(minimalConfig);
    const cfg = loadProjectConfig(f);
    expect(cfg.project_name).toBe("pixelcheck-smoke");
    expect(cfg.base_url).toBe("https://example.com");
    // Schema defaults
    expect(cfg.default_concurrency).toBe(3);
    expect(cfg.default_timeout_ms).toBe(30_000);
    expect(cfg.cost_mode).toBe("balanced");
    expect(cfg.budget_usd).toBe(3.0);
    expect(cfg.models.default).toBe("claude-sonnet-4-6");
    expect(cfg.models.navigator_economy).toBe("claude-haiku-4-5-20251001");
  });

  it("rejects a config with non-URL base_url", () => {
    const f = writeConfig("project_name: x\nbase_url: not-a-url\n");
    expect(() => loadProjectConfig(f)).toThrow(/Invalid project config/);
  });

  it("rejects a config missing project_name", () => {
    const f = writeConfig("base_url: https://x.example\n");
    expect(() => loadProjectConfig(f)).toThrow(/project_name/);
  });

  it("rejects a config with default_concurrency out of range", () => {
    const f = writeConfig(
      `${minimalConfig}default_concurrency: 99\n`,
    );
    expect(() => loadProjectConfig(f)).toThrow(/default_concurrency/);
  });

  it("rejects a config with budget_usd <= 0", () => {
    const f = writeConfig(`${minimalConfig}budget_usd: 0\n`);
    expect(() => loadProjectConfig(f)).toThrow(/budget_usd/);
  });

  it("throws when file does not exist", () => {
    expect(() =>
      loadProjectConfig(path.join(scratch, "missing.yaml")),
    ).toThrow(/Project config not found/);
  });

  it("preserves caller-specified model overrides", () => {
    const f = writeConfig(
      `${minimalConfig}models:\n  default: custom-model\n  critic: critic-x\n  computer_use: cu\n  planner: pl\n  navigator: nav\n  replan: rp\n  navigator_economy: ec\n`,
    );
    const cfg = loadProjectConfig(f);
    expect(cfg.models.default).toBe("custom-model");
    expect(cfg.models.critic).toBe("critic-x");
  });
});

describe("validateEnv", () => {
  it("returns silently when all required vars are set", () => {
    process.env.X = "1";
    process.env.Y = "2";
    expect(() => validateEnv(["X", "Y"])).not.toThrow();
  });

  it("returns silently when no vars are required", () => {
    expect(() => validateEnv([])).not.toThrow();
  });

  it("throws listing missing vars", () => {
    delete process.env.MISSING_A;
    delete process.env.MISSING_B;
    process.env.PRESENT = "1";
    let err: Error | null = null;
    try {
      validateEnv(["PRESENT", "MISSING_A", "MISSING_B"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/Missing required environment variables/);
    expect(err!.message).toMatch(/MISSING_A/);
    expect(err!.message).toMatch(/MISSING_B/);
    expect(err!.message).not.toMatch(/PRESENT/);
  });

  it("rejects pk_live_ Stripe key as a hard fatal", () => {
    process.env.STRIPE_TEST_PUBLISHABLE_KEY = "pk_live_sketchy";
    expect(() => validateEnv([])).toThrow(/LIVE key.*Refusing to run/);
  });

  it("accepts pk_test_ Stripe key", () => {
    process.env.STRIPE_TEST_PUBLISHABLE_KEY = "pk_test_ok";
    expect(() => validateEnv([])).not.toThrow();
  });

  it("treats empty string env var as missing", () => {
    process.env.EMPTY = "";
    expect(() => validateEnv(["EMPTY"])).toThrow(/EMPTY/);
  });
});
