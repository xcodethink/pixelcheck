/**
 * M1-5 — Sample-driven Ajv validation + public surface snapshot.
 *
 * The Draft-7 validity tests in `tests/public-api-contract.test.ts` only
 * verify that each shipped schema *compiles* under Ajv. This file goes a
 * step further: every schema gets at least one minimally-conformant
 * sample object, validated through Ajv (the validator external SDK
 * consumers will actually run), AND a deliberate violation that Ajv
 * MUST reject. This catches the failure mode where a schema compiles
 * but doesn't actually constrain anything.
 *
 * Samples are copied verbatim from `tests/result-schema.test.ts` so they
 * are guaranteed to pass under Zod (the in-process source of truth) —
 * the contract under test here is "what Zod accepts, Ajv accepts too",
 * which closes the loop between in-process producer and external SDK
 * consumer.
 *
 * Plus the public-surface snapshot: the runtime export set of
 * `src/index.ts` is pinned so accidental additions or removals trip a
 * deliberate review checkpoint (per ADR-007 §"Public API SemVer").
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type AnySchemaObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import * as lib from "../src/index.js";
import { RESULT_SCHEMA_VERSION } from "../src/core/result-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, "../docs/schemas");

function loadSchema(slug: string): AnySchemaObject {
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMAS_DIR, `${slug}.schema.json`), "utf8"),
  ) as AnySchemaObject;
}

function compile(slug: string): ValidateFunction {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(loadSchema(slug));
}

// Helper: run Ajv validation and surface errors when the assertion fails,
// otherwise the failures are uninspectable.
function expectAjvAccepts(slug: string, sample: unknown): void {
  const validate = compile(slug);
  const ok = validate(sample);
  if (!ok) {
    throw new Error(
      `${slug} expected valid sample to validate, got errors: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
  expect(ok).toBe(true);
}

function expectAjvRejects(slug: string, sample: unknown): void {
  const validate = compile(slug);
  expect(validate(sample)).toBe(false);
  expect(validate.errors).not.toBeNull();
  expect((validate.errors ?? []).length).toBeGreaterThan(0);
}

// ─────────────────────────────────────────────────────────────
// Public surface snapshot
// ─────────────────────────────────────────────────────────────

const EXPECTED_RUNTIME_EXPORTS = [
  "ActStepSchema",
  "AgentConfigSchema",
  "AgentEventBus",
  "AllProvidersFailedError",
  "AnthropicProvider",
  "AssertA11yStepSchema",
  "AssertDomStepSchema",
  "AssertVisualStepSchema",
  "CheckEmailStepSchema",
  "ComputerUseStepSchema",
  "CustomStepSchema",
  "DEFAULT_LOCALE",
  "DEFAULT_RETRY_STRATEGY",
  "ExtractStepSchema",
  "FallbackLLMProvider",
  "HintSchema",
  "ObserveStepSchema",
  "OllamaApiError",
  "OllamaConnectionError",
  "OllamaProvider",
  "PersonaSchema",
  "ProgressReporter",
  "ProjectConfigSchema",
  "SUPPORTED_LOCALES",
  "ScenarioSchema",
  "ScoringDimensionEnum",
  "ScreenshotStepSchema",
  "StepSchema",
  "SuccessCriterionSchema",
  "VisitStepSchema",
  "WCAG_CATALOG",
  "WaitForStepSchema",
  "act",
  "attachConsoleLogger",
  "buildExecutionMatrix",
  "canResume",
  "clearCheckpoint",
  "compare",
  "computeBackoff",
  "computeSummary",
  "createProvider",
  "detectCiEnvironment",
  "diagnose",
  "diffRuns",
  "extract",
  "extractDomSummary",
  "findWcagCriterion",
  "formatDomSummary",
  "formatRunsCount",
  "generateMutations",
  "isTTY",
  "isWcagIssue",
  "judge",
  "loadCheckpoint",
  "loadHistory",
  "loadPersonas",
  "loadProjectConfig",
  "loadScenarios",
  "normaliseLocale",
  "parseAxeTags",
  "renderDiffHtml",
  "renderDiffJson",
  "renderDiffMarkdown",
  "renderDiffText",
  "renderPdfHtml",
  "renderTrendsHtml",
  "resolvePersonaSecrets",
  "runAudit",
  "saveAuditToHistory",
  "saveCheckpoint",
  "see",
  "substituteTemplate",
  "summarizeWcag",
  "t",
  "waitForPageStable",
  "wcagHelpUrl",
  "wcagSarifRuleId",
  "withRetry",
  "writeDiffReport",
  "writeGithubAnnotationsReport",
  "writeHtmlReport",
  "writeJsonLinesReport",
  "writeJsonReport",
  "writeJunitXmlReport",
  "writeMarkdownSummary",
  "writePdfReport",
  "writeSarifReport",
  "writeSpaReport",
  "writeTrendsDashboard",
] as const;

describe("public surface snapshot — src/index.ts", () => {
  it("exports the exact known set of runtime symbols (review checkpoint on add/remove)", () => {
    const actual = Object.keys(lib).sort();
    expect(actual).toEqual([...EXPECTED_RUNTIME_EXPORTS]);
  });

  it("ships exactly 89 runtime exports (bump this when intentionally adding a public symbol)", () => {
    expect(Object.keys(lib)).toHaveLength(89);
  });

  const functionExports: Array<keyof typeof lib> = [
    "act",
    "attachConsoleLogger",
    "buildExecutionMatrix",
    "compare",
    "computeSummary",
    "detectCiEnvironment",
    "diagnose",
    "diffRuns",
    "extract",
    "extractDomSummary",
    "findWcagCriterion",
    "formatDomSummary",
    "formatRunsCount",
    "generateMutations",
    "isWcagIssue",
    "judge",
    "loadHistory",
    "loadPersonas",
    "loadProjectConfig",
    "loadScenarios",
    "normaliseLocale",
    "parseAxeTags",
    "renderDiffHtml",
    "renderDiffJson",
    "renderDiffMarkdown",
    "renderDiffText",
    "renderPdfHtml",
    "renderTrendsHtml",
    "resolvePersonaSecrets",
    "runAudit",
    "saveAuditToHistory",
    "see",
    "substituteTemplate",
    "summarizeWcag",
    "t",
    "waitForPageStable",
    "wcagHelpUrl",
    "wcagSarifRuleId",
    "writeDiffReport",
    "writeGithubAnnotationsReport",
    "writeHtmlReport",
    "writeJsonLinesReport",
    "writeJsonReport",
    "writeJunitXmlReport",
    "writeMarkdownSummary",
    "writePdfReport",
    "writeSarifReport",
    "writeSpaReport",
    "writeTrendsDashboard",
  ];
  for (const name of functionExports) {
    it(`exports a function: ${String(name)}`, () => {
      expect(typeof lib[name]).toBe("function");
    });
  }

  it("AgentEventBus is a constructor", () => {
    expect(typeof lib.AgentEventBus).toBe("function");
    expect(() => new lib.AgentEventBus()).not.toThrow();
  });

  const schemaExports = [
    "ActStepSchema",
    "AgentConfigSchema",
    "AssertA11yStepSchema",
    "AssertDomStepSchema",
    "AssertVisualStepSchema",
    "CheckEmailStepSchema",
    "ComputerUseStepSchema",
    "CustomStepSchema",
    "ExtractStepSchema",
    "HintSchema",
    "ObserveStepSchema",
    "PersonaSchema",
    "ProjectConfigSchema",
    "ScenarioSchema",
    "ScoringDimensionEnum",
    "ScreenshotStepSchema",
    "StepSchema",
    "SuccessCriterionSchema",
    "VisitStepSchema",
    "WaitForStepSchema",
  ] as const;
  for (const name of schemaExports) {
    it(`exports a Zod schema: ${name}`, () => {
      const schema = lib[name] as { parse?: unknown; safeParse?: unknown };
      expect(typeof schema.parse).toBe("function");
      expect(typeof schema.safeParse).toBe("function");
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Sample fixtures — minimal-yet-conformant for every published schema.
// Copied from tests/result-schema.test.ts so they are guaranteed to be
// what Zod produces and accepts; validating them under Ajv closes the
// "Zod accepts ⇒ Ajv accepts" half of the contract (rejection tests
// close the other half).
// ─────────────────────────────────────────────────────────────

const SV = RESULT_SCHEMA_VERSION;

const stepResult = {
  step_id: "v1",
  step_type: "visit",
  status: "pass" as const,
  duration_ms: 200,
  retries_used: 0,
};

const dimensionScore = {
  dimension: "completion",
  score: 8.5,
  justification: "Flow completed.",
};

const issue = {
  severity: "low" as const,
  description: "x",
  recommendation: "y",
};

const consoleError = {
  type: "pageerror" as const,
  text: "ReferenceError: foo",
  timestamp: "2026-04-30T08:00:00.000Z",
};

const personaSummary = {
  id: "u1",
  display_name: "Tester",
  country: "JP",
  language: "ja",
  device: "desktop" as const,
  payment_tier: "free" as const,
};

const minimalProjectConfig = {
  project_name: "test",
  base_url: "https://example.com",
  default_concurrency: 1,
  default_timeout_ms: 30000,
  models: {
    default: "claude-sonnet-4-6",
    critic: "claude-sonnet-4-6",
    computer_use: "claude-opus-4-6",
    planner: "claude-opus-4-6",
    navigator: "claude-sonnet-4-6",
    replan: "claude-sonnet-4-6",
    navigator_economy: "claude-haiku-4-5-20251001",
  },
  cost_mode: "balanced" as const,
  budget_usd: 3,
  redact_patterns: [],
};

const scenarioRunResult = {
  scenario_id: "s1",
  scenario_name: "S",
  persona_id: "p1",
  persona_display_name: "P",
  started_at: "2026-04-27T12:00:00.000Z",
  finished_at: "2026-04-27T12:00:01.000Z",
  duration_ms: 1000,
  status: "pass" as const,
  fingerprint_id: "fp",
  steps: [stepResult],
  scores: [dimensionScore],
  overall_score: 9,
  issues: [],
  artifacts: {},
  cost_usd: 0,
};

const minimalAuditRun = {
  schema_version: SV,
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
  config: minimalProjectConfig,
};

const minimalSee = {
  schema_version: SV,
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

const minimalAct = {
  schema_version: SV,
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

const minimalExtract = {
  schema_version: SV,
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

const aestheticCriterion = {
  id: "visual_hierarchy",
  label: "Visual Hierarchy",
  description: "How clearly the page directs attention.",
  kind: "aesthetic" as const,
};

const minimalJudge = {
  schema_version: SV,
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
  duration_ms: 1000,
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
  schema_version: SV,
  mode: "double_blind" as const,
  rubrics: ["aesthetic" as const],
  criteria: [aestheticCriterion],
  started_at: "2026-04-30T10:00:00.000Z",
  finished_at: "2026-04-30T10:00:05.000Z",
  status: "ok" as const,
  side_a: minimalSide,
  side_b: {
    ...minimalSide,
    url_input: "https://b.example.com",
    url_final: "https://b.example.com/",
    title: "B",
    artifacts_dir: "/tmp/compares/abc/b",
  },
  per_criterion: [
    {
      criterion_id: "visual_hierarchy",
      score_a: 7,
      score_b: 5,
      winner: "a" as const,
      rationale: "Side A clearer.",
    },
  ],
  overall_winner: "a" as const,
  summary: null,
  artifacts_dir: "/tmp/compares/abc",
  model: "claude-sonnet-4-6",
  cost_usd: 0,
  duration_ms: 5000,
};

const minimalDiagnose = {
  schema_version: SV,
  url_input: "https://target.example/",
  url_final: "https://target.example/",
  title: "Target",
  loaded_at: "2026-04-30T10:00:00.000Z",
  status: "ok" as const,
  executive_summary: "Page is healthy with one medium contrast issue.",
  overall_health_score: 88,
  dimension_scores: [
    {
      dimension: "visual" as const,
      score: 85,
      finding_counts: { critical: 0, high: 0, medium: 1, low: 0 },
      summary: "1 finding (0C/0H/1M/0L).",
    },
  ],
  findings: [
    {
      id: "contrast_below_aa",
      severity: "medium" as const,
      dimension: "visual" as const,
      title: "Color contrast below WCAG AA",
      description:
        "Aesthetic rubric scored color_contrast at 4/10, indicating likely WCAG AA failure.",
      root_cause: "Body text on light-grey background.",
      recommendation: "Use #333 on white.",
      confidence: 0.85,
      evidence_refs: [
        { path: "/diagnostics/visual/verdicts/color_contrast", value: "4" },
      ],
      standards_mapping: [
        { framework: "WCAG 2.2", id: "SC 1.4.3", label: "Contrast (Minimum)" },
      ],
    },
  ],
  findings_by_dimension: { visual: ["contrast_below_aa"] },
  screenshot: null,
  persona_id: "diagnose-default-desktop",
  artifacts_dir: "/tmp/diagnoses/abc",
  model: "claude-sonnet-4-6",
  cost_usd: 0.025,
  duration_ms: 8000,
};

const minimalToolCap = {
  name: "see",
  description: "look at a URL",
  kind: "primitive" as const,
  input_schema: { type: "object", properties: { url: { type: "string" } } },
  cacheable: true,
  cost_estimate_usd: { typical: 0, min: 0, max: 0.005, unit: "per_call" as const },
  side_effects: ["navigation", "fs_writes_artifacts"] as const,
  requires: { api_keys: [], browser: true },
};

const minimalEnvDoc = {
  name: "ANTHROPIC_API_KEY",
  description: "Anthropic API key",
  scope: "auth" as const,
  default: "",
  required: true,
};

const minimalListCapabilities = {
  schema_version: SV,
  server: { name: "pixelcheck", version: "1.0.1" },
  result_schema_version: SV,
  tools: [minimalToolCap],
  env: [minimalEnvDoc],
  cache: { enabled: true, ttl_ms_default: 86400000, path: "/tmp/cache.db" },
};

const minimalHistoryEntry = {
  schema_version: SV,
  id: "20260430_120000_smoke",
  tag: "manual",
  projectName: "test",
  startedAt: "2026-04-30T10:00:00.000Z",
  durationMs: 30000,
  totalCostUsd: 0,
  totalUnits: 0,
  passCount: 0,
  warnCount: 0,
  failCount: 0,
  totalIssues: 0,
  criticalIssues: 0,
  overallScore: 0,
  dimensionAverages: {},
};

const minimalCriticResult = {
  schema_version: SV,
  verdict: { scores: [], issues: [] },
  scores: [],
  issues: [],
  costUsd: 0,
};

const minimalGate = {
  schema_version: SV,
  passed: true,
  violations: [],
  computed: {
    mean_agreement: 1,
    mean_max_distance: 0,
    fully_aligned_rate: 1,
  },
};

const minimalCalibrationReport = {
  schema_version: SV,
  tag: "v1",
  model: "claude-sonnet-4-6",
  started_at: "2026-04-30T10:00:00.000Z",
  finished_at: "2026-04-30T10:00:30.000Z",
  total_samples: 0,
  fully_aligned: 0,
  dimensions_aligned: 0,
  mean_agreement: 1,
  mean_max_distance: 0,
  per_dimension_stats: {},
  samples: [],
  total_cost_usd: 0,
};

const minimalBenchmarkTaskResult = {
  schema_version: SV,
  task_id: "t1",
  intent: "Find pricing",
  tags: [],
  passed: true,
  score: 1,
  eval_detail: { passed: true, per_check: [], score: 1 },
  cost_usd: 0,
  duration_ms: 1000,
  final_url: "https://example.com/pricing",
  convergence_reason: "goal_met",
};

const minimalBenchmarkReport = {
  schema_version: SV,
  tag: "v1",
  started_at: "2026-04-30T10:00:00.000Z",
  finished_at: "2026-04-30T10:00:30.000Z",
  total_tasks: 1,
  passed: 1,
  pass_at_1: 1,
  by_difficulty: {},
  by_tag: {},
  total_cost_usd: 0,
  avg_cost_usd: 0,
  avg_duration_ms: 1000,
  p50_duration_ms: 1000,
  p95_duration_ms: 1000,
  tasks: [minimalBenchmarkTaskResult],
  config_summary: {
    cost_mode: "balanced",
    planner: "claude-opus-4-6",
    navigator: "claude-sonnet-4-6",
    navigator_economy: "claude-haiku-4-5-20251001",
  },
};

const minimalMutation = {
  schema_version: SV,
  type: "rephrase" as const,
  instructions: ["Click the submit button"],
};

const minimalAuditUrlResult = {
  schema_version: SV,
  cost_usd: 0,
  issues: 0,
  critical_issues: 0,
  report_json: "/tmp/runs/abc/audit.json",
  report_html: "/tmp/runs/abc/audit.html",
};

const minimalExploreUrlResult = {
  schema_version: SV,
  cost_usd: 0,
};

const minimalCalibrateResult = {
  schema_version: SV,
  passed: true,
  violations: [],
  mean_agreement: 1,
  mean_max_distance: 0,
  fully_aligned_rate: 1,
  total_cost_usd: 0,
  report_dir: "/tmp/calibration/v1",
};

// ─────────────────────────────────────────────────────────────
// Sample-driven Ajv validation
// ─────────────────────────────────────────────────────────────

interface SamplePair {
  slug: string;
  valid: unknown;
  invalid: unknown;
}

const SAMPLES: SamplePair[] = [
  {
    slug: "step-result",
    valid: stepResult,
    invalid: { ...stepResult, status: "exploded" },
  },
  {
    slug: "dimension-score",
    valid: dimensionScore,
    invalid: { ...dimensionScore, score: 99 },
  },
  {
    slug: "issue",
    valid: issue,
    invalid: { ...issue, severity: "annoying" },
  },
  {
    slug: "console-error",
    valid: consoleError,
    invalid: { ...consoleError, type: "exception" }, // not in enum
  },
  {
    slug: "persona-summary",
    valid: personaSummary,
    invalid: { ...personaSummary, payment_tier: "platinum" },
  },
  {
    slug: "list-personas-result",
    valid: [personaSummary],
    invalid: "not-an-array",
  },
  {
    slug: "list-scenarios-result",
    valid: ["smoke", "checkout"],
    invalid: [{ id: "smoke" }], // schema is array of string, not object
  },
  {
    slug: "scenario-run-result",
    valid: scenarioRunResult,
    invalid: { ...scenarioRunResult, status: "exploded" }, // bad enum
  },
  {
    slug: "audit-run",
    valid: minimalAuditRun,
    invalid: { ...minimalAuditRun, summary: undefined },
  },
  {
    slug: "see-result",
    valid: minimalSee,
    invalid: { ...minimalSee, status: "exploded" },
  },
  {
    slug: "act-result",
    valid: minimalAct,
    invalid: { ...minimalAct, engine: "puppeteer" },
  },
  {
    slug: "extract-result",
    valid: minimalExtract,
    invalid: { ...minimalExtract, engine: "playwright" }, // extract requires stagehand
  },
  {
    slug: "judge-result",
    valid: minimalJudge,
    invalid: { ...minimalJudge, overall_score: 99 },
  },
  {
    slug: "compare-result",
    valid: minimalCompare,
    invalid: { ...minimalCompare, overall_winner: "tie-but-typo" },
  },
  {
    slug: "diagnose-result",
    valid: minimalDiagnose,
    invalid: { ...minimalDiagnose, overall_health_score: 150 },
  },
  {
    slug: "result-cache-meta",
    valid: { hit: false, age_ms: 0, key: "a".repeat(64) },
    invalid: { hit: false, age_ms: 0, key: "short" },
  },
  {
    slug: "tool-capability",
    valid: minimalToolCap,
    invalid: { ...minimalToolCap, kind: "wrong-kind" },
  },
  {
    slug: "env-var-doc",
    valid: minimalEnvDoc,
    invalid: { ...minimalEnvDoc, scope: "weather" },
  },
  {
    slug: "cost-estimate",
    valid: { typical: 0, min: 0, max: 0.01, unit: "per_call" },
    invalid: { typical: 0, min: -1, max: 0.01, unit: "per_call" },
  },
  {
    slug: "cache-info",
    valid: { enabled: true, ttl_ms_default: 86400000, path: "/tmp/c.db" },
    invalid: { enabled: "yes", ttl_ms_default: 86400000, path: "/tmp/c.db" },
  },
  {
    slug: "list-capabilities-result",
    valid: minimalListCapabilities,
    invalid: { ...minimalListCapabilities, server: undefined },
  },
  {
    slug: "history-entry",
    valid: minimalHistoryEntry,
    invalid: { ...minimalHistoryEntry, durationMs: -1 }, // minimum 0
  },
  {
    slug: "critic-result",
    valid: minimalCriticResult,
    invalid: { ...minimalCriticResult, costUsd: "free" }, // not a number
  },
  {
    slug: "gate-result",
    valid: minimalGate,
    invalid: { ...minimalGate, passed: "yes" }, // not a boolean
  },
  {
    slug: "calibration-report",
    valid: minimalCalibrationReport,
    invalid: { ...minimalCalibrationReport, total_samples: -1 }, // integer ≥ 0
  },
  {
    slug: "benchmark-task-result",
    valid: minimalBenchmarkTaskResult,
    invalid: { ...minimalBenchmarkTaskResult, difficulty: "extreme" }, // bad enum
  },
  {
    slug: "benchmark-report",
    valid: minimalBenchmarkReport,
    invalid: { ...minimalBenchmarkReport, pass_at_1: "100%" }, // not a number
  },
  {
    slug: "mutation-result",
    valid: minimalMutation,
    invalid: { ...minimalMutation, type: "wrong-type" },
  },
  {
    slug: "audit-url-result",
    valid: minimalAuditUrlResult,
    invalid: { ...minimalAuditUrlResult, status: "ok" }, // bad enum
  },
  {
    slug: "explore-url-result",
    valid: minimalExploreUrlResult,
    invalid: { ...minimalExploreUrlResult, convergence: "exhausted" }, // bad enum
  },
  {
    slug: "calibrate-critic-result",
    valid: minimalCalibrateResult,
    invalid: { ...minimalCalibrateResult, passed: "true" }, // not a boolean
  },
];

describe("docs/schemas — sample-driven Ajv validation", () => {
  it("covers every shipped schema (no slug missing from SAMPLES)", () => {
    const onDisk = fs
      .readdirSync(SCHEMAS_DIR)
      .filter((f) => f.endsWith(".schema.json"))
      .map((f) => f.replace(/\.schema\.json$/, ""))
      .sort();
    const sampled = SAMPLES.map((s) => s.slug).sort();
    expect(sampled).toEqual(onDisk);
  });

  for (const sample of SAMPLES) {
    it(`accepts a minimally conformant ${sample.slug}`, () => {
      expectAjvAccepts(sample.slug, sample.valid);
    });

    it(`rejects a deliberately invalid ${sample.slug}`, () => {
      expectAjvRejects(sample.slug, sample.invalid);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Cross-validator equivalence: real samples validate under both Zod
// and Ajv (this is the contract that matters to external SDK consumers).
// ─────────────────────────────────────────────────────────────

describe("Zod ↔ Ajv equivalence", () => {
  it("a MutationResult validates under both Zod and Ajv", async () => {
    const { MutationResultSchema } = await import(
      "../src/core/result-schema.js"
    );
    expect(MutationResultSchema.safeParse(minimalMutation).success).toBe(true);
    expectAjvAccepts("mutation-result", minimalMutation);
  });

  it("an AuditUrlResult validates under both", async () => {
    const { AuditUrlResultSchema } = await import(
      "../src/core/result-schema.js"
    );
    expect(AuditUrlResultSchema.safeParse(minimalAuditUrlResult).success).toBe(
      true,
    );
    expectAjvAccepts("audit-url-result", minimalAuditUrlResult);
  });

  it("Zod and Ajv both reject negative cost_usd on a primitive envelope", async () => {
    const { JudgeResultSchema } = await import(
      "../src/core/result-schema.js"
    );
    const broken = { ...minimalJudge, cost_usd: -1 };
    expect(JudgeResultSchema.safeParse(broken).success).toBe(false);
    expectAjvRejects("judge-result", broken);
  });

  it("Zod and Ajv both accept the same minimal Compare envelope", async () => {
    const { CompareResultSchema } = await import(
      "../src/core/result-schema.js"
    );
    expect(CompareResultSchema.safeParse(minimalCompare).success).toBe(true);
    expectAjvAccepts("compare-result", minimalCompare);
  });
});
