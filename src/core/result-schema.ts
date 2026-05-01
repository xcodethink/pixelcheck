/**
 * Result schema — stable contract for every result the auditor emits to AI
 * agents and external consumers (M9-2).
 *
 * What lives here:
 *   - RESULT_SCHEMA_VERSION (SemVer string, single source of truth)
 *   - Zod schemas for every public-facing result shape (audit, critic, gate,
 *     benchmark, mutation, MCP tool envelopes)
 *   - validateResult() helper — safeParse + warn-not-throw, never blocks the
 *     producer in v1.0.0 (observe-then-enforce)
 *   - attachSchemaVersion() helper — idempotent; sets schema_version on a
 *     plain object only when absent
 *
 * What this file deliberately does NOT do:
 *   - It does not re-export existing Result interfaces (those live in their
 *     home modules — types.ts, critic.ts, calibration/runner.ts, etc.)
 *   - It does not throw on validation failure. v1.0.0 is observe-only; once
 *     the calibration period proves zero drift, a future task may flip the
 *     mode to enforce.
 *
 * SemVer policy (see docs/contracts/RESULT_SCHEMA.md and ADR-007):
 *   - patch (1.0.x) — clarifications / type tightening with no shape change
 *   - minor (1.x.0) — additive: new optional field, never rename / remove
 *   - major (x.0.0) — breaking: rename / remove / type-narrow an existing field
 *
 * The schemas here intentionally mark `schema_version` as OPTIONAL so legacy
 * fixtures and partial unit-test objects continue to validate. Producers
 * (runAudit, runCritic, runCalibration, runBenchmark, mcp handlers) are
 * responsible for stamping the version onto every emitted result.
 */

import { z } from "zod";
import { ProjectConfigSchema } from "./types.js";
import { getLogger } from "./logger.js";

// ─────────────────────────────────────────────────────────────
// Version
// ─────────────────────────────────────────────────────────────

/**
 * The schema version stamped onto every result emitted at or after this
 * release. Bump per the SemVer policy above when the shape changes.
 *
 * Distinct from `SCHEMA_VERSION` in `history.ts`, which is a SQLite
 * `user_version` integer for DB migrations.
 *
 * Version history:
 *   1.0.0 — initial release (M9-2)
 *   1.1.0 — added optional `cache` field to primitive result envelopes
 *           (see / act / extract / judge / compare). Additive minor
 *           per ADR-007 SemVer policy. Producers without a cache layer
 *           (audit, critic, etc.) are unaffected.
 *   1.2.0 — added the `list_capabilities` self-describe tool envelope
 *           (ListCapabilitiesResult + ToolCapability + EnvVarDoc +
 *           CostEstimate + CacheInfo). Additive minor — no existing
 *           envelope changed. (M9-5 / ADR-016)
 */
export const RESULT_SCHEMA_VERSION = "1.2.0";

const SchemaVersionField = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "schema_version must be SemVer (x.y.z)")
  .optional();

// ─────────────────────────────────────────────────────────────
// Cross-cutting metadata
// ─────────────────────────────────────────────────────────────

/**
 * Annotation attached by the result cache (M9-4) to primitive result
 * envelopes. Always present on cache-aware primitives regardless of
 * whether the call was a hit or miss, so consumers can distinguish
 * "cache disabled / not applicable" (field absent) from "cache miss"
 * (`hit: false`) from "cache hit" (`hit: true`).
 *
 * On hit the source primitive's `cost_usd` is zeroed and the original
 * cost moves to `cache.cost_saved_usd` so downstream aggregators (e.g.
 * `compare` summing two judge calls) do not double-count cached work.
 */
export const ResultCacheMetaSchema = z.object({
  hit: z.boolean(),
  age_ms: z.number().nonnegative(),
  key: z.string().regex(/^[0-9a-f]{64}$/, "key must be a 64-char sha256 hex"),
  cost_saved_usd: z.number().nonnegative().optional(),
});

// ─────────────────────────────────────────────────────────────
// Leaf schemas — match shapes already exported by core/types.ts
// ─────────────────────────────────────────────────────────────

export const ConsoleErrorSchema = z.object({
  type: z.enum(["console", "pageerror", "requestfailed"]),
  text: z.string(),
  location: z.string().optional(),
  timestamp: z.string(),
});

export const DimensionScoreSchema = z.object({
  dimension: z.string(),
  score: z.number().min(0).max(10),
  justification: z.string(),
});

