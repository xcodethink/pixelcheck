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
 *   1.3.0 — added optional `diagnostics` envelope to See / Act / Extract
 *           / Compare result schemas. Carries multi-dimensional audit
 *           data (popups, network, cookies, storage, performance,
 *           visual). PR-A landed scaffolding with placeholder sub-schemas;
 *           PR-B then concretized the four white-box sub-schemas
 *           (PopupSnapshot / NetworkLog / Cookie / StorageSnapshot)
 *           without bumping the version — sub-schema field shape changes
 *           DURING a minor cycle still count as additive minor as long
 *           as no required-field has been removed (the v1.2.0 placeholder
 *           shapes were `passthrough()` so they never required any
 *           field). PR-C concretized PerformanceMetrics +
 *           PerformanceResourceCounts (Core Web Vitals: LCP / CLS / INP /
 *           FCP / TTFB plus supporting page-load + resource-type metrics)
 *           and wired the existing `PerformanceSignalCollector`
 *           (src/agent/signals/performance.ts) into the see / act /
 *           extract default-open paths. PR-E added the `diagnose`
 *           primitive with `DiagnoseResultSchema` (commercial-grade
 *           findings: confidence + standards_mapping + evidence_refs +
 *           overall_health_score + dimension_scores + executive_summary)
 *           — net additive, no version bump. PR-D concretized VisualScoring
 *           (verdicts / findings / overall_score / summary, mirroring
 *           a normalized subset of JudgeResult) and wired a new
 *           VisualCollector that reuses the existing rubric-based
 *           callVision path (AESTHETIC_CRITERIA / DARK_PATTERN_CRITERIA);
 *           gated by `cfg.visualScoring: 'off' | 'auto' | 'eager'` with
 *           default `'off'` because the call has real LLM cost (other
 *           diagnostics are passive observers). Additive minor per
 *           ADR-007 — pre-1.3.0 consumers see the field as unknown and
 *           ignore it. (Phase 0 / ADR-034)
 */
export const RESULT_SCHEMA_VERSION = "1.3.0";

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
// Diagnostics envelope (ADR-034 — Phase 0 multi-dimensional audit)
// ─────────────────────────────────────────────────────────────
//
// Optional sub-object on every primitive result (See / Act / Extract /
// Compare). Carries audit data that does not fit the existing root-
// level fields (`url_input`, `console`, `dom`, `screenshot`, ...).
//
// PR-A (this release, v1.3.0) ships placeholder sub-schemas. The fields
// are intentionally permissive (`passthrough()` + minimal required
// keys) so PR-B / PR-C / PR-D can fill in concrete shapes without
// another major schema bump. A consumer reading a v1.3.0 payload can
// already parse the envelope; the data inside each sub-field will
// solidify in subsequent minor releases.
//
// Default `collected_at` is `'always'` — per ADR-034 a professional
// audit never short-circuits. The `'on_failure'` value is reserved for
// a future opt-in performance optimization where a caller explicitly
// trades audit completeness for token savings.

/** Popup window snapshot — secondary pages opened by the main page via
 *  window.open() / OAuth / SSO / share dialogs. Index is stable across
 *  the session even after a popup closes; closed popups retain
 *  `last_seen_url` / `last_seen_title` so audit consumers can still
 *  reason about which popup completed. */
export const PopupSnapshotSchema = z.object({
  /** Stable index assigned in registration order. Never re-shifted. */
  index: z.number().int().nonnegative(),
  /** Current URL. Empty when closed. */
  url: z.string(),
  /** Current title. Empty when closed or when cross-origin restricts read. */
  title: z.string(),
  /** First N chars of `document.body.innerText`. Empty for cross-origin
   *  popups that block DOM access (e.g. accounts.google.com). Capped at
   *  POPUP_BODY_TEXT_MAX_BYTES (2 KB) to bound result size. */
  body_text: z.string(),
  /** True when this popup has been closed (by user or window.close()). */
  closed: z.boolean(),
  /** URL captured the last time this popup was queried while alive. Lets
   *  the audit reason "popup at accounts.google.com closed → OAuth flow
   *  likely succeeded" rather than seeing an opaque `closed: true`. */
  last_seen_url: z.string().optional(),
  /** Title companion to last_seen_url. */
  last_seen_title: z.string().optional(),
});

/** Per-entry shape inside `NetworkLogSchema.requests`. */
export const NetworkRequestEntrySchema = z.object({
  url: z.string(),
  method: z.string(),
  resource_type: z.string().optional(),
  status: z.number().int().nullable(),
  duration_ms: z.number().nonnegative().nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  /** From-cache flag for response, when known. */
  from_cache: z.boolean().optional(),
});

