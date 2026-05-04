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
  JudgeResultSchema,
  JudgeRubricKindSchema,
  JudgeCriterionSpecSchema,
  JudgeVerdictSchema,
  JudgeFindingSchema,
  CompareResultSchema,
  CompareModeSchema,
  CompareWinnerSchema,
  CompareCriterionVerdictSchema,
  DiagnosticsSchema,
  PopupSnapshotSchema,
  NetworkLogSchema,
  CookieSchema,
  StorageSnapshotSchema,
  PerformanceMetricsSchema,
  VisualScoringSchema,
  validateResult,
  attachSchemaVersion,
} from "../src/core/result-schema.js";
import { _resetLoggerForTests, _closeLoggerStreamsForTests } from "../src/core/logger.js";

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

  it("RESULT_SCHEMA_VERSION is 1.3.0 (ADR-034: added diagnostics envelope to primitive results)", () => {
    expect(RESULT_SCHEMA_VERSION).toBe("1.3.0");
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
    // Await actual FD close — SonicBoom's end() is async on Windows.
    await _closeLoggerStreamsForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    // Await actual FD close — SonicBoom's end() is async on Windows.
    await _closeLoggerStreamsForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

describe("result-schema — JudgeResultSchema (N-8)", () => {
  const aestheticCriterion = {
    id: "visual_hierarchy",
    label: "Visual hierarchy",
    description: "Does the layout guide the eye through a clear primary action?",
    kind: "aesthetic" as const,
  };

  const minimalJudge = {
    schema_version: "1.0.0",
    url_input: "https://example.com",
    url_final: "https://example.com/",
    title: "Example",
    loaded_at: "2026-04-30T10:00:00.000Z",
    status: "ok" as const,
    rubrics: ["aesthetic" as const],
    criteria: [aestheticCriterion],
    verdicts: [
      {
        criterion_id: "visual_hierarchy",
        score: 7,
        rationale: "CTA is visually dominant.",
        evidence: [],
      },
    ],
    findings: [],
    overall_score: 7,
    summary: null,
    dom: null,
    console: null,
    screenshot: null,
    persona_id: "judge-default-desktop",
    artifacts_dir: "/tmp/judges/abc",
    model: "claude-sonnet-4-6",
    cost_usd: 0,
    duration_ms: 1500,
  };

  it("validates a minimal judge result with one rubric and one verdict", () => {
    expect(() => JudgeResultSchema.parse(minimalJudge)).not.toThrow();
  });

  it("validates a fully populated judge result with multiple rubrics + findings", () => {
    const full = {
      ...minimalJudge,
      rubrics: ["aesthetic", "dark_pattern"] as const,
      criteria: [
        aestheticCriterion,
        {
          id: "forced_continuity",
          label: "Forced continuity",
          description: "Does the page hide auto-renew or charge after a free trial?",
          kind: "dark_pattern" as const,
        },
      ],
      verdicts: [
        {
          criterion_id: "visual_hierarchy",
          score: 7,
          rationale: "CTA is dominant.",
          evidence: ["Hero CTA reads 'Start free trial'"],
        },
        {
          criterion_id: "forced_continuity",
          score: 3,
          rationale: "Auto-renew disclosure is buried.",
          evidence: ["Footer microcopy: 'auto-renews at $29/mo'"],
        },
      ],
      findings: [
        {
          severity: "high" as const,
          criterion_id: "forced_continuity",
          description: "Auto-renew disclosure rendered at 10px in footer.",
          location: "footer column 3",
          recommendation: "Surface auto-renew terms next to the CTA.",
        },
      ],
      overall_score: 5,
      summary: "Strong aesthetic but a forced-continuity dark pattern lowers trust.",
      dom: { interactive_count: 12, headings: ["h1: Plans"], summary: "[Headings]\nh1: Plans" },
      console: { errors_count: 0, errors: [] },
      screenshot: {
        path: "/tmp/judges/abc/screenshot.png",
        sha256: "deadbeef",
        width: 1280,
        height: 800,
        bytes: 23456,
      },
      cost_usd: 0.0084,
    };
    expect(() => JudgeResultSchema.parse(full)).not.toThrow();
  });

  it("rejects rubric kind that is not in the enum", () => {
    expect(() =>
      JudgeRubricKindSchema.parse("performance"),
    ).toThrow();
  });

  it("rejects verdict score outside 0..10", () => {
    expect(() =>
      JudgeVerdictSchema.parse({
        criterion_id: "x",
        score: 11,
        rationale: "y",
        evidence: [],
      }),
    ).toThrow();
    expect(() =>
      JudgeVerdictSchema.parse({
        criterion_id: "x",
        score: -1,
        rationale: "y",
        evidence: [],
      }),
    ).toThrow();
  });

  it("rejects criterion spec with empty id or label", () => {
    expect(() =>
      JudgeCriterionSpecSchema.parse({ ...aestheticCriterion, id: "" }),
    ).toThrow();
    expect(() =>
      JudgeCriterionSpecSchema.parse({ ...aestheticCriterion, label: "" }),
    ).toThrow();
  });

  it("rejects finding severity not in the enum", () => {
    expect(() =>
      JudgeFindingSchema.parse({
        severity: "fatal",
        criterion_id: null,
        description: "x",
        recommendation: "y",
      }),
    ).toThrow();
  });

  it("accepts finding with criterion_id explicitly null (cross-cutting)", () => {
    expect(() =>
      JudgeFindingSchema.parse({
        severity: "low" as const,
        criterion_id: null,
        description: "Cross-cutting concern.",
        recommendation: "Investigate.",
      }),
    ).not.toThrow();
  });

  it("rejects negative cost_usd", () => {
    expect(() =>
      JudgeResultSchema.parse({ ...minimalJudge, cost_usd: -0.01 }),
    ).toThrow();
  });

  it("rejects unknown status enum values", () => {
    expect(() =>
      JudgeResultSchema.parse({ ...minimalJudge, status: "loading" }),
    ).toThrow();
  });

  it("accepts overall_score = null when no verdicts can be aggregated", () => {
    expect(() =>
      JudgeResultSchema.parse({ ...minimalJudge, verdicts: [], overall_score: null }),
    ).not.toThrow();
  });

  it("schema_version is optional (legacy fixtures must still validate)", () => {
    const { schema_version: _v, ...rest } = minimalJudge;
    expect(() => JudgeResultSchema.parse(rest)).not.toThrow();
  });
});

describe("result-schema — CompareResultSchema (N-3)", () => {
  const criterion = {
    id: "visual_hierarchy",
    label: "Visual hierarchy",
    description: "Does the layout guide the eye through a clear primary action?",
    kind: "aesthetic" as const,
  };

  const minimalSide = {
    url_input: "https://a.example.com",
    url_final: "https://a.example.com/",
    title: "A",
    judge: null,
    screenshot: null,
    artifacts_dir: "/tmp/compares/abc/a",
  };

  const minimalCompare = {
    schema_version: "1.0.0",
    mode: "double_blind" as const,
    rubrics: ["aesthetic" as const],
    criteria: [criterion],
    started_at: "2026-04-30T10:00:00.000Z",
    finished_at: "2026-04-30T10:00:05.000Z",
    status: "ok" as const,
    side_a: minimalSide,
    side_b: { ...minimalSide, url_input: "https://b.example.com", url_final: "https://b.example.com/", title: "B", artifacts_dir: "/tmp/compares/abc/b" },
    per_criterion: [
      {
        criterion_id: "visual_hierarchy",
        score_a: 7,
        score_b: 5,
        winner: "a" as const,
        rationale: "Side A's CTA is visually dominant; side B's hero is cluttered.",
      },
    ],
    overall_winner: "a" as const,
    summary: null,
    artifacts_dir: "/tmp/compares/abc",
    model: "claude-sonnet-4-6",
    cost_usd: 0,
    duration_ms: 3500,
  };

  it("validates a minimal compare result", () => {
    expect(() => CompareResultSchema.parse(minimalCompare)).not.toThrow();
  });

  it("rejects mode outside the enum", () => {
    expect(() => CompareModeSchema.parse("medium")).toThrow();
  });

  it("rejects winner outside the enum", () => {
    expect(() => CompareWinnerSchema.parse("draw")).toThrow();
  });

  it("accepts per-criterion scores as null in fast mode (model only emitted a winner)", () => {
    const fast = {
      ...minimalCompare,
      mode: "fast" as const,
      per_criterion: [
        {
          criterion_id: "visual_hierarchy",
          score_a: null,
          score_b: null,
          winner: "tie" as const,
          rationale: "Both sides perform comparably.",
        },
      ],
      overall_winner: "tie" as const,
    };
    expect(() => CompareResultSchema.parse(fast)).not.toThrow();
  });

  it("rejects per-criterion score outside 0..10", () => {
    expect(() =>
      CompareCriterionVerdictSchema.parse({
        criterion_id: "x",
        score_a: 11,
        score_b: 5,
        winner: "a",
        rationale: "r",
      }),
    ).toThrow();
  });

  it("validates compare result with embedded judge results on both sides", () => {
    const judgeFixture = {
      schema_version: "1.0.0",
      url_input: "https://a.example.com",
      url_final: "https://a.example.com/",
      title: "A",
      loaded_at: "2026-04-30T10:00:00.000Z",
      status: "ok" as const,
      rubrics: ["aesthetic" as const],
      criteria: [criterion],
      verdicts: [{ criterion_id: "visual_hierarchy", score: 7, rationale: "ok", evidence: [] }],
      findings: [],
      overall_score: 7,
      summary: null,
      dom: null,
      console: null,
      screenshot: null,
      persona_id: "judge-default-desktop",
      artifacts_dir: "/tmp/judges/a",
      model: "claude-sonnet-4-6",
      cost_usd: 0.005,
      duration_ms: 1500,
    };
    const full = {
      ...minimalCompare,
      side_a: { ...minimalSide, judge: judgeFixture },
      side_b: { ...minimalSide, url_input: "https://b.example.com", title: "B", judge: { ...judgeFixture, url_input: "https://b.example.com" } },
    };
    expect(() => CompareResultSchema.parse(full)).not.toThrow();
  });

  it("rejects negative cost_usd", () => {
    expect(() =>
      CompareResultSchema.parse({ ...minimalCompare, cost_usd: -0.01 }),
    ).toThrow();
  });

  it("rejects unknown status enum values", () => {
    expect(() =>
      CompareResultSchema.parse({ ...minimalCompare, status: "loading" }),
    ).toThrow();
  });

  it("schema_version is optional (legacy fixtures must still validate)", () => {
    const { schema_version: _v, ...rest } = minimalCompare;
    expect(() => CompareResultSchema.parse(rest)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// M9-4 — ResultCacheMetaSchema + cache field on primitive envelopes
// ─────────────────────────────────────────────────────────────

import { ResultCacheMetaSchema } from "../src/core/result-schema.js";

describe("result-schema — ResultCacheMetaSchema (M9-4)", () => {
  const validKey = "a".repeat(64);

  it("accepts a minimal hit:false miss", () => {
    expect(() =>
      ResultCacheMetaSchema.parse({ hit: false, age_ms: 0, key: validKey }),
    ).not.toThrow();
  });

  it("accepts a hit with cost_saved_usd", () => {
    expect(() =>
      ResultCacheMetaSchema.parse({
        hit: true,
        age_ms: 12345,
        key: validKey,
        cost_saved_usd: 0.0123,
      }),
    ).not.toThrow();
  });

  it("rejects a non-hex key", () => {
    expect(() =>
      ResultCacheMetaSchema.parse({ hit: false, age_ms: 0, key: "not-hex" }),
    ).toThrow();
  });

  it("rejects a key with wrong length", () => {
    expect(() =>
      ResultCacheMetaSchema.parse({ hit: false, age_ms: 0, key: "abc" }),
    ).toThrow();
  });

  it("rejects negative age_ms", () => {
    expect(() =>
      ResultCacheMetaSchema.parse({ hit: false, age_ms: -1, key: validKey }),
    ).toThrow();
  });

  it("rejects negative cost_saved_usd", () => {
    expect(() =>
      ResultCacheMetaSchema.parse({
        hit: true,
        age_ms: 0,
        key: validKey,
        cost_saved_usd: -0.01,
      }),
    ).toThrow();
  });
});

describe("result-schema — primitive envelopes accept optional cache", () => {
  const validKey = "f".repeat(64);
  const cacheHit = { hit: true, age_ms: 1500, key: validKey, cost_saved_usd: 0.005 };
  const cacheMiss = { hit: false, age_ms: 0, key: validKey };

  it("SeeResultSchema accepts cache on hit and miss", () => {
    const base = {
      url_input: "https://example.com",
      url_final: "https://example.com/",
      title: "Example",
      loaded_at: "2026-04-30T08:00:00.000Z",
      status: "ok" as const,
      dom: null,
      console: null,
      screenshot: null,
      note: null,
      persona_id: "us-desktop",
      artifacts_dir: "/tmp/sees/x",
      cost_usd: 0,
      duration_ms: 1,
    };
    expect(() => SeeResultSchema.parse({ ...base, cache: cacheHit })).not.toThrow();
    expect(() => SeeResultSchema.parse({ ...base, cache: cacheMiss })).not.toThrow();
    // cache is optional — absence still validates
    expect(() => SeeResultSchema.parse(base)).not.toThrow();
  });

  it("ActResultSchema accepts cache (envelope uniformity even though act never sets hit:true)", () => {
    const base = {
      url_input: "https://example.com",
      url_final: "https://example.com/",
      title: "Example",
      started_at: "2026-04-30T08:00:00.000Z",
      finished_at: "2026-04-30T08:00:01.000Z",
      status: "ok" as const,
      engine: "playwright" as const,
      steps: [],
      dom: null,
      console: null,
      screenshot: null,
      persona_id: "us-desktop",
      artifacts_dir: "/tmp/acts/x",
      cost_usd: 0,
      duration_ms: 1,
    };
    expect(() => ActResultSchema.parse({ ...base, cache: cacheMiss })).not.toThrow();
    expect(() => ActResultSchema.parse(base)).not.toThrow();
  });

  it("ExtractResultSchema accepts cache on hit and miss", () => {
    const base = {
      url_input: "https://example.com",
      url_final: "https://example.com/",
      title: "Example",
      loaded_at: "2026-04-30T08:00:00.000Z",
      status: "ok" as const,
      engine: "stagehand" as const,
      data: { name: "x" },
      dom: null,
      console: null,
      screenshot: null,
      persona_id: "us-desktop",
      artifacts_dir: "/tmp/extracts/x",
      cost_usd: 0,
      duration_ms: 1,
    };
    expect(() => ExtractResultSchema.parse({ ...base, cache: cacheHit })).not.toThrow();
    expect(() => ExtractResultSchema.parse(base)).not.toThrow();
  });

  it("JudgeResultSchema accepts cache on hit and miss", () => {
    const base = {
      url_input: "https://example.com",
      url_final: "https://example.com/",
      title: "Example",
      loaded_at: "2026-04-30T08:00:00.000Z",
      status: "ok" as const,
      rubrics: ["aesthetic" as const],
      criteria: [],
      verdicts: [],
      findings: [],
      overall_score: null,
      summary: null,
      dom: null,
      console: null,
      screenshot: null,
      persona_id: "judge-default-desktop",
      artifacts_dir: "/tmp/judges/x",
      model: "claude-sonnet-4-6",
      cost_usd: 0,
      duration_ms: 1,
    };
    expect(() => JudgeResultSchema.parse({ ...base, cache: cacheHit })).not.toThrow();
    expect(() => JudgeResultSchema.parse(base)).not.toThrow();
  });

  it("CompareResultSchema accepts cache on synthesis call", () => {
    const sideA = {
      url_input: "https://a.example.com",
      url_final: "https://a.example.com/",
      title: "A",
      judge: null,
      screenshot: null,
      artifacts_dir: "/tmp/compares/x/a",
    };
    const base = {
      mode: "double_blind" as const,
      rubrics: ["aesthetic" as const],
      criteria: [],
      started_at: "2026-04-30T08:00:00.000Z",
      finished_at: "2026-04-30T08:00:05.000Z",
      status: "ok" as const,
      side_a: sideA,
      side_b: { ...sideA, url_input: "https://b.example.com", url_final: "https://b.example.com/", title: "B", artifacts_dir: "/tmp/compares/x/b" },
      per_criterion: [],
      overall_winner: "tie" as const,
      summary: null,
      artifacts_dir: "/tmp/compares/x",
      model: "claude-sonnet-4-6",
      cost_usd: 0,
      duration_ms: 1,
    };
    expect(() => CompareResultSchema.parse({ ...base, cache: cacheHit })).not.toThrow();
    expect(() => CompareResultSchema.parse(base)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// M9-5 — list_capabilities envelope schemas
// ─────────────────────────────────────────────────────────────

import {
  CostEstimateSchema,
  ToolSideEffectSchema,
  ToolRequirementsSchema,
  ToolCapabilitySchema,
  EnvVarDocSchema,
  CacheInfoSchema,
  ListCapabilitiesResultSchema,
} from "../src/core/result-schema.js";

describe("result-schema — CostEstimateSchema (M9-5)", () => {
  it("accepts a typical estimate with all fields", () => {
    expect(() =>
      CostEstimateSchema.parse({
        typical: 0.02,
        min: 0.01,
        max: 0.06,
        unit: "per_call",
        notes: "1 vision call",
      }),
    ).not.toThrow();
  });

  it("accepts an estimate without notes", () => {
    expect(() =>
      CostEstimateSchema.parse({ typical: 0, min: 0, max: 0, unit: "per_call" }),
    ).not.toThrow();
  });

  it("rejects negative numbers", () => {
    expect(() =>
      CostEstimateSchema.parse({ typical: -0.01, min: 0, max: 0, unit: "per_call" }),
    ).toThrow();
  });

  it("rejects an unknown unit", () => {
    expect(() =>
      CostEstimateSchema.parse({
        typical: 0,
        min: 0,
        max: 0,
        unit: "per_galaxy",
      }),
    ).toThrow();
  });
});

describe("result-schema — ToolSideEffectSchema (M9-5)", () => {
  it.each([
    "navigation",
    "state_changing",
    "fs_writes_artifacts",
    "fs_writes_history",
    "fs_reads",
    "network_egress",
  ])("accepts %s", (kind) => {
    expect(() => ToolSideEffectSchema.parse(kind)).not.toThrow();
  });

  it("rejects an unknown effect", () => {
    expect(() => ToolSideEffectSchema.parse("blow_up_universe")).toThrow();
  });
});

describe("result-schema — ToolRequirementsSchema (M9-5)", () => {
  it("accepts a minimal requirement (api_keys + browser only)", () => {
    expect(() =>
      ToolRequirementsSchema.parse({ api_keys: [], browser: false }),
    ).not.toThrow();
  });

  it("accepts the full shape", () => {
    expect(() =>
      ToolRequirementsSchema.parse({
        api_keys: ["ANTHROPIC_API_KEY"],
        browser: true,
        personas_dir: true,
        scenarios_dir: false,
      }),
    ).not.toThrow();
  });

  it("rejects when api_keys contains a non-string", () => {
    expect(() =>
      ToolRequirementsSchema.parse({ api_keys: [42 as unknown as string], browser: true }),
    ).toThrow();
  });
});

describe("result-schema — ToolCapabilitySchema (M9-5)", () => {
  const minimalCap = {
    name: "see",
    description: "look at a URL",
    kind: "primitive" as const,
    input_schema: { type: "object", properties: { url: { type: "string" } } },
    cacheable: true,
    cost_estimate_usd: { typical: 0, min: 0, max: 0.005, unit: "per_call" as const },
    side_effects: ["navigation", "fs_writes_artifacts"] as const,
    requires: { api_keys: [], browser: true },
  };

  it("accepts a minimal primitive capability", () => {
    expect(() => ToolCapabilitySchema.parse(minimalCap)).not.toThrow();
  });

  it("accepts result_schema when set", () => {
    expect(() =>
      ToolCapabilitySchema.parse({ ...minimalCap, result_schema: "SeeResult" }),
    ).not.toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      ToolCapabilitySchema.parse({ ...minimalCap, kind: "weird" }),
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => ToolCapabilitySchema.parse({ ...minimalCap, name: "" })).toThrow();
  });

  it("rejects when cacheable is missing", () => {
    const { cacheable: _ignored, ...withoutCacheable } = minimalCap;
    expect(() => ToolCapabilitySchema.parse(withoutCacheable)).toThrow();
  });
});

describe("result-schema — EnvVarDocSchema (M9-5)", () => {
  const minimalDoc = {
    name: "ANTHROPIC_API_KEY",
    description: "Anthropic API key",
    scope: "auth" as const,
    default: "",
    required: true,
  };

  it("accepts a minimal entry", () => {
    expect(() => EnvVarDocSchema.parse(minimalDoc)).not.toThrow();
  });

  it.each(["auth", "cache", "cost_guard", "artifacts", "logging", "memory", "reports"])(
    "accepts scope %s",
    (scope) => {
      expect(() => EnvVarDocSchema.parse({ ...minimalDoc, scope })).not.toThrow();
    },
  );

  it("rejects an unknown scope", () => {
    expect(() => EnvVarDocSchema.parse({ ...minimalDoc, scope: "weather" })).toThrow();
  });
});

describe("result-schema — CacheInfoSchema (M9-5)", () => {
  it("accepts a populated entry", () => {
    expect(() =>
      CacheInfoSchema.parse({
        enabled: true,
        ttl_ms_default: 86400000,
        path: "/tmp/cache.db",
      }),
    ).not.toThrow();
  });

  it("rejects negative ttl", () => {
    expect(() =>
      CacheInfoSchema.parse({ enabled: true, ttl_ms_default: -1, path: "/tmp/cache.db" }),
    ).toThrow();
  });
});

describe("result-schema — ListCapabilitiesResultSchema (M9-5)", () => {
  const minimalCap = {
    name: "list_personas",
    description: "...",
    kind: "meta" as const,
    input_schema: { type: "object", properties: {} },
    cacheable: false,
    cost_estimate_usd: { typical: 0, min: 0, max: 0, unit: "per_call" as const },
    side_effects: ["fs_reads"] as const,
    requires: { api_keys: [], browser: false },
  };

  const minimalEnvelope = {
    schema_version: "1.2.0",
    server: { name: "pixelcheck", version: "1.0.1" },
    result_schema_version: "1.2.0",
    tools: [minimalCap],
    env: [
      {
        name: "ANTHROPIC_API_KEY",
        description: "Anthropic API key",
        scope: "auth" as const,
        default: "",
        required: true,
      },
    ],
    cache: { enabled: true, ttl_ms_default: 86400000, path: "/tmp/cache.db" },
  };

  it("accepts a minimal envelope", () => {
    expect(() => ListCapabilitiesResultSchema.parse(minimalEnvelope)).not.toThrow();
  });

  it("accepts an envelope with no tools and no env (lower-bound shape)", () => {
    expect(() =>
      ListCapabilitiesResultSchema.parse({ ...minimalEnvelope, tools: [], env: [] }),
    ).not.toThrow();
  });

  it("rejects when result_schema_version is missing", () => {
    const broken: Record<string, unknown> = { ...minimalEnvelope };
    delete broken.result_schema_version;
    expect(() => ListCapabilitiesResultSchema.parse(broken)).toThrow();
  });

  it("rejects when cache field is missing", () => {
    const broken: Record<string, unknown> = { ...minimalEnvelope };
    delete broken.cache;
    expect(() => ListCapabilitiesResultSchema.parse(broken)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// DiagnosticsSchema (ADR-034 — Phase 0 multi-dimensional envelope)
// ─────────────────────────────────────────────────────────────

describe("result-schema — DiagnosticsSchema (ADR-034)", () => {
  it("accepts an empty diagnostics object — collected_at defaults to 'always'", () => {
    const parsed = DiagnosticsSchema.parse({});
    expect(parsed.collected_at).toBe("always");
    expect(parsed.popups).toBeUndefined();
    expect(parsed.network).toBeUndefined();
    expect(parsed.cookies).toBeUndefined();
    expect(parsed.storage).toBeUndefined();
    expect(parsed.performance).toBeUndefined();
    expect(parsed.visual).toBeUndefined();
  });

  it("accepts collected_at: 'on_failure'", () => {
    const parsed = DiagnosticsSchema.parse({ collected_at: "on_failure" });
    expect(parsed.collected_at).toBe("on_failure");
  });

  it("rejects collected_at outside the enum", () => {
    expect(() =>
      DiagnosticsSchema.parse({ collected_at: "sometimes" }),
    ).toThrow();
  });

  it("accepts a populated envelope (all 6 sub-fields present)", () => {
    const full = {
      collected_at: "always" as const,
      popups: [
        {
          index: 0,
          url: "https://accounts.google.com/",
          title: "Google",
          body_text: "Sign in",
          closed: false,
        },
      ],
      network: {
        request_count: 42,
        failure_count: 1,
        requests: [],
        failures: [],
      },
      cookies: [
        {
          name: "session",
          value: "[REDACTED]",
          domain: "example.com",
          path: "/",
          expires: -1,
          http_only: true,
          secure: true,
        },
      ],
      storage: {
        local_storage: {},
        session_storage: {},
        local_storage_keys: 3,
        session_storage_keys: 0,
      },
      // performance concrete (PR-C); visual concrete (PR-D)
      performance: {
        lcp_ms: 1234,
        cls: 0.03,
        inp_ms: 80,
        fcp_ms: 720,
        ttfb_ms: 200,
        dom_content_loaded_ms: 850,
        load_ms: 1900,
        resources: { total: 47, script: 12, stylesheet: 3, image: 22, xhr_or_fetch: 5 },
        transfer_bytes: 482_311,
        window_ms: 5400,
      },
      visual: {
        scored: true,
        rubrics: ["aesthetic" as const],
        verdicts: [
          {
            criterion_id: "visual_hierarchy",
            label: "Visual hierarchy",
            kind: "aesthetic" as const,
            score: 8.5,
            rationale: "Headline dominates above the fold.",
            evidence: ["H1: 'Welcome'"],
          },
        ],
        findings: [],
        overall_score: 8.5,
        summary: "Strong hierarchy, minor density issues below fold.",
        model: "claude-sonnet-4-6",
        cost_usd: 0.012,
        duration_ms: 1840,
      },
    };
    const parsed = DiagnosticsSchema.parse(full);
    expect(parsed.popups).toHaveLength(1);
    expect(parsed.network?.request_count).toBe(42);
    expect(parsed.cookies).toHaveLength(1);
    expect(parsed.storage?.local_storage_keys).toBe(3);
    expect(parsed.performance?.lcp_ms).toBe(1234);
    expect(parsed.performance?.resources.total).toBe(47);
    expect(parsed.visual?.scored).toBe(true);
    expect(parsed.visual?.verdicts).toHaveLength(1);
    expect(parsed.visual?.overall_score).toBe(8.5);
    expect(parsed.visual?.verdicts[0]?.criterion_id).toBe("visual_hierarchy");
  });

  it("PopupSnapshotSchema: requires concrete fields per PR-B shape (index/url/title/body_text/closed)", () => {
    expect(() =>
      PopupSnapshotSchema.parse({
        index: 0,
        url: "https://x.com",
        title: "X",
        body_text: "page body",
        closed: false,
      }),
    ).not.toThrow();
    expect(() =>
      PopupSnapshotSchema.parse({
        index: 1,
        url: "",
        title: "",
        body_text: "",
        closed: true,
        last_seen_url: "https://accounts.google.com/oauth/...",
        last_seen_title: "Google Sign-In",
      }),
    ).not.toThrow();
  });

  it("PopupSnapshotSchema: rejects missing required fields", () => {
    expect(() => PopupSnapshotSchema.parse({})).toThrow();
    expect(() => PopupSnapshotSchema.parse({ index: 0 })).toThrow();
  });

  it("NetworkLogSchema requires concrete fields per PR-B shape", () => {
    expect(() =>
      NetworkLogSchema.parse({
        request_count: 0,
        failure_count: 0,
        requests: [],
        failures: [],
      }),
    ).not.toThrow();
    expect(() =>
      NetworkLogSchema.parse({
        request_count: 2,
        failure_count: 1,
        requests: [
          {
            url: "https://example.com/",
            method: "GET",
            resource_type: "document",
            status: 200,
            duration_ms: 123,
            size_bytes: 456,
          },
        ],
        failures: [
          {
            url: "https://broken.example/",
            method: "GET",
            error_text: "net::ERR_NAME_NOT_RESOLVED",
          },
        ],
      }),
    ).not.toThrow();
    expect(() => NetworkLogSchema.parse({})).toThrow();
    expect(() =>
      NetworkLogSchema.parse({ request_count: 0, failure_count: 0 }),
    ).toThrow();
  });

  it("CookieSchema requires full Playwright Cookie shape", () => {
    expect(() =>
      CookieSchema.parse({
        name: "session",
        value: "[REDACTED]",
        domain: "example.com",
        path: "/",
        expires: -1,
        http_only: true,
        secure: true,
        same_site: "Strict",
      }),
    ).not.toThrow();
    expect(() =>
      CookieSchema.parse({
        name: "x",
        value: "y",
        domain: "x.com",
        path: "/",
        expires: 1234567890,
        http_only: false,
        secure: false,
      }),
    ).not.toThrow();
    expect(() => CookieSchema.parse({ name: "session" })).toThrow();
  });

  it("StorageSnapshotSchema requires concrete fields", () => {
    expect(() =>
      StorageSnapshotSchema.parse({
        local_storage: {},
        session_storage: {},
        local_storage_keys: 0,
        session_storage_keys: 0,
      }),
    ).not.toThrow();
    expect(() =>
      StorageSnapshotSchema.parse({
        local_storage: { theme: "dark", auth_token: "[REDACTED]" },
        session_storage: { ab_variant: "B" },
        local_storage_keys: 2,
        session_storage_keys: 1,
      }),
    ).not.toThrow();
    expect(() => StorageSnapshotSchema.parse({})).toThrow();
  });

  it("PerformanceMetricsSchema requires concrete Web Vitals shape (PR-C)", () => {
    // Empty page-load — every Web Vital is nullable, but resources +
    // transfer_bytes + window_ms are required.
    expect(() =>
      PerformanceMetricsSchema.parse({
        lcp_ms: null,
        cls: null,
        inp_ms: null,
        fcp_ms: null,
        ttfb_ms: null,
        dom_content_loaded_ms: null,
        load_ms: null,
        resources: { total: 0, script: 0, stylesheet: 0, image: 0, xhr_or_fetch: 0 },
        transfer_bytes: 0,
        window_ms: 0,
      }),
    ).not.toThrow();
    // Realistic page
    expect(() =>
      PerformanceMetricsSchema.parse({
        lcp_ms: 1234,
        cls: 0.05,
        inp_ms: 80,
        fcp_ms: 720,
        ttfb_ms: 200,
        dom_content_loaded_ms: 850,
        load_ms: 1900,
        resources: { total: 47, script: 12, stylesheet: 3, image: 22, xhr_or_fetch: 5 },
        transfer_bytes: 482_311,
        window_ms: 5400,
      }),
    ).not.toThrow();
    // Missing required fields should fail
    expect(() => PerformanceMetricsSchema.parse({})).toThrow();
    expect(() =>
      PerformanceMetricsSchema.parse({ lcp_ms: 1234 }),
    ).toThrow();
    // resources sub-shape required
    expect(() =>
      PerformanceMetricsSchema.parse({
        lcp_ms: null,
        cls: null,
        inp_ms: null,
        fcp_ms: null,
        ttfb_ms: null,
        dom_content_loaded_ms: null,
        load_ms: null,
        resources: { total: 0 },
        transfer_bytes: 0,
        window_ms: 0,
      }),
    ).toThrow();
  });

  it("VisualScoringSchema: requires concrete fields per PR-D shape (scored/verdicts/findings/overall_score/summary)", () => {
    // Successful scoring envelope round-trips with verdicts populated.
    expect(() =>
      VisualScoringSchema.parse({
        scored: true,
        rubrics: ["aesthetic"],
        verdicts: [
          {
            criterion_id: "visual_hierarchy",
            label: "Visual hierarchy",
            kind: "aesthetic",
            score: 7.5,
            rationale: "Above-fold headline reads first.",
            evidence: [],
          },
        ],
        findings: [],
        overall_score: 7.5,
        summary: "Solid hierarchy.",
        cost_usd: 0.011,
        duration_ms: 1700,
      }),
    ).not.toThrow();

    // Skip envelope: scored=false + skip_reason, no verdicts required.
    expect(() =>
      VisualScoringSchema.parse({
        scored: false,
        skip_reason: "config_off",
        rubrics: [],
        verdicts: [],
        findings: [],
        overall_score: null,
        summary: null,
        cost_usd: 0,
        duration_ms: 0,
      }),
    ).not.toThrow();

    // The placeholder shape (empty object / random pass-through fields) is
    // no longer accepted now that the schema is concrete.
    expect(() => VisualScoringSchema.parse({})).toThrow();
    expect(() => VisualScoringSchema.parse({ layout_score: 9.2 })).toThrow();

    // Score range enforced.
    expect(() =>
      VisualScoringSchema.parse({
        scored: true,
        rubrics: ["aesthetic"],
        verdicts: [
          {
            criterion_id: "visual_hierarchy",
            label: "Visual hierarchy",
            kind: "aesthetic",
            score: 11, // out of range
            rationale: "x",
            evidence: [],
          },
        ],
        findings: [],
        overall_score: null,
        summary: null,
        cost_usd: 0,
        duration_ms: 0,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Backward compatibility: 4 primitive results still parse WITHOUT diagnostics
// (pre-1.3.0 producers must continue to be valid v1.3.0 payloads)
// ─────────────────────────────────────────────────────────────

describe("result-schema — primitive backward compat (no diagnostics field)", () => {
  const minimalSee = {
    schema_version: "1.2.0",
    url_input: "https://example.com",
    url_final: "https://example.com",
    title: "Example",
    loaded_at: "2026-05-04T00:00:00.000Z",
    status: "ok" as const,
    dom: null,
    console: null,
    screenshot: null,
    note: null,
    persona_id: "default",
    artifacts_dir: "/tmp/x",
    cost_usd: 0,
    duration_ms: 100,
  };

  it("SeeResult parses without diagnostics (v1.2.x payload)", () => {
    const parsed = SeeResultSchema.parse(minimalSee);
    expect(parsed.diagnostics).toBeUndefined();
  });

  it("SeeResult parses WITH diagnostics (v1.3.x payload)", () => {
    const withDiag = {
      ...minimalSee,
      diagnostics: { collected_at: "always" as const },
    };
    const parsed = SeeResultSchema.parse(withDiag);
    expect(parsed.diagnostics?.collected_at).toBe("always");
  });

  it("ActResult parses with diagnostics field optional", () => {
    const minimalAct = {
      schema_version: "1.2.0",
      url_input: "https://example.com",
      url_final: "https://example.com",
      title: "Example",
      started_at: "2026-05-04T00:00:00.000Z",
      finished_at: "2026-05-04T00:00:01.000Z",
      status: "ok" as const,
      engine: "playwright" as const,
      steps: [],
      dom: null,
      console: null,
      screenshot: null,
      persona_id: "default",
      artifacts_dir: "/tmp/x",
      cost_usd: 0,
      duration_ms: 1000,
    };
    expect(() => ActResultSchema.parse(minimalAct)).not.toThrow();
    expect(() =>
      ActResultSchema.parse({ ...minimalAct, diagnostics: {} }),
    ).not.toThrow();
  });

  it("ExtractResult parses with diagnostics field optional", () => {
    const minimalExtract = {
      schema_version: "1.2.0",
      url_input: "https://example.com",
      url_final: "https://example.com",
      title: "Example",
      loaded_at: "2026-05-04T00:00:00.000Z",
      status: "ok" as const,
      engine: "stagehand" as const,
      data: { foo: "bar" },
      dom: null,
      console: null,
      screenshot: null,
      persona_id: "default",
      artifacts_dir: "/tmp/x",
      cost_usd: 0,
      duration_ms: 100,
    };
    expect(() => ExtractResultSchema.parse(minimalExtract)).not.toThrow();
    expect(() =>
      ExtractResultSchema.parse({ ...minimalExtract, diagnostics: {} }),
    ).not.toThrow();
  });

  it("CompareResult parses with diagnostics field optional", () => {
    const minimalSide = {
      url_input: "https://a.example",
      url_final: "https://a.example",
      title: "A",
      judge: null,
      screenshot: null,
      artifacts_dir: "/tmp/a",
    };
    const minimalCompare = {
      schema_version: "1.2.0",
      mode: "fast" as const,
      rubrics: ["aesthetic" as const],
      criteria: [],
      started_at: "2026-05-04T00:00:00.000Z",
      finished_at: "2026-05-04T00:00:01.000Z",
      status: "ok" as const,
      side_a: minimalSide,
      side_b: { ...minimalSide, url_input: "https://b.example", title: "B" },
      per_criterion: [],
      overall_winner: "tie" as const,
      summary: null,
      artifacts_dir: "/tmp/x",
      model: "claude-sonnet-4-6",
      cost_usd: 0,
      duration_ms: 1000,
    };
    expect(() => CompareResultSchema.parse(minimalCompare)).not.toThrow();
    expect(() =>
      CompareResultSchema.parse({ ...minimalCompare, diagnostics: {} }),
    ).not.toThrow();
  });
});