export const IssueSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  step_id: z.string().optional(),
  dimension: z.string().optional(),
  description: z.string(),
  screenshot: z.string().optional(),
  recommendation: z.string(),
  // M2-2: WCAG attribution for accessibility issues. Absent on
  // vision-critic and other non-a11y issues. See src/core/wcag.ts.
  wcag_level: z.enum(["A", "AA", "AAA"]).optional(),
  wcag_criterion: z.string().optional(),
});

const StepTypeEnum = z.enum([
  "visit",
  "act",
  "extract",
  "observe",
  "wait_for",
  "assert_visual",
  "assert_dom",
  "assert_a11y",
  "check_email",
  "screenshot",
  "computer_use",
  "custom",
]);

export const StepResultSchema = z.object({
  step_id: z.string(),
  step_type: StepTypeEnum,
  status: z.enum(["pass", "fail", "warn", "skip"]),
  duration_ms: z.number().nonnegative(),
  screenshot: z.string().optional(),
  screenshot_sha256: z.string().optional(),
  // `output` is intentionally unknown — varies by step type.
  output: z.unknown().optional(),
  error: z.string().optional(),
  console_errors: z.array(ConsoleErrorSchema).optional(),
  retries_used: z.number().int().nonnegative(),
  execution_method: z
    .enum(["stagehand", "selector_hint", "instruction_mutation", "computer_use"])
    .optional(),
  signals: z
    .object({
      network: z.unknown().optional(),
      performance: z.unknown().optional(),
      errors: z.unknown().optional(),
      interaction: z.unknown().optional(),
    })
    .optional(),
});

const AgentSummarySchema = z.object({
  mode: z.literal("autonomous"),
  plan_count: z.number().int().nonnegative(),
  total_actions: z.number().int().nonnegative(),
  criteria_met: z.array(z.string()),
  criteria_missed: z.array(z.string()),
  convergence_reason: z.enum([
    "goal_met",
    "budget_exceeded",
    "max_actions",
    "max_replans",
    "error",
  ]),
});

export const ScenarioRunResultSchema = z.object({
  scenario_id: z.string(),
  scenario_name: z.string(),
  persona_id: z.string(),
  persona_display_name: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().nonnegative(),
  status: z.enum(["pass", "pass_with_issues", "fail"]),
  fingerprint_id: z.string(),
  steps: z.array(StepResultSchema),
  scores: z.array(DimensionScoreSchema),
  overall_score: z.number(),
  issues: z.array(IssueSchema),
  artifacts: z.object({
    video: z.string().optional(),
    har: z.string().optional(),
    console_log: z.string().optional(),
    storage_state: z.string().optional(),
  }),
  cost_usd: z.number().nonnegative(),
  agent_summary: AgentSummarySchema.optional(),
});

export const AuditRunSchema = z.object({
  schema_version: SchemaVersionField,
  run_id: z.string(),
  project_name: z.string(),
  base_url: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().nonnegative(),
  results: z.array(ScenarioRunResultSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    pass_with_issues: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative(),
    total_issues: z.number().int().nonnegative(),
    critical_issues: z.number().int().nonnegative(),
  }),
  config: ProjectConfigSchema,
  redact_patterns: z.array(z.string()).optional(),
});

// ─────────────────────────────────────────────────────────────
// Critic — public projection of CriticResult
//
// `raw` (Anthropic VisionResponse) is intentionally `z.unknown()` so we
// don't pin SDK-internal shape into our public contract.
// ─────────────────────────────────────────────────────────────

const VisionVerdictSchema = z.object({
  scores: z
    .array(
      z.object({
        dimension: z.string(),
        score: z.number().min(0).max(10),
        justification: z.string(),
      }),
    )
    .default([]),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "high", "medium", "low"]),
        dimension: z.string().optional(),
        description: z.string(),
        recommendation: z.string(),
      }),
    )
    .default([]),
  passed: z.boolean().optional(),
  violations: z
    .array(
      z.object({
        text: z.string(),
        location: z.string().optional(),
      }),
    )
    .optional(),
});

export const CriticResultSchema = z.object({
  schema_version: SchemaVersionField,
  verdict: VisionVerdictSchema,
  scores: z.array(DimensionScoreSchema),
  issues: z.array(IssueSchema),
  costUsd: z.number().nonnegative(),
  raw: z.unknown(),
});