/** Per-entry shape inside `NetworkLogSchema.failures`. */
export const NetworkFailureEntrySchema = z.object({
  url: z.string(),
  method: z.string(),
  resource_type: z.string().optional(),
  /** Playwright failure error text (e.g. "net::ERR_FAILED"). */
  error_text: z.string(),
});

/** Network log — request + failure counts plus per-entry metadata. We
 *  capture URL / method / status / duration / failure reason but NOT
 *  request bodies or response bodies — bodies leak PII and balloon
 *  result size. Capped at NETWORK_REQUEST_CAP per primitive call. */
export const NetworkLogSchema = z.object({
  request_count: z.number().int().nonnegative(),
  failure_count: z.number().int().nonnegative(),
  /** Truncated to NETWORK_REQUEST_CAP entries when more requests
   *  occurred. `truncated_count` reports how many extra were dropped. */
  requests: z.array(NetworkRequestEntrySchema),
  failures: z.array(NetworkFailureEntrySchema),
  /** When > 0, indicates `requests` was truncated due to cap. */
  truncated_count: z.number().int().nonnegative().optional(),
});

/** Cookie snapshot from `BrowserContext.cookies()`. Field names mirror
 *  Playwright's Cookie type (snake_case in our envelope). `value` is
 *  redacted per ADR-006 secrets-redaction when the cookie name matches
 *  any of the project's redact_patterns (defaults include
 *  password/token/secret/auth/session/api_key). */
export const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  /** Unix epoch seconds. -1 for session cookies. */
  expires: z.number(),
  http_only: z.boolean(),
  secure: z.boolean(),
  same_site: z.enum(["Strict", "Lax", "None"]).optional(),
});

/** Storage snapshot — localStorage + sessionStorage key-value maps.
 *  Values matching redact_patterns are replaced with `[REDACTED]`
 *  inline. Per-value cap of STORAGE_VALUE_MAX_BYTES (2 KB) — longer
 *  values get truncated with a `[…truncated N bytes]` suffix. */
export const StorageSnapshotSchema = z.object({
  local_storage: z.record(z.string(), z.string()),
  session_storage: z.record(z.string(), z.string()),
  /** Counts BEFORE truncation/redaction. */
  local_storage_keys: z.number().int().nonnegative(),
  session_storage_keys: z.number().int().nonnegative(),
});

/** Per-resource-type counts inside `PerformanceMetricsSchema.resources`. */
export const PerformanceResourceCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  script: z.number().int().nonnegative(),
  stylesheet: z.number().int().nonnegative(),
  image: z.number().int().nonnegative(),
  xhr_or_fetch: z.number().int().nonnegative(),
});

/** Core Web Vitals + supporting page-load metrics. Mirrors the
 *  `PerformanceSignal` interface in `src/agent/signals/performance.ts`,
 *  which is the existing PerformanceObserver-based collector reused by
 *  PR-C. Each Web Vital may be `null` when the browser couldn't measure
 *  it (e.g. very fast pages where INP never fires, or pages closed
 *  before LCP settled). */
export const PerformanceMetricsSchema = z.object({
  /** Largest Contentful Paint in ms. Google SEO ranking factor; "good" ≤ 2500. */
  lcp_ms: z.number().nullable(),
  /** Cumulative Layout Shift, unitless. "Good" ≤ 0.1. */
  cls: z.number().nullable(),
  /** Interaction to Next Paint in ms (longest event so far). "Good" ≤ 200. */
  inp_ms: z.number().nullable(),
  /** First Contentful Paint in ms. "Good" ≤ 1800. */
  fcp_ms: z.number().nullable(),
  /** Time to First Byte in ms (responseStart - requestStart). "Good" ≤ 800. */
  ttfb_ms: z.number().nullable(),
  /** DOMContentLoaded event end time relative to navigation start, in ms. */
  dom_content_loaded_ms: z.number().nullable(),
  /** load event end time relative to navigation start, in ms. */
  load_ms: z.number().nullable(),
  /** Counts of resources by initiator type. */
  resources: PerformanceResourceCountsSchema,
  /** Sum of `transferSize` across every resource entry, in bytes. */
  transfer_bytes: z.number().nonnegative(),
  /** Wall-clock time the collector observed, ms since `attach()`. */
  window_ms: z.number().nonnegative(),
});

/** Visual scoring sub-finding — mirrors the shape of `JudgeVerdict`
 *  (one entry per criterion). Kept as its own export so consumers can
 *  walk `diagnostics.visual.verdicts[]` without importing judge schemas. */
