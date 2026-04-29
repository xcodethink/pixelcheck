import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  RESULT_SCHEMA_VERSION,
  AuditRunSchema,
  StepResultSchema,
  IssueSchema,
  DimensionScoreSchema,
  CriticResultSchema,
  GateResultSchema,
  CalibrationReportSchema,
  BenchmarkReportSchema,
  BenchmarkTaskResultSchema,
  MutationResultSchema,
  AuditUrlResultSchema,
  ExploreUrlResultSchema,
  CalibrateCriticResultSchema,
  ListPersonasResultSchema,
  ListScenariosResultSchema,
  SeeResultSchema,
  ActStepSchema,
  ActStepResultSchema,
  ActResultSchema,
  ExtractResultSchema,
  validateResult,
  attachSchemaVersion,
} from "../src/core/result-schema.js";
import { _resetLoggerForTests } from "../src/core/logger.js";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("result-schema — version constant", () => {
  it("RESULT_SCHEMA_VERSION is a SemVer string", () => {
    expect(RESULT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("RESULT_SCHEMA_VERSION is 1.0.0 at the v1 baseline", () => {
    expect(RESULT_SCHEMA_VERSION).toBe("1.0.0");
  });
});

describe("result-schema — AuditRunSchema", () => {
  const minimalAudit = {
    schema_version: "1.0.0",
    run_id: "20260427_120000_smoke",
    project_name: "test",
    base_url: "https://example.com",
    started_at: "2026-04-27T12:00:00.000Z",
    finished_at: "2026-04-27T12:00:30.000Z",
    duration_ms: 30000,
    results: [],
    summary: {
      total: 0,
      pass: 0,
      pass_with_issues: 0,
      fail: 0,
      total_cost_usd: 0,
      total_issues: 0,
      critical_issues: 0,
    },
    config: {
      project_name: "test",
      base_url: "https://example.com",
      default_concurrency: 1,
      default_timeout_ms: 30000,
      cost_mode: "balanced",
      budget_usd: 1.0,
      redact_patterns: [],
      models: {
        default: "claude-sonnet-4-6",
        critic: "claude-sonnet-4-6",
        computer_use: "claude-opus-4-6",
        planner: "claude-opus-4-6",
        navigator: "claude-sonnet-4-6",
        replan: "claude-sonnet-4-6",
        navigator_economy: "claude-haiku-4-5-20251001",
      },
    },
  };

  it("validates a minimal audit run", () => {
    expect(() => AuditRunSchema.parse(minimalAudit)).not.toThrow();
  });

  it("schema_version is optional (legacy fixtures must still validate)", () => {
    const { schema_version: _v, ...withoutVersion } = minimalAudit;
    expect(() => AuditRunSchema.parse(withoutVersion)).not.toThrow();
  });

  it("rejects malformed schema_version", () => {
    const bad = { ...minimalAudit, schema_version: "not-semver" };
    expect(() => AuditRunSchema.parse(bad)).toThrow(/schema_version must be SemVer/);
  });

  it("requires summary fields", () => {
    const { summary: _s, ...broken } = minimalAudit;
    expect(() => AuditRunSchema.parse(broken)).toThrow();
  });
});

describe("result-schema — leaf schemas", () => {
  it("StepResultSchema validates a typical step", () => {
    const step = {
      step_id: "s1",
      step_type: "visit" as const,
      status: "pass" as const,
      duration_ms: 1234,
      retries_used: 0,
    };
    expect(() => StepResultSchema.parse(step)).not.toThrow();
  });

  it("IssueSchema enforces severity enum", () => {
    expect(() =>
      IssueSchema.parse({
        severity: "blocker",
        description: "x",
        recommendation: "y",
      }),
    ).toThrow();
  });

  it("DimensionScoreSchema clamps score to 0..10", () => {
    expect(() =>
      DimensionScoreSchema.parse({ dimension: "ux", score: 11, justification: "x" }),
    ).toThrow();
    expect(() =>
      DimensionScoreSchema.parse({ dimension: "ux", score: -1, justification: "x" }),
    ).toThrow();
    expect(() =>
      DimensionScoreSchema.parse({ dimension: "ux", score: 7.5, justification: "x" }),
    ).not.toThrow();
  });
});

describe("result-schema — critic / gate / benchmark / mutation", () => {
  it("CriticResultSchema accepts unknown raw VisionResponse", () => {
    const r = {
      schema_version: "1.0.0",
      verdict: { scores: [], issues: [] },
      scores: [],
      issues: [],
      costUsd: 0.01,
      raw: { whatever: "the SDK returned", choices: [{ tokens: 42 }] },
    };
    expect(() => CriticResultSchema.parse(r)).not.toThrow();
  });

  it("GateResultSchema validates a typical gate", () => {
    const g = {
      passed: true,
      violations: [],
      computed: { mean_agreement: 0.9, mean_max_distance: 0.5, fully_aligned_rate: 0.8 },
    };
    expect(() => GateResultSchema.parse(g)).not.toThrow();
  });

  it("CalibrationReportSchema accepts an empty report", () => {
    const report = {
      tag: "smoke",
      model: "claude-sonnet-4-6",
      started_at: "2026-04-27T12:00:00.000Z",
      finished_at: "2026-04-27T12:00:01.000Z",
      total_samples: 0,
      fully_aligned: 0,
      dimensions_aligned: 0,
      mean_agreement: 0,
      mean_max_distance: 0,
      per_dimension_stats: {},
      samples: [],
      total_cost_usd: 0,
    };
    expect(() => CalibrationReportSchema.parse(report)).not.toThrow();
  });

  it("BenchmarkTaskResultSchema validates", () => {
    const t = {
      task_id: "t1",
      intent: "click pricing",
      tags: [],
      passed: true,
      score: 1,
      eval_detail: { passed: true, per_check: [], score: 1 },
      cost_usd: 0.05,
      duration_ms: 12000,
      final_url: "https://example.com/pricing",
      convergence_reason: "goal_met",
    };
    expect(() => BenchmarkTaskResultSchema.parse(t)).not.toThrow();
  });

  it("BenchmarkReportSchema validates an empty report", () => {
    const report = {
      tag: "smoke",
      started_at: "2026-04-27T12:00:00.000Z",
      finished_at: "2026-04-27T12:00:01.000Z",
      total_tasks: 0,
      passed: 0,
      pass_at_1: 0,
      by_difficulty: {},
      by_tag: {},
      total_cost_usd: 0,
      avg_cost_usd: 0,
      avg_duration_ms: 0,
      p50_duration_ms: 0,
      p95_duration_ms: 0,
      tasks: [],
      config_summary: {
        cost_mode: "balanced",
        planner: "claude-sonnet-4-6",
        navigator: "claude-sonnet-4-6",
        navigator_economy: "claude-haiku-4-5-20251001",
      },
    };
    expect(() => BenchmarkReportSchema.parse(report)).not.toThrow();
  });

  it("MutationResultSchema validates", () => {
    const m = { type: "rephrase" as const, instructions: ["a", "b"] };
    expect(() => MutationResultSchema.parse(m)).not.toThrow();
  });
});

describe("result-schema — MCP tool envelopes", () => {
  it("AuditUrlResultSchema validates a typical handler return", () => {
    const r = {
      schema_version: "1.0.0",
      status: "pass" as const,
      overall_score: 8.5,
      cost_usd: 0.12,
      issues: 0,
      critical_issues: 0,
      report_json: "/abs/path/audit.json",
      report_html: "/abs/path/audit.html",
    };
    expect(() => AuditUrlResultSchema.parse(r)).not.toThrow();
  });

  it("ExploreUrlResultSchema validates with optional fields absent", () => {
    const r = { cost_usd: 0 };
    expect(() => ExploreUrlResultSchema.parse(r)).not.toThrow();
  });

  it("CalibrateCriticResultSchema validates", () => {
    const r = {
      passed: true,
      violations: [],
      mean_agreement: 0.9,
      mean_max_distance: 0.5,
      fully_aligned_rate: 0.85,
      total_cost_usd: 0.02,
      report_dir: "/abs/path",
    };
    expect(() => CalibrateCriticResultSchema.parse(r)).not.toThrow();
  });

  it("ListPersonasResultSchema accepts an empty array", () => {
    expect(() => ListPersonasResultSchema.parse([])).not.toThrow();
  });

  it("ListScenariosResultSchema accepts an empty array", () => {
    expect(() => ListScenariosResultSchema.parse([])).not.toThrow();
  });
});

describe("result-schema — SeeResultSchema (N-1)", () => {
  const minimalSee = {
    schema_version: "1.0.0",
    url_input: "https://example.com",
    url_final: "https://example.com/",
    title: "Example",
    loaded_at: "2026-04-29T08:00:00.000Z",
    status: "ok" as const,
    dom: null,
    console: null,
    screenshot: null,
    note: null,
    persona_id: "us-desktop",
    artifacts_dir: "/tmp/sees/abc",
    cost_usd: 0,
    duration_ms: 1234,
  };

  it("validates a minimal see result with all optional sections null", () => {
    expect(() => SeeResultSchema.parse(minimalSee)).not.toThrow();
  });

  it("validates a fully populated see result", () => {
    const full = {
      ...minimalSee,
      dom: {
        interactive_count: 12,
        headings: ["h1: Welcome", "h2: Pricing"],
        summary: "[Headings]\nh1: Welcome\n\n[Interactive Elements] (12)\n<a href=\"/p\">Pricing</a>",
        text_excerpt: "Welcome to Example",
      },
      console: {
        errors_count: 1,
        errors: [
          {
            type: "console" as const,
            text: "Failed to load resource",
            location: "https://example.com/missing.js",
            timestamp: "2026-04-29T08:00:01.000Z",
          },
        ],
      },
      screenshot: {
        path: "/tmp/sees/abc/screenshot.png",
        sha256: "deadbeef",
        width: 1280,
        height: 800,
        bytes: 12345,
      },
      note: "Hero is a centered headline + CTA button labeled \"Sign up\".",
      cost_usd: 0.0042,
    };
    expect(() => SeeResultSchema.parse(full)).not.toThrow();
  });

  it("rejects unknown status enum values", () => {
    const bad = { ...minimalSee, status: "loading" };
    expect(() => SeeResultSchema.parse(bad)).toThrow();
  });

  it("rejects negative cost_usd", () => {
    const bad = { ...minimalSee, cost_usd: -1 };
    expect(() => SeeResultSchema.parse(bad)).toThrow();
  });

  it("schema_version is optional (legacy fixtures must still validate)", () => {
    const { schema_version: _v, ...rest } = minimalSee;
    expect(() => SeeResultSchema.parse(rest)).not.toThrow();
  });
});

describe("result-schema — ActStepSchema (N-2)", () => {
  it("accepts every documented step type", () => {
    const cases: unknown[] = [
      { type: "goto", url: "https://x/" },
      { type: "goto", url: "https://x/", wait_for: "networkidle", timeout_ms: 5000 },
      { type: "goto", url: "https://x/", wait_for: { type: "selector", selector: "#root" } },
      { type: "click", selector: "button.submit" },
      { type: "fill", selector: "input[name=email]", value: "a@b.c" },
      { type: "press", key: "Enter" },
      { type: "press", key: "Enter", selector: "input" },
      { type: "wait", ms: 250 },
      { type: "wait_for", selector: "#done" },
      { type: "wait_for", selector: "#done", state: "hidden", timeout_ms: 8000 },
      { type: "scroll", to_bottom: true },
      { type: "scroll", delta_y: -400 },
      { type: "screenshot" },
      { type: "screenshot", label: "after-login", full_page: false },
      { type: "act", instruction: "Click the Sign Up button" },
      { type: "note", goal: "Is there a cookie banner?" },
    ];
    for (const c of cases) {
      expect(() => ActStepSchema.parse(c)).not.toThrow();
    }
  });

  it("rejects unknown step type", () => {
    expect(() => ActStepSchema.parse({ type: "teleport" })).toThrow();
  });

  it("rejects missing required field per step type", () => {
    expect(() => ActStepSchema.parse({ type: "click" })).toThrow();
    expect(() => ActStepSchema.parse({ type: "fill", selector: "x" })).toThrow();
    expect(() => ActStepSchema.parse({ type: "act" })).toThrow();
  });
});

describe("result-schema — ActStepResultSchema (N-2)", () => {
  const minimal = {
    index: 0,
    type: "goto" as const,
    status: "ok" as const,
    duration_ms: 12,
    cost_usd: 0,
  };

  it("accepts a minimal step result", () => {
    expect(() => ActStepResultSchema.parse(minimal)).not.toThrow();
  });

  it("accepts a fully-populated note step result", () => {
    expect(() =>
      ActStepResultSchema.parse({
        ...minimal,
        type: "note",
        note: "There is a header that says 'Welcome'.",
        cost_usd: 0.0042,
      }),
    ).not.toThrow();
  });

  it("accepts an error step result with screenshot", () => {
    expect(() =>
      ActStepResultSchema.parse({
        ...minimal,
        type: "click",
        status: "error",
        error: "Timeout 5000ms exceeded",
        screenshot: { path: "/tmp/x.png", sha256: "deadbeef" },
      }),
    ).not.toThrow();
  });

  it("rejects negative cost_usd", () => {
    expect(() =>
      ActStepResultSchema.parse({ ...minimal, cost_usd: -0.001 }),
    ).toThrow();
  });
});

describe("result-schema — ActResultSchema (N-2)", () => {
  const minimalAct = {
    schema_version: "1.0.0",
    url_input: "https://example.com",
    url_final: "https://example.com/",
    title: "Example",
    started_at: "2026-04-29T08:00:00.000Z",
    finished_at: "2026-04-29T08:00:05.000Z",
    status: "ok" as const,
    engine: "playwright" as const,
    steps: [],
    dom: null,
    console: null,
    screenshot: null,
    persona_id: "act-default-desktop",
    artifacts_dir: "/tmp/acts/abc",
    cost_usd: 0,
    duration_ms: 5000,
  };

  it("validates a minimal act result", () => {
    expect(() => ActResultSchema.parse(minimalAct)).not.toThrow();
  });

  it("validates a fully populated act result with mixed step kinds", () => {
    const full = {
      ...minimalAct,
      engine: "stagehand" as const,
      url_final: "https://example.com/dashboard",
      steps: [
        {
          index: 0,
          type: "goto" as const,
          status: "ok" as const,
          duration_ms: 800,
          cost_usd: 0,
        },
        {
          index: 1,
          type: "act" as const,
          status: "ok" as const,
          duration_ms: 1450,
          output: { description: "clicked Sign Up" },
          cost_usd: 0.0031,
        },
        {
          index: 2,
          type: "screenshot" as const,
          status: "ok" as const,
          duration_ms: 80,
          screenshot: {
            path: "/tmp/acts/abc/step-2.png",
            sha256: "abcd1234",
            width: 1280,
            height: 800,
            bytes: 4321,
          },
          cost_usd: 0,
        },
        {
          index: 3,
          type: "note" as const,
          status: "ok" as const,
          duration_ms: 320,
          note: "Welcome to your dashboard",
          cost_usd: 0.0017,
        },
      ],
      dom: {
        interactive_count: 5,
        headings: ["h1: Dashboard"],
        summary: "[Headings]\nh1: Dashboard",
      },
      console: { errors_count: 0, errors: [] },
      screenshot: {
        path: "/tmp/acts/abc/screenshot.png",
        sha256: "ffeeddcc",
        width: 1280,
        height: 800,
      },
      cost_usd: 0.0048,
    };
    expect(() => ActResultSchema.parse(full)).not.toThrow();
  });

  it("rejects unknown engine value", () => {
    expect(() =>
      ActResultSchema.parse({ ...minimalAct, engine: "puppeteer" }),
    ).toThrow();
  });

  it("rejects negative cost_usd", () => {
    expect(() =>
      ActResultSchema.parse({ ...minimalAct, cost_usd: -0.01 }),
    ).toThrow();
  });

  it("schema_version is optional (legacy fixtures must still validate)", () => {
    const { schema_version: _v, ...rest } = minimalAct;
    expect(() => ActResultSchema.parse(rest)).not.toThrow();
  });
});

describe("result-schema — ExtractResultSchema (N-4)", () => {
  const minimalExtract = {
    schema_version: "1.0.0",
    url_input: "https://example.com",
    url_final: "https://example.com/",
    title: "Example",
    loaded_at: "2026-04-29T08:00:00.000Z",
    status: "ok" as const,
    engine: "stagehand" as const,
    data: {},
    dom: null,
    console: null,
    screenshot: null,
    persona_id: "extract-default-desktop",
    artifacts_dir: "/tmp/extracts/abc",
    cost_usd: 0,
    duration_ms: 1500,
  };

  it("validates a minimal extract result with empty data and all optional sections null", () => {
    expect(() => ExtractResultSchema.parse(minimalExtract)).not.toThrow();
  });

  it("validates a fully populated extract result with caller-defined data shape", () => {
    const full = {
      ...minimalExtract,
      data: {
        plans: [
          { name: "Free", price: 0, features: ["Basic"] },
          { name: "Pro", price: 29, features: ["Basic", "Advanced", "Priority"] },
        ],
      },
      schema_used: {
        type: "object",
        properties: {
          plans: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                features: { type: "array", items: { type: "string" } },
              },
              required: ["name", "price"],
            },
          },
        },
        required: ["plans"],
      },
      instruction_used: "Extract plans from the pricing page",
      selector_used: "main",
      dom: {
        interactive_count: 8,
        headings: ["h1: Pricing"],
        summary: "[Headings]\nh1: Pricing",
      },
      console: { errors_count: 0, errors: [] },
      screenshot: {
        path: "/tmp/extracts/abc/screenshot.png",
        sha256: "deadbeef",
        width: 1280,
        height: 800,
        bytes: 23456,
      },
      cost_usd: 0.0073,
    };
    expect(() => ExtractResultSchema.parse(full)).not.toThrow();
  });

  it("accepts arbitrary `data` shape (caller-defined, never narrowed by us)", () => {
    const cases: unknown[] = [
      null,
      "a free-form string",
      42,
      [1, 2, 3],
      { extraction: "fallback default schema returns this" },
      { nested: { deeply: { value: true } } },
    ];
    for (const c of cases) {
      expect(() =>
        ExtractResultSchema.parse({ ...minimalExtract, data: c }),
      ).not.toThrow();
    }
  });

  it("rejects unknown engine value (only 'stagehand' is valid for extract)", () => {
    expect(() =>
      ExtractResultSchema.parse({ ...minimalExtract, engine: "playwright" }),
    ).toThrow();
  });

  it("rejects unknown status enum values", () => {
    expect(() =>
      ExtractResultSchema.parse({ ...minimalExtract, status: "loading" }),
    ).toThrow();
  });

  it("rejects negative cost_usd", () => {
    expect(() =>
      ExtractResultSchema.parse({ ...minimalExtract, cost_usd: -0.01 }),
    ).toThrow();
  });

  it("schema_version is optional (legacy fixtures must still validate)", () => {
    const { schema_version: _v, ...rest } = minimalExtract;
    expect(() => ExtractResultSchema.parse(rest)).not.toThrow();
  });
});