// ─────────────────────────────────────────────────────────────
// Calibration — gate result + full report
// ─────────────────────────────────────────────────────────────

export const GateResultSchema = z.object({
  schema_version: SchemaVersionField,
  passed: z.boolean(),
  violations: z.array(z.string()),
  computed: z.object({
    mean_agreement: z.number(),
    mean_max_distance: z.number(),
    fully_aligned_rate: z.number(),
  }),
});

const DimensionAgreementSchema = z.object({
  dimension: z.string(),
  critic_score: z.number().nullable(),
  expected_min: z.number(),
  expected_max: z.number(),
  in_range: z.boolean(),
  distance: z.number(),
});

const SampleAgreementSchema = z.object({
  sample_id: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  per_dimension: z.array(DimensionAgreementSchema),
  agreement_rate: z.number(),
  max_distance: z.number(),
  issue_check: z.object({
    passed: z.boolean(),
    detail: z.string(),
  }),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  error: z.string().optional(),
});

export const CalibrationReportSchema = z.object({
  schema_version: SchemaVersionField,
  tag: z.string(),
  model: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  total_samples: z.number().int().nonnegative(),
  fully_aligned: z.number().int().nonnegative(),
  dimensions_aligned: z.number().int().nonnegative(),
  mean_agreement: z.number(),
  mean_max_distance: z.number(),
  per_dimension_stats: z.record(
    z.object({
      count: z.number().int().nonnegative(),
      in_range: z.number().int().nonnegative(),
      in_range_rate: z.number(),
      avg_distance: z.number(),
    }),
  ),
  samples: z.array(SampleAgreementSchema),
  total_cost_usd: z.number().nonnegative(),
});

// ─────────────────────────────────────────────────────────────
// Benchmark — task result + report
// ─────────────────────────────────────────────────────────────

const TaskCheckSchema = z
  .object({
    type: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
  })
  .passthrough();

const TaskEvalResultSchema = z.object({
  passed: z.boolean(),
  per_check: z.array(TaskCheckSchema),
  score: z.number(),
});

export const BenchmarkTaskResultSchema = z.object({
  schema_version: SchemaVersionField,
  task_id: z.string(),
  intent: z.string(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  tags: z.array(z.string()),
  passed: z.boolean(),
  score: z.number(),
  eval_detail: TaskEvalResultSchema,
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  final_url: z.string(),
  convergence_reason: z.string(),
  error: z.string().optional(),
});

export const BenchmarkReportSchema = z.object({
  schema_version: SchemaVersionField,
  tag: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  total_tasks: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  pass_at_1: z.number(),
  by_difficulty: z.record(
    z.object({
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      pass_rate: z.number(),
    }),
  ),
  by_tag: z.record(
    z.object({
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      pass_rate: z.number(),
    }),
  ),
  total_cost_usd: z.number().nonnegative(),
  avg_cost_usd: z.number().nonnegative(),
  avg_duration_ms: z.number().nonnegative(),
  p50_duration_ms: z.number().nonnegative(),
  p95_duration_ms: z.number().nonnegative(),
  tasks: z.array(BenchmarkTaskResultSchema),
  config_summary: z.object({
    cost_mode: z.string(),
    planner: z.string(),
    navigator: z.string(),
    navigator_economy: z.string(),
  }),
});

// ─────────────────────────────────────────────────────────────
// Instruction mutation
// ─────────────────────────────────────────────────────────────

export const MutationResultSchema = z.object({
  schema_version: SchemaVersionField,
  type: z.enum(["rephrase", "decompose", "specific"]),
  instructions: z.array(z.string()),
});

// ─────────────────────────────────────────────────────────────
// MCP tool result envelopes (the JSON shape inside ToolResult.content[0].text)
// ─────────────────────────────────────────────────────────────

export const AuditUrlResultSchema = z.object({
  schema_version: SchemaVersionField,
  status: z.enum(["pass", "pass_with_issues", "fail"]).optional(),
  overall_score: z.number().optional(),
  cost_usd: z.number().nonnegative(),
  issues: z.number().int().nonnegative(),
  critical_issues: z.number().int().nonnegative(),
  report_json: z.string(),
  report_html: z.string(),
});

export const ExploreUrlResultSchema = z.object({
  schema_version: SchemaVersionField,
  status: z.enum(["pass", "pass_with_issues", "fail"]).optional(),
  convergence: z
    .enum(["goal_met", "budget_exceeded", "max_actions", "max_replans", "error"])
    .optional(),
  criteria_met: z.array(z.string()).optional(),
  criteria_missed: z.array(z.string()).optional(),
  total_actions: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative(),
});

export const CalibrateCriticResultSchema = z.object({
  schema_version: SchemaVersionField,
  passed: z.boolean(),
  violations: z.array(z.string()),
  mean_agreement: z.number(),
  mean_max_distance: z.number(),
  fully_aligned_rate: z.number(),
  total_cost_usd: z.number().nonnegative(),
  report_dir: z.string(),
});

// ─────────────────────────────────────────────────────────────
// `see` primitive (N-1)
// ─────────────────────────────────────────────────────────────

export const SeeDomSchema = z.object({
  interactive_count: z.number().int().nonnegative(),
  headings: z.array(z.string()),
  summary: z.string(),
  text_excerpt: z.string().optional(),
});

export const SeeConsoleSchema = z.object({
  errors_count: z.number().int().nonnegative(),
  errors: z.array(ConsoleErrorSchema),
});

export const SeeScreenshotSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bytes: z.number().int().positive().optional(),
});