export const VisualVerdictSchema = z.object({
  /** Stable id of the criterion (snake_case, e.g. "visual_hierarchy"). */
  criterion_id: z.string().min(1),
  /** Human-readable label (echoed from rubric for self-contained reporting). */
  label: z.string().min(1),
  /** Which built-in rubric this criterion came from. */
  kind: z.enum(["aesthetic", "dark_pattern", "custom"]),
  /** 0..10. Higher is better, regardless of kind (so dark_pattern 10 = no DP). */
  score: z.number().min(0).max(10),
  /** One-sentence rationale grounded in observed evidence. */
  rationale: z.string(),
  /** Quoted text or visual cues the model used. May be empty. */
  evidence: z.array(z.string()).default([]),
});

/** Visual scoring finding — high-signal issue surfaced by the rubric.
 *  Mirrors `JudgeFinding` shape (severity / criterion_id / location / recommendation). */
export const VisualFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  /** Optional cross-link to a verdict.criterion_id; `null` if cross-cutting. */
  criterion_id: z.string().nullable(),
  description: z.string(),
  /** Physical location on screen (e.g. "footer column 2", "hero CTA"). */
  location: z.string().optional(),
  recommendation: z.string(),
});

/** Visual scoring. Concretized in PR-D: rubric-based AI scoring of the
 *  primitive's final screenshot. Fields mirror a normalized subset of
 *  `JudgeResult` so any downstream consumer that already understands judge
 *  output can read this verbatim.
 *
 *  Provenance:
 *  - `scored: true` + populated `verdicts/findings` → collector ran and
 *    produced output.
 *  - `scored: false` + `skip_reason` → collector was wired but skipped
 *    (e.g. `visualScoring: 'off'`, missing API key, daily cost cap hit,
 *    no goal supplied in `'auto'` mode). */
export const VisualScoringSchema = z.object({
  /** True when the AI scoring call actually executed. False when skipped. */
  scored: z.boolean(),
  /** When `scored=false`, machine-readable reason. Omitted when `scored=true`. */
  skip_reason: z
    .enum([
      "config_off",
      "no_goal",
      "no_api_key",
      "cost_cap",
      "no_screenshot",
      "vision_error",
    ])
    .optional(),
  /** Which rubric(s) fed the scoring call. Order-preserving. */
  rubrics: z.array(z.enum(["aesthetic", "dark_pattern", "custom"])).default([]),
  /** Per-criterion scores. Empty array when `scored=false`. */
  verdicts: z.array(VisualVerdictSchema).default([]),
  /** High-signal findings called out by the rubric. */
  findings: z.array(VisualFindingSchema).default([]),
  /** Mean of verdict scores (null when no verdicts or scored=false). */
  overall_score: z.number().min(0).max(10).nullable(),
  /** Free-form summary (≤ 2 sentences) of the dominant issue. Null on skip. */
  summary: z.string().nullable(),
  /** Vision model identifier used for the scoring call (e.g. "claude-sonnet-4-5"). */
  model: z.string().optional(),
  /** Cost of the vision call in USD. 0 when skipped. */
  cost_usd: z.number().nonnegative().default(0),
  /** Wall-clock duration of the scoring call in ms. 0 when skipped. */
  duration_ms: z.number().nonnegative().default(0),
});

export const DiagnosticsSchema = z.object({
  /** Provenance: when did the collectors run.
   *  - `'always'`: collectors ran unconditionally. ADR-034 default.
   *  - `'on_failure'`: collectors ran only because the primitive failed
   *    (reserved for future opt-in performance modes; not used in v1.3.0). */
  collected_at: z.enum(["always", "on_failure"]).default("always"),
  popups: z.array(PopupSnapshotSchema).optional(),
  network: NetworkLogSchema.optional(),
  cookies: z.array(CookieSchema).optional(),
  storage: StorageSnapshotSchema.optional(),
  performance: PerformanceMetricsSchema.optional(),
  visual: VisualScoringSchema.optional(),
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
    "no_progress",
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
    .enum(["goal_met", "budget_exceeded", "max_actions", "max_replans", "no_progress", "error"])
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
  /** Multi-dimensional audit diagnostics (ADR-034 / Phase 0). Optional in
   *  v1.3.0; sub-fields populated by PR-B (whitebox) / PR-C (performance)
   *  / PR-D (visual). Absent when no collector ran (e.g. v1.2.x payload). */
  diagnostics: DiagnosticsSchema.optional(),
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
    timeout_ms: z.number().int().positive().optional(),
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
  /** Multi-dimensional audit diagnostics (ADR-034 / Phase 0). See SeeResult. */
  diagnostics: DiagnosticsSchema.optional(),
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
  /** Multi-dimensional audit diagnostics (ADR-034 / Phase 0). See SeeResult. */
  diagnostics: DiagnosticsSchema.optional(),
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
  /** ADR-034 Phase 0 — multi-dimensional audit envelope. The `judge`
   *  primitive's whole purpose IS visual scoring, so it always emits
   *  `diagnostics.visual` as a normalized mirror of its own verdicts /
   *  findings / overall_score / summary. Other diagnostics dimensions
   *  (popups / network / cookies / storage / performance) are absent
   *  by default — judge does not capture a live page in the way see /
   *  act / extract do (it operates on a screenshot only). */
  diagnostics: DiagnosticsSchema.optional(),
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
  /** Multi-dimensional audit diagnostics (ADR-034 / Phase 0).
   *  For compare, diagnostics describe the aggregate run; per-side
   *  diagnostics live on each side's underlying judge / see result. */
  diagnostics: DiagnosticsSchema.optional(),
});