describe("result-schema — validateResult (warn-not-throw)", () => {
  it("returns input unchanged when value matches schema and emits no warn line", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "result-schema-test-"));
    const logFile = path.join(tmpDir, "log.ndjson");
    await new Promise<void>((resolve, reject) => {
      withEnv(
        { LOG_LEVEL: "warn", LOG_PRETTY: undefined, LOG_FILE: logFile },
        () => {
          _resetLoggerForTests();
          const value = { type: "rephrase" as const, instructions: ["a"] };
          const out = validateResult("MutationResult", MutationResultSchema, value);
          expect(out).toBe(value);
          setTimeout(() => {
            try {
              const text = fs.existsSync(logFile)
                ? fs.readFileSync(logFile, "utf-8")
                : "";
              expect(text).not.toMatch(/result schema mismatch/);
              resolve();
            } catch (err) {
              reject(err);
            }
          }, 200);
        },
      );
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns input unchanged on mismatch and emits a structured warn line", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "result-schema-test-"));
    const logFile = path.join(tmpDir, "log.ndjson");
    await new Promise<void>((resolve, reject) => {
      withEnv(
        { LOG_LEVEL: "warn", LOG_PRETTY: undefined, LOG_FILE: logFile },
        () => {
          _resetLoggerForTests();
          const broken = { type: "wrong-type", instructions: ["a"] };
          const out = validateResult("MutationResult", MutationResultSchema, broken);
          expect(out).toBe(broken);
          setTimeout(() => {
            try {
              const text = fs.readFileSync(logFile, "utf-8");
              expect(text).toMatch(/result schema mismatch/);
              expect(text).toMatch(/MutationResult/);
              const lines = text.trim().split("\n").filter(Boolean);
              const last = JSON.parse(lines[lines.length - 1]!);
              expect(last.level).toBe("warn");
              expect(last.result).toBe("MutationResult");
              expect(last.schema_version).toBe(RESULT_SCHEMA_VERSION);
              expect(Array.isArray(last.issues)).toBe(true);
              resolve();
            } catch (err) {
              reject(err);
            }
          }, 200);
        },
      );
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never throws even on totally malformed input", () => {
    expect(() =>
      validateResult("MutationResult", MutationResultSchema, null),
    ).not.toThrow();
    expect(() =>
      validateResult("MutationResult", MutationResultSchema, "not-an-object"),
    ).not.toThrow();
  });
});

describe("result-schema — attachSchemaVersion", () => {
  it("stamps schema_version onto a plain object when absent", () => {
    const out = attachSchemaVersion({ a: 1, b: 2 } as Record<string, unknown>);
    expect(out.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(out.a).toBe(1);
  });

  it("preserves existing schema_version (no downgrade)", () => {
    const out = attachSchemaVersion({ schema_version: "0.9.0", a: 1 } as Record<
      string,
      unknown
    >);
    expect(out.schema_version).toBe("0.9.0");
  });

  it("places schema_version first in serialized JSON", () => {
    const out = attachSchemaVersion({ a: 1, b: 2 } as Record<string, unknown>);
    const json = JSON.stringify(out);
    expect(json.startsWith(`{"schema_version":`)).toBe(true);
    expect(Object.keys(out)[0]).toBe("schema_version");
  });

  it("returns non-object inputs unchanged", () => {
    expect(attachSchemaVersion(null as unknown)).toBe(null);
    expect(attachSchemaVersion("hello" as unknown)).toBe("hello");
    expect(attachSchemaVersion(42 as unknown)).toBe(42);
    const arr = [1, 2, 3];
    expect(attachSchemaVersion(arr as unknown)).toBe(arr);
  });
});