export const SeeResultSchema = z.object({
  schema_version: SchemaVersionField,
  url_input: z.string(),
  url_final: z.string(),
  title: z.string(),
  loaded_at: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  dom: SeeDomSchema.nullable(),
  console: SeeConsoleSchema.nullable(),
  screenshot: SeeScreenshotSchema.nullable(),
  note: z.string().nullable(),
  persona_id: z.string(),
  artifacts_dir: z.string(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  /** Result-cache annotation (M9-4). Absent when caching is not applicable. */
  cache: ResultCacheMetaSchema.optional(),
});

// ─────────────────────────────────────────────────────────────
// `act` primitive (N-2)
// ─────────────────────────────────────────────────────────────

const WaitForLiteralSchema = z.enum(["load", "domcontentloaded", "networkidle"]);

const WaitForSelectorObjSchema = z.object({
  type: z.literal("selector"),
  selector: z.string(),
});

const WaitForSchema = z.union([WaitForLiteralSchema, WaitForSelectorObjSchema]);

export const ActStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("goto"),
    url: z.string(),
    wait_for: WaitForSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("click"),
    selector: z.string(),
    timeout_ms: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("fill"),
    selector: z.string(),
    value: z.string(),
    timeout_ms: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("press"),
    key: z.string(),
    selector: z.string().optional(),
  }),
  z.object({
    type: z.literal("wait"),
    ms: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("wait_for"),
    selector: z.string(),
    state: z.enum(["visible", "attached", "hidden"]).optional(),
    timeout_ms: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("scroll"),
    selector: z.string().optional(),
    delta_y: z.number().optional(),
    to_bottom: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("screenshot"),
    label: z.string().optional(),
    full_page: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("act"),
    instruction: z.string(),
  }),
  z.object({
    type: z.literal("note"),
    goal: z.string(),
  }),
]);

export const ActStepResultSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum([
    "goto",
    "click",
    "fill",
    "press",
    "wait",
    "wait_for",
    "scroll",
    "screenshot",
    "act",
    "note",
  ]),
  status: z.enum(["ok", "error", "skipped"]),
  duration_ms: z.number().nonnegative(),
  error: z.string().optional(),
  screenshot: SeeScreenshotSchema.optional(),
  note: z.string().optional(),
  output: z.unknown().optional(),
  cost_usd: z.number().nonnegative(),
});