// ─────────────────────────────────────────────────────────────
// `diagnose` primitive (PR-E / ADR-034)
//
// Holistic page-health diagnosis. Where `judge` answers "score this page
// against a rubric" and `compare` answers "which of A vs B is better",
// `diagnose` answers "what is wrong with this page, why, and how should
// it be fixed". The primitive captures the page (`see` with eager
// `visualScoring`), reads every diagnostics dimension produced by PR-B
// (whitebox), PR-C (performance), PR-D (visual), serialises them into a
// vision-call prompt, and returns a structured commercial-grade report.
//
// Commercial-grade fields (informed by Lighthouse, Sentry, Datadog
// Synthetics, Snyk, axe-core enterprise reporting):
//   - `confidence: 0..1` per finding (enterprise triage signal)
//   - `standards_mapping[]` per finding (WCAG, Core Web Vitals, OWASP,
//     GDPR... — feeds compliance reports without re-scoring)
//   - `evidence_refs[]` per finding cite specific diagnostics fields
//     (`diagnostics.performance.lcp_ms`) — anti-hallucination tether
//   - `overall_health_score: 0..100` (single-number dashboard signal)
//   - `dimension_scores[]` (drill-down for each diagnostic dimension)
//   - `executive_summary` (≤ 3 sentences, PM/CTO-readable layer)
//   - `findings_by_dimension` (index for grouped rendering)
// ─────────────────────────────────────────────────────────────

/** Severity bands match `JudgeFinding` so consumers with existing
 *  judge-shaped reporters can render diagnose findings without remap. */
export const DiagnoseSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

/** Which diagnostics dimension a finding stems from. `cross_cutting`
 *  is reserved for issues that span multiple dimensions (e.g. "third-
 *  party tracker is both a performance tax AND a privacy concern"). */
export const DiagnoseDimensionSchema = z.enum([
  "performance",
  "visual",
  "whitebox",
  "security",
  "accessibility",
  "seo",
  "privacy",
  "cross_cutting",
]);

/** Single industry-standard reference a finding maps to. The `framework`
 *  field is open-string (not enum) so callers can register new
 *  frameworks (NIST, PCI DSS, HIPAA, ...) without a schema bump.
 *  `id` is the citation within that framework. `url` is optional but
 *  strongly encouraged so report consumers can deep-link. */
export const StandardsReferenceSchema = z.object({
  /** Standards body / framework name (e.g. "WCAG 2.2", "Core Web Vitals", "OWASP Top 10 2021", "GDPR"). */
  framework: z.string().min(1),
  /** Citation within that framework (e.g. "SC 1.4.3", "LCP", "A01:2021", "Art. 32"). */
  id: z.string().min(1),
  /** Optional deep-link to the spec. */
  url: z.string().optional(),
  /** Short human-readable label (e.g. "Contrast (Minimum)"). */
  label: z.string().optional(),
});

/** Anti-hallucination: every finding must cite at least one specific
 *  diagnostics field it was derived from. The path follows JSON-pointer
 *  conventions ("/diagnostics/performance/lcp_ms"). The `value` is
 *  serialised as a string for stable transport (numbers / booleans /
 *  arrays all stringified). */
export const EvidenceRefSchema = z.object({
  /** JSON-pointer-style path into the diagnose result (or upstream see
   *  result's diagnostics envelope). */
  path: z.string().min(1),
  /** Stringified value of that field at evaluation time. */
  value: z.string(),
  /** One-sentence explanation of why this field supports the finding. */
  note: z.string().optional(),
});