export const ActResultSchema = z.object({
  schema_version: SchemaVersionField,
  url_input: z.string(),
  url_final: z.string(),
  title: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  engine: z.enum(["playwright", "stagehand"]),
  steps: z.array(ActStepResultSchema),
  dom: SeeDomSchema.nullable(),
  console: SeeConsoleSchema.nullable(),
  screenshot: SeeScreenshotSchema.nullable(),
  persona_id: z.string(),
  artifacts_dir: z.string(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  /**
   * Result-cache annotation (M9-4). Always optional and never `hit:true`
   * for `act` because state-changing steps are not cacheable; the field
   * is included for envelope uniformity across primitives.
   */
  cache: ResultCacheMetaSchema.optional(),
});

// ─────────────────────────────────────────────────────────────
// `extract` primitive (N-4)
//
// `data` is `z.unknown()` because the shape is caller-defined: the user
// hands us a JSON Schema describing what they want, the primitive converts
// it to a Zod schema for Stagehand's `extract()`, and the LLM returns a
// matching object. The result envelope here pins the surrounding metadata
// (engine, dom, console, screenshot, cost) but cannot pin `data` itself
// without copying the user's schema across the wire — out of scope for v1.
//
// `schema_used` echoes the JSON Schema the caller passed so downstream
// consumers can re-validate locally against the same contract. It is
// intentionally `z.unknown()` (Draft 7 schemas are JSON, not a Zod shape
// we want to bake into our own contract — that would couple our SemVer
// to JSON Schema's evolution).
// ─────────────────────────────────────────────────────────────

export const ExtractResultSchema = z.object({
  schema_version: SchemaVersionField,
  url_input: z.string(),
  url_final: z.string(),
  title: z.string(),
  loaded_at: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  engine: z.literal("stagehand"),
  data: z.unknown(),
  schema_used: z.unknown().optional(),
  instruction_used: z.string().optional(),
  selector_used: z.string().optional(),
  dom: SeeDomSchema.nullable(),
  console: SeeConsoleSchema.nullable(),
  screenshot: SeeScreenshotSchema.nullable(),
  persona_id: z.string(),
  artifacts_dir: z.string(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  /** Result-cache annotation (M9-4). Absent when caching is not applicable. */
  cache: ResultCacheMetaSchema.optional(),
});

// ─────────────────────────────────────────────────────────────
// `judge` primitive (N-8)
//
// Single-page rubric-driven critic. Captures (or accepts) a page snapshot,
// runs one vision call against the chosen rubric(s), and returns a
// structured verdict — per-criterion score (0..10) plus issue-level
// findings (severity / dimension / location / recommendation).
//
// Rubric framing (caller-supplied criteria) lets the same engine evaluate
// aesthetic quality, dark-pattern risk, brand cohesion, or any custom
// rubric without retraining the prompt: the rubric is a
// machine-checkable contract emitted into the system prompt.
// ─────────────────────────────────────────────────────────────

export const JudgeRubricKindSchema = z.enum(["aesthetic", "dark_pattern", "custom"]);

export const JudgeCriterionSpecSchema = z.object({
  /** Stable id (snake_case). Used as the join key in CompareResult. */
  id: z.string().min(1),
  /** Human-readable label shown in reports. */
  label: z.string().min(1),
  /** What this criterion measures (single sentence). */
  description: z.string().min(1),
  /** Provenance: which built-in rubric (or `custom`) emitted this criterion. */
  kind: JudgeRubricKindSchema,
});

export const JudgeVerdictSchema = z.object({
  /** Echoes JudgeCriterionSpec.id so consumers can join back to the rubric. */
  criterion_id: z.string().min(1),
  /** 0..10. Higher is better, regardless of kind (so dark_pattern 10 = no DP). */
  score: z.number().min(0).max(10),
  /** One-sentence rationale grounded in observed evidence. */
  rationale: z.string(),
  /** Quoted text or visual cues the model used. Free-form, may be empty. */
  evidence: z.array(z.string()).default([]),
});

export const JudgeFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  /** Optional cross-link to a criterion id; `null` if cross-cutting. */
  criterion_id: z.string().nullable(),
  description: z.string(),
  /** Physical location on screen (e.g. "footer column 2", "hero CTA"). */
  location: z.string().optional(),
  recommendation: z.string(),
});

export const JudgeResultSchema = z.object({
  schema_version: SchemaVersionField,
  url_input: z.string(),
  url_final: z.string(),
  title: z.string(),
  loaded_at: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  /** Which rubric(s) were applied. Order-preserving for trace fidelity. */
  rubrics: z.array(JudgeRubricKindSchema),
  criteria: z.array(JudgeCriterionSpecSchema),
  verdicts: z.array(JudgeVerdictSchema),
  findings: z.array(JudgeFindingSchema),
  /** Mean of verdict scores. Convenience field; consumers may recompute. */
  overall_score: z.number().min(0).max(10).nullable(),
  /** Free-form summary (≤ 2 sentences) of the dominant issue. */
  summary: z.string().nullable(),
  dom: SeeDomSchema.nullable(),
  console: SeeConsoleSchema.nullable(),
  screenshot: SeeScreenshotSchema.nullable(),
  persona_id: z.string(),
  artifacts_dir: z.string(),
  model: z.string(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  /** Result-cache annotation (M9-4). Absent when caching is not applicable. */
  cache: ResultCacheMetaSchema.optional(),
});

// ─────────────────────────────────────────────────────────────
// `compare` primitive (N-3)
//
// A/B comparison primitive. Default behaviour is the **double-blind +
// synthesis** mode (3 vision calls): judge each side independently with
// the same rubric, then 1 comparison call sees both screenshots side-by-side
// with the per-side verdicts as context and emits per-criterion winners.
// `mode: "fast"` collapses to a single side-by-side call (1 vision call,
// at the cost of anchoring bias — see ADR-014).
//
// The double-blind default follows commercial UX-review practice (Nielsen
// Norman, Baymard) where each candidate is evaluated independently before
// being compared, so absolute scores are not contaminated by the
// difference between the two pages.
// ─────────────────────────────────────────────────────────────

export const CompareModeSchema = z.enum(["double_blind", "fast"]);

export const CompareWinnerSchema = z.enum(["a", "b", "tie"]);

export const CompareCriterionVerdictSchema = z.object({
  criterion_id: z.string().min(1),
  /** Per-side score recorded for this criterion. May be null in fast mode if the model only emitted a winner. */
  score_a: z.number().min(0).max(10).nullable(),
  score_b: z.number().min(0).max(10).nullable(),
  winner: CompareWinnerSchema,
  /** One-sentence rationale grounded in observed evidence from both sides. */
  rationale: z.string(),
});

export const CompareSideSchema = z.object({
  url_input: z.string(),
  url_final: z.string(),
  title: z.string(),
  /** Embedded judge result for this side. `null` when caller pre-supplied a capture and judge was skipped. */
  judge: JudgeResultSchema.nullable(),
  screenshot: SeeScreenshotSchema.nullable(),
  artifacts_dir: z.string(),
});

export const CompareResultSchema = z.object({
  schema_version: SchemaVersionField,
  /** Which strategy was used. */
  mode: CompareModeSchema,
  rubrics: z.array(JudgeRubricKindSchema),
  criteria: z.array(JudgeCriterionSpecSchema),
  started_at: z.string(),
  finished_at: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  side_a: CompareSideSchema,
  side_b: CompareSideSchema,
  per_criterion: z.array(CompareCriterionVerdictSchema),
  /** Overall winner across all criteria. Tie when no clear majority. */
  overall_winner: CompareWinnerSchema,
  /** Free-form summary (≤ 3 sentences) of the dominant difference. */
  summary: z.string().nullable(),
  artifacts_dir: z.string(),
  model: z.string(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  /**
   * Result-cache annotation (M9-4). Reflects the synthesis call only;
   * each side's `judge` already carries its own `cache` field.
   */
  cache: ResultCacheMetaSchema.optional(),
});

export const PersonaSummarySchema = z.object({
  id: z.string(),
  display_name: z.string(),
  country: z.string(),
  language: z.string(),
  device: z.enum(["desktop", "tablet", "mobile"]),
  payment_tier: z.enum(["free", "pro", "max", "power"]),
});

export const ListPersonasResultSchema = z.array(PersonaSummarySchema);
export const ListScenariosResultSchema = z.array(z.string());

// ─────────────────────────────────────────────────────────────
// `list_capabilities` self-describe tool (M9-5 / ADR-016)
// ─────────────────────────────────────────────────────────────

/**
 * Static cost estimate for one invocation of a tool. The numbers are
 * rough USD ranges meant to support AI plan-stage decisions ("can I
 * afford 50 of these?") — they are NOT measured per-call. Real spend
 * is reported per-result via `cost_usd` on each tool's envelope.
 *
 * `unit` describes the scope:
 *   - `per_call` — one invocation of the tool
 *   - `per_step` — one entry in a sequence (e.g. one `act`/`note` step)
 *   - `per_persona_scenario` — one persona × one scenario (audit_url)
 *
 * `notes` is optional one-line context (e.g. "vision call only when
 * `goal` is set" for `see`).
 */
export const CostEstimateSchema = z.object({
  typical: z.number().nonnegative(),
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
  unit: z.enum(["per_call", "per_step", "per_persona_scenario"]),
  notes: z.string().optional(),
});

/**
 * Side effects a tool may produce. The list is exhaustive: tools must
 * surface every effect they can cause so an AI agent can reason about
 * idempotency / undo strategies / sandboxing without inspecting source.
 *
 *   - `navigation`         — drives a browser to a URL
 *   - `state_changing`     — mutates remote state (form submit, click
 *                            "delete", login, etc.)
 *   - `fs_writes_artifacts`— writes screenshots / DOM / per-call sidecar
 *                            JSON to a primitive artifacts dir
 *   - `fs_writes_history`  — appends to the local history DB / reports
 *                            tree
 *   - `fs_reads`           — reads project files (personas, scenarios,
 *                            history, fixtures) — pure read, no writes
 *   - `network_egress`     — calls an LLM provider (Anthropic) or other
 *                            third party. Implied by every tool that
 *                            uses vision / Stagehand, but called out
 *                            explicitly so callers can isolate
 *                            offline-only tools.
 *
 * Only effects the tool itself produces are listed. Cross-tool effects
 * (e.g. `compare` calls `judge` which writes artifacts) are NOT
 * propagated up — the tool's own row covers what its handler does.
 */
export const ToolSideEffectSchema = z.enum([
  "navigation",
  "state_changing",
  "fs_writes_artifacts",
  "fs_writes_history",
  "fs_reads",
  "network_egress",
]);

/**
 * Static dependency declarations — what a caller must have configured
 * before this tool can succeed. INTENTIONALLY does not probe runtime
 * state (whether each env var is currently set) because that would
 * leak secret-presence to every caller. Agents who hit a missing
 * dependency get a normal error from the tool body.
 */
export const ToolRequirementsSchema = z.object({
  /** Env var names this tool's code path will read (e.g. "ANTHROPIC_API_KEY"). */
  api_keys: z.array(z.string()),
  /** Whether the handler launches a Chromium instance. */
  browser: z.boolean(),
  /** Whether the project is expected to ship a personas/ directory. */
  personas_dir: z.boolean().optional(),
  /** Whether the project is expected to ship a scenarios/ directory. */
  scenarios_dir: z.boolean().optional(),
});

/**
 * Per-tool capability descriptor. Same `name` / `description` /
 * `input_schema` the MCP `tools/list` returns, plus the richer fields
 * that are deliberately kept off the spec-level catalog (see
 * server.ts comment).
 */
export const ToolCapabilitySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(["preset", "primitive", "meta"]),
  /** Raw JSON Schema the MCP catalog publishes for `arguments`. */
  input_schema: z.record(z.unknown()),
  /** Title of the published JSON Schema in `docs/schemas/`. */
  result_schema: z.string().optional(),
  /** Whether the M9-4 result cache will key on this tool's inputs. */
  cacheable: z.boolean(),
  /** Static cost band for one invocation. */
  cost_estimate_usd: CostEstimateSchema,
  /** Effects the handler itself may produce. */
  side_effects: z.array(ToolSideEffectSchema),
  /** Static dependency declarations (no runtime state probed). */
  requires: ToolRequirementsSchema,
});