export const DiagnoseFindingSchema = z.object({
  /** Stable id (snake_case) — useful for diffing across runs / triage. */
  id: z.string().min(1),
  severity: DiagnoseSeveritySchema,
  dimension: DiagnoseDimensionSchema,
  /** One-sentence problem statement. */
  title: z.string().min(1),
  /** Two-to-five sentence problem description. */
  description: z.string().min(1),
  /** Inferred root cause (one to three sentences). */
  root_cause: z.string(),
  /** Concrete actionable fix (one to three sentences). */
  recommendation: z.string(),
  /** 0..1 confidence the finding is real (not a false positive). */
  confidence: z.number().min(0).max(1),
  /** Cited diagnostics fields. MUST be non-empty for severity != 'low'. */
  evidence_refs: z.array(EvidenceRefSchema).default([]),
  /** Standards mapping for compliance reports. Optional but encouraged. */
  standards_mapping: z.array(StandardsReferenceSchema).default([]),
  /** Physical location on screen (e.g. "hero CTA", "footer column 2"). */
  affected_location: z.string().optional(),
  /** Optional URL the finding is bound to (e.g. failing network request). */
  affected_url: z.string().optional(),
  /** Optional CSS / DOM selector. */
  affected_selector: z.string().optional(),
});

/** Per-dimension drill-down score. `score` is a 0..100 composite where
 *  100 = "no issues found in this dimension". */
export const DiagnoseDimensionScoreSchema = z.object({
  dimension: DiagnoseDimensionSchema,
  /** 0..100 composite. Higher is healthier. */
  score: z.number().min(0).max(100),
  /** Number of findings in this dimension by severity. */
  finding_counts: z.object({
    critical: z.number().int().nonnegative().default(0),
    high: z.number().int().nonnegative().default(0),
    medium: z.number().int().nonnegative().default(0),
    low: z.number().int().nonnegative().default(0),
  }),
  /** One-sentence summary of the dimension's state. */
  summary: z.string(),
});

export const DiagnoseResultSchema = z.object({
  schema_version: SchemaVersionField,
  url_input: z.string(),
  url_final: z.string(),
  title: z.string(),
  loaded_at: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  /** PM/CTO-readable summary (≤ 3 sentences). */
  executive_summary: z.string(),
  /** 0..100 single-number health score across all dimensions.
   *  Computed as a severity-weighted aggregation of dimension_scores. */
  overall_health_score: z.number().min(0).max(100),
  /** Per-dimension drill-down. One entry per dimension actually
   *  evaluated (absent dimensions had no diagnostics data). */
  dimension_scores: z.array(DiagnoseDimensionScoreSchema),
  /** Full findings list. Order: severity desc, then confidence desc. */
  findings: z.array(DiagnoseFindingSchema),
  /** Convenience index: dimension → array of finding ids. Saves
   *  consumers from scanning findings[] when grouping for a UI. */
  findings_by_dimension: z.record(DiagnoseDimensionSchema, z.array(z.string())),
  /** Upstream `see`-style metadata so consumers don't need to read the
   *  raw see envelope to get screenshot / dom / console info. */
  screenshot: SeeScreenshotSchema.nullable(),
  /** Persona id used for the upstream capture. */
  persona_id: z.string(),
  artifacts_dir: z.string(),
  /** Vision model id used for the diagnosis call. */
  model: z.string(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
  cache: ResultCacheMetaSchema.optional(),
  /** ADR-034 envelope. The diagnose primitive ALWAYS attaches the
   *  upstream see's full diagnostics object so report consumers can
   *  cross-reference findings to raw signal. */
  diagnostics: DiagnosticsSchema.optional(),
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
export type VisualVerdict = z.infer<typeof VisualVerdictSchema>;
export type VisualFinding = z.infer<typeof VisualFindingSchema>;
export type VisualScoring = z.infer<typeof VisualScoringSchema>;
export type DiagnoseSeverity = z.infer<typeof DiagnoseSeveritySchema>;
export type DiagnoseDimension = z.infer<typeof DiagnoseDimensionSchema>;
export type StandardsReference = z.infer<typeof StandardsReferenceSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type DiagnoseFinding = z.infer<typeof DiagnoseFindingSchema>;
export type DiagnoseDimensionScore = z.infer<typeof DiagnoseDimensionScoreSchema>;
export type DiagnoseResultShape = z.infer<typeof DiagnoseResultSchema>;