/**
 * One env var entry in the capabilities envelope. `default` is shown
 * as a string to keep the contract stable across number / path /
 * boolean defaults; an empty string means "no built-in default — the
 * tool falls back to its own internal value".
 *
 * `scope` indicates which subsystem reads the variable so callers can
 * filter (e.g. "show me only the cache knobs").
 *
 * Secret names appear here (`ANTHROPIC_API_KEY`) but their values
 * never do; `required: true` simply marks the variable as a
 * dependency, not a presence probe.
 */
export const EnvVarDocSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  scope: z.enum([
    "auth",
    "cache",
    "cost_guard",
    "artifacts",
    "logging",
    "memory",
    "reports",
  ]),
  default: z.string(),
  required: z.boolean(),
});

/** Live state of the M9-4 result cache. Path is exposed (paths are not secrets); secrets never are. */
export const CacheInfoSchema = z.object({
  enabled: z.boolean(),
  ttl_ms_default: z.number().nonnegative(),
  path: z.string(),
});

/** The MCP server identity stamped onto every capability response. */
export const ServerInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export const ListCapabilitiesResultSchema = z.object({
  schema_version: SchemaVersionField,
  server: ServerInfoSchema,
  /** Same RESULT_SCHEMA_VERSION above; surfaced so callers can plan for migrations without parsing schema_version. */
  result_schema_version: z.string(),
  /** Stable insertion-ordered list of every shipped tool. */
  tools: z.array(ToolCapabilitySchema),
  /** Public env vars that influence behaviour. Secrets named, never valued. */
  env: z.array(EnvVarDocSchema),
  /** M9-4 result cache state. */
  cache: CacheInfoSchema,
});

// HistoryEntry — used by get_last_report. Match history.ts shape.
export const HistoryEntrySchema = z.object({
  schema_version: SchemaVersionField,
  id: z.string(),
  tag: z.string().nullable(),
  projectName: z.string(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  totalUnits: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
  warnCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  totalIssues: z.number().int().nonnegative(),
  criticalIssues: z.number().int().nonnegative(),
  overallScore: z.number(),
  dimensionAverages: z.record(z.number()),
  /** Result schema version this row was written under (camelCase for parity with HistoryEntry). */
  schemaVersion: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Validate `value` against `schema` using safeParse. On failure, emit a
 * structured warning (logger.warn) and return the original value unchanged.
 *
 * v1.0.0 is observe-only by design — never block the producer. Once a
 * future calibration period confirms zero drift, callers may switch to
 * `schema.parse()` directly to enforce.
 */
export function validateResult<T>(
  resultName: string,
  schema: z.ZodType<T>,
  value: unknown,
): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Lazy logger lookup so tests can rebuild the cache between cases.
    getLogger("result-schema").warn(
      {
        result: resultName,
        schema_version: RESULT_SCHEMA_VERSION,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
      },
      `result schema mismatch (observe-only; not blocking)`,
    );
  }
  return value;
}

/**
 * Attach `schema_version` to a plain result object idempotently.
 *
 * - If the input is non-object, returns it unchanged.
 * - If `schema_version` is already set, returns the input unchanged (no
 *   downgrade — preserves whatever the producer stamped).
 * - Otherwise, returns a SHALLOW copy with `schema_version` prepended so
 *   the field appears first in JSON.stringify output.
 */
export function attachSchemaVersion<T>(value: T): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.schema_version === "string" && obj.schema_version.length > 0) {
    return value;
  }
  // Place schema_version first so it sits at the top of the serialized JSON.
  const stamped = { schema_version: RESULT_SCHEMA_VERSION, ...obj };
  return stamped as unknown as T;
}

// ─────────────────────────────────────────────────────────────
// Inferred types (for downstream library consumers)
// ─────────────────────────────────────────────────────────────

export type AuditRunSchemaShape = z.infer<typeof AuditRunSchema>;
export type ScenarioRunResultSchemaShape = z.infer<typeof ScenarioRunResultSchema>;
export type StepResultSchemaShape = z.infer<typeof StepResultSchema>;
export type CriticResultSchemaShape = z.infer<typeof CriticResultSchema>;
export type GateResultSchemaShape = z.infer<typeof GateResultSchema>;
export type CalibrationReportSchemaShape = z.infer<typeof CalibrationReportSchema>;
export type BenchmarkReportSchemaShape = z.infer<typeof BenchmarkReportSchema>;
export type BenchmarkTaskResultSchemaShape = z.infer<typeof BenchmarkTaskResultSchema>;
export type MutationResultSchemaShape = z.infer<typeof MutationResultSchema>;
export type AuditUrlResultShape = z.infer<typeof AuditUrlResultSchema>;
export type ExploreUrlResultShape = z.infer<typeof ExploreUrlResultSchema>;
export type CalibrateCriticResultShape = z.infer<typeof CalibrateCriticResultSchema>;
export type SeeResultShape = z.infer<typeof SeeResultSchema>;
export type ActStepShape = z.infer<typeof ActStepSchema>;
export type ActStepResultShape = z.infer<typeof ActStepResultSchema>;
export type ActResultShape = z.infer<typeof ActResultSchema>;
export type ExtractResultShape = z.infer<typeof ExtractResultSchema>;
export type JudgeRubricKind = z.infer<typeof JudgeRubricKindSchema>;
export type JudgeCriterionSpec = z.infer<typeof JudgeCriterionSpecSchema>;
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;
export type JudgeFinding = z.infer<typeof JudgeFindingSchema>;
export type JudgeResultShape = z.infer<typeof JudgeResultSchema>;
export type CompareMode = z.infer<typeof CompareModeSchema>;
export type CompareWinner = z.infer<typeof CompareWinnerSchema>;
export type CompareCriterionVerdict = z.infer<typeof CompareCriterionVerdictSchema>;
export type CompareSide = z.infer<typeof CompareSideSchema>;
export type CompareResultShape = z.infer<typeof CompareResultSchema>;
export type ResultCacheMeta = z.infer<typeof ResultCacheMetaSchema>;
