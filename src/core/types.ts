import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Persona
// ─────────────────────────────────────────────────────────────

export const PersonaSchema = z.object({
  id: z.string().min(1),
  display_name: z.string(),
  country: z.string().length(2),
  language: z.string().min(2),
  locale: z.string().min(2),
  timezone: z.string(),
  device_class: z.enum(["desktop", "tablet", "mobile"]),
  ua_class: z
    .enum(["macbook", "windows", "ipad", "android-tablet", "iphone", "android"])
    .optional(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  payment_tier: z.enum(["free", "pro", "max", "power"]),
  proxy_env: z.string().optional(),
  mental_model: z.string(),
  critical_concerns: z.array(z.string()).default([]),
  test_credentials: z.record(z.string()).optional(),
});

export type Persona = z.infer<typeof PersonaSchema>;

// ─────────────────────────────────────────────────────────────
// Step types
// ─────────────────────────────────────────────────────────────

const BaseStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  critical: z.boolean().default(false),
  critical_review: z.boolean().default(false),
  retry: z.number().int().min(0).max(5).default(2),
  timeout: z.number().int().positive().optional(),
  fallback: z.enum(["computer_use", "skip", "fail"]).optional(),
  /**
   * Optional CSS/XPath selector hint for Layer 3 fallback.
   * When Stagehand semantic action fails, try direct Playwright click
   * using this selector before escalating to Computer Use.
   */
  selector_hint: z.string().optional(),
});

export const VisitStepSchema = BaseStepSchema.extend({
  type: z.literal("visit"),
  url: z.string(),
  wait_until: z
    .enum(["load", "domcontentloaded", "networkidle", "commit"])
    .default("domcontentloaded"),
});

export const ActStepSchema = BaseStepSchema.extend({
  type: z.literal("act"),
  instruction: z.string(),
});

export const ExtractStepSchema = BaseStepSchema.extend({
  type: z.literal("extract"),
  instruction: z.string(),
  schema: z.record(z.any()).optional(),
  store_as: z.string().optional(),
});

export const ObserveStepSchema = BaseStepSchema.extend({
  type: z.literal("observe"),
  instruction: z.string(),
  store_as: z.string().optional(),
});

export const WaitForStepSchema = BaseStepSchema.extend({
  type: z.literal("wait_for"),
  selector: z.string().optional(),
  text: z.string().optional(),
  ms: z.number().int().positive().optional(),
});

export const AssertVisualStepSchema = BaseStepSchema.extend({
  type: z.literal("assert_visual"),
  instruction: z.string(),
  // Free-form to allow scenario-specific dimensions like
  // information_density, payment_flow_clarity, workflow_visibility, etc.
  // The scoring_dimensions enum on the Scenario schema gates the canonical set.
  dimensions: z.array(z.string()).default(["visual_polish", "localization"]),
});

export const AssertDomStepSchema = BaseStepSchema.extend({
  type: z.literal("assert_dom"),
  selector: z.string(),
  expected: z
    .object({
      visible: z.boolean().optional(),
      text_contains: z.string().optional(),
      count: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const CheckEmailStepSchema = BaseStepSchema.extend({
  type: z.literal("check_email"),
  expected_subject_contains: z.string().optional(),
  expected_body_contains: z.string().optional(),
  language: z.string().optional(),
  wait_seconds: z.number().int().positive().default(60),
});

export const ScreenshotStepSchema = BaseStepSchema.extend({
  type: z.literal("screenshot"),
  full_page: z.boolean().default(true),
  label: z.string().optional(),
});

export const ComputerUseStepSchema = BaseStepSchema.extend({
  type: z.literal("computer_use"),
  task: z.string(),
  max_iterations: z.number().int().positive().default(15),
});

export const AssertA11yStepSchema = BaseStepSchema.extend({
  type: z.literal("assert_a11y"),
  /**
   * WCAG conformance level to test against. Default: wcag2aa.
   *
   * Note: axe-core's `runOnly` tag matching is exact, but conformance
   * levels are cumulative ("WCAG 2.2 AA" includes Level A). Internally
   * `handleAssertA11y` expands the value via `expandAxeStandard()`
   * (src/core/wcag.ts) before passing to axe — see ADR-030 / R-NEW-11.
   */
  standard: z
    .enum([
      "wcag2a",
      "wcag2aa",
      "wcag2aaa",
      "wcag21a",
      "wcag21aa",
      "wcag22a",
      "wcag22aa",
      "best-practice",
    ])
    .default("wcag2aa"),
  /** CSS selectors to exclude from analysis (e.g. cookie banners, third-party widgets) */
  exclude: z.array(z.string()).default([]),
  /** Minimum pass threshold. If violations exceed this, step fails. Default: 0 (any violation is a warn) */
  max_violations: z.number().int().nonnegative().default(0),
  /** Only report these impact levels. Default: all levels */
  impact_filter: z
    .array(z.enum(["critical", "serious", "moderate", "minor"]))
    .optional(),
});

export const CustomStepSchema = BaseStepSchema.extend({
  type: z.literal("custom"),
  handler: z.string(),
  inputs: z.record(z.any()).optional(),
});

export const StepSchema = z.discriminatedUnion("type", [
  VisitStepSchema,
  ActStepSchema,
  ExtractStepSchema,
  ObserveStepSchema,
  WaitForStepSchema,
  AssertVisualStepSchema,
  AssertDomStepSchema,
  AssertA11yStepSchema,
  CheckEmailStepSchema,
  ScreenshotStepSchema,
  ComputerUseStepSchema,
  CustomStepSchema,
]);

export type Step = z.infer<typeof StepSchema>;
export type VisitStep = z.infer<typeof VisitStepSchema>;
export type ActStep = z.infer<typeof ActStepSchema>;
export type ExtractStep = z.infer<typeof ExtractStepSchema>;
export type ObserveStep = z.infer<typeof ObserveStepSchema>;
export type WaitForStep = z.infer<typeof WaitForStepSchema>;
export type AssertVisualStep = z.infer<typeof AssertVisualStepSchema>;
export type AssertDomStep = z.infer<typeof AssertDomStepSchema>;
export type CheckEmailStep = z.infer<typeof CheckEmailStepSchema>;
export type ScreenshotStep = z.infer<typeof ScreenshotStepSchema>;
export type ComputerUseStep = z.infer<typeof ComputerUseStepSchema>;
export type AssertA11yStep = z.infer<typeof AssertA11yStepSchema>;
export type CustomStep = z.infer<typeof CustomStepSchema>;

// ─────────────────────────────────────────────────────────────
// Autonomous mode: Success Criteria, Hints, AgentConfig
// ─────────────────────────────────────────────────────────────

/**
 * Shape of the `expected` field, which varies by `verification` type.
 * Kept as a union so authors can mix-and-match per criterion.
 */
const ExpectedStateSchema = z
  .object({
    // dom
    visible: z.boolean().optional(),
    text_contains: z.string().optional(),
    // network
    url_pattern: z.string().optional(),
    method: z.string().optional(),
    status_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    max_duration_ms: z.number().int().positive().optional(),
    // performance
    lcp_max_ms: z.number().int().positive().optional(),
    cls_max: z.number().nonnegative().optional(),
    inp_max_ms: z.number().int().positive().optional(),
    fcp_max_ms: z.number().int().positive().optional(),
    ttfb_max_ms: z.number().int().positive().optional(),
    transfer_bytes_max: z.number().int().positive().optional(),
    // errors
    console_error_max: z.number().int().nonnegative().optional(),
    console_warning_max: z.number().int().nonnegative().optional(),
    pageerror_max: z.number().int().nonnegative().optional(),
    request_failure_max: z.number().int().nonnegative().optional(),
    ignore_patterns: z.array(z.string()).optional(),
    // interaction
    must_change: z.boolean().optional(),
    url_must_change: z.boolean().optional(),
    title_must_change: z.boolean().optional(),
    interactive_must_change: z.boolean().optional(),
    min_text_length_delta: z.number().int().optional(),
  })
  .partial();

export const SuccessCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  /**
   * How to verify:
   * - 'visual'       — screenshot + LLM scoring
   * - 'dom'          — selector check (visible / text_contains)
   * - 'extract'      — data extraction + regex match
   * - 'network'      — HTTP request(s) matching url/method/status/duration
   * - 'performance'  — Core Web Vitals thresholds
   * - 'error'        — zero (or bounded) console/pageerror/request failures
   * - 'interaction'  — action must produce an observable page state change
   */
  verification: z
    .enum(["visual", "dom", "extract", "network", "performance", "error", "interaction"])
    .default("visual"),
  /** For dom verification: CSS selector to check */
  selector: z.string().optional(),
  /** For extract verification: instruction to extract */
  extract_instruction: z.string().optional(),
  /** For extract verification: regex pattern */
  expected_pattern: z.string().optional(),
  /** Unified expectation bag (fields relevant per verification type) */
  expected: ExpectedStateSchema.optional(),
});

export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

export const HintSchema = z.object({
  /** When this hint applies (e.g., "when cookie banner appears") */
  condition: z.string(),
  /** What to do */
  suggestion: z.string(),
  /** Optional selector to target */
  selector: z.string().optional(),
});

export type Hint = z.infer<typeof HintSchema>;

export const AgentConfigSchema = z.object({
  /** Max total actions before forced stop */
  max_actions: z.number().int().positive().default(30),
  /** Max consecutive failures before replanning */
  replan_threshold: z.number().int().positive().default(3),
  /** Max replans before giving up */
  max_replans: z.number().int().positive().default(3),
  /** Planner model override */
  planner_model: z.string().optional(),
  /** Navigator model override */
  navigator_model: z.string().optional(),
  /** Screenshot frequency: 'every_action' | 'on_decision' | 'on_failure' */
  screenshot_frequency: z.enum(["every_action", "on_decision", "on_failure"]).default("every_action"),
  /** Enable persona-aware reasoning (adds persona context to every LLM call) */
  persona_reasoning: z.boolean().default(true),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ─────────────────────────────────────────────────────────────
// Scoring Dimensions Enum (shared)
// ─────────────────────────────────────────────────────────────

export const ScoringDimensionEnum = z.enum([
  "completion",
  "localization",
  "visual_polish",
  "trust_signals",
  "time_to_value",
  "error_density",
  "ui_consistency",
  "data_integrity",
  "payment_flow_clarity",
  "workflow_visibility",
  "output_quality",
  "email_design",
  "compliance",
  "extension_responsiveness",
  "ai_quality",
  "sync_reliability",
  "information_density",
  "accessibility",
]);

// ─────────────────────────────────────────────────────────────
// Scenario (backward-compatible: supports both scripted and autonomous)
// ─────────────────────────────────────────────────────────────

export const ScenarioSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    goal: z.string(),
    applies_to: z.object({
      personas: z.array(z.string()).min(1),
    }),
    scoring_dimensions: z
      .array(ScoringDimensionEnum)
      .default(["completion", "localization", "visual_polish"]),

    /** Execution mode. Default: "scripted" (backward compatible) */
    mode: z.enum(["scripted", "autonomous"]).default("scripted"),

    // Scripted mode fields
    steps: z.array(StepSchema).optional(),

    // Autonomous mode fields
    /** Starting URL for autonomous exploration */
    start_url: z.string().optional(),
    /** Success criteria that the agent must satisfy */
    success_criteria: z.array(SuccessCriterionSchema).optional(),
    /** Hints to guide the agent */
    hints: z.array(HintSchema).optional(),
    /** Per-scenario agent configuration overrides */
    agent_config: AgentConfigSchema.optional(),

    persistent_storage: z.boolean().default(false),
  })
  .refine(
    (s) => {
      if (s.mode === "autonomous") {
        return (
          s.success_criteria !== undefined &&
          s.success_criteria.length > 0 &&
          s.start_url !== undefined &&
          s.start_url.length > 0
        );
      }
      return s.steps !== undefined && s.steps.length > 0;
    },
    {
      message:
        "Autonomous mode requires success_criteria[] and start_url; scripted mode requires steps[]",
    },
  );

export type Scenario = z.infer<typeof ScenarioSchema>;

// ─────────────────────────────────────────────────────────────
// Project config
// ─────────────────────────────────────────────────────────────

export const ProjectConfigSchema = z.object({
  project_name: z.string(),
  base_url: z.string().url(),
  admin_url: z.string().url().optional(),
  default_concurrency: z.number().int().min(1).max(10).default(3),
  default_timeout_ms: z.number().int().positive().default(30_000),
  /**
   * Default report locale for PDF / trends / diff output. CLI
   * `--locale <code>` overrides per-invocation. Supported codes:
   * en | zh-CN | ja | es | de. Unknown codes fall back to en.
   */
  default_locale: z
    .enum(["en", "zh-CN", "ja", "es", "de"])
    .default("en"),
  models: z
    .object({
      default: z.string().default("claude-sonnet-4-6"),
      critic: z.string().default("claude-sonnet-4-6"),
      computer_use: z.string().default("claude-opus-4-6"),
      /** Model for initial autonomous plan generation */
      planner: z.string().default("claude-opus-4-6"),
      /** Model for per-action navigator decisions (strong/fallback tier) */
      navigator: z.string().default("claude-sonnet-4-6"),
      /** Model for plan revisions (cheaper than initial plan) */
      replan: z.string().default("claude-sonnet-4-6"),
      /** Economy-tier navigator — used as primary when cost_mode='balanced'|'economy' */
      navigator_economy: z.string().default("claude-haiku-4-5-20251001"),
    })
    .default({
      default: "claude-sonnet-4-6",
      critic: "claude-sonnet-4-6",
      computer_use: "claude-opus-4-6",
      planner: "claude-opus-4-6",
      navigator: "claude-sonnet-4-6",
      replan: "claude-sonnet-4-6",
      navigator_economy: "claude-haiku-4-5-20251001",
    }),
  /**
   * Cost/quality tradeoff profile:
   *   'max'       — Sonnet navigator on every action, Opus initial plan (v0.2 behavior)
   *   'balanced'  — Haiku navigator primary, Sonnet escalation on low confidence (default)
   *   'economy'   — Haiku navigator only, no escalation (cheapest; lower accuracy)
   * Override per-run with AUDIT_COST_MODE=max|balanced|economy.
   */
  cost_mode: z.enum(["max", "balanced", "economy"]).default("balanced"),
  budget_usd: z.number().positive().default(3.0),
  redact_patterns: z.array(z.string()).default([]),
  notifications: z
    .object({
      slack_webhook_env: z.string().optional(),
      telegram_chat_id_env: z.string().optional(),
    })
    .optional(),
  /** Default agent configuration for autonomous scenarios */
  agent: z
    .object({
      default_max_actions: z.number().int().positive().default(30),
      default_replan_threshold: z.number().int().positive().default(3),
      default_max_replans: z.number().int().positive().default(3),
      /** Check visual criteria every N actions (reduces LLM cost) */
      criteria_check_interval: z.number().int().positive().default(3),
      /** Max interactive elements in DOM summary */
      dom_summary_max_elements: z.number().int().positive().default(50),
    })
    .optional(),
  /** Observer dashboard configuration */
  observer: z
    .object({
      port: z.number().int().positive().default(3847),
      stream_fps: z.number().int().positive().default(10),
      persist_events: z.boolean().default(true),
    })
    .optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ─────────────────────────────────────────────────────────────
// Run results
// ─────────────────────────────────────────────────────────────

export interface StepResult {
  step_id: string;
  step_type: Step["type"];
  status: "pass" | "fail" | "warn" | "skip";
  duration_ms: number;
  screenshot?: string;
  screenshot_sha256?: string;
  output?: unknown;
  error?: string;
  console_errors?: ConsoleError[];
  retries_used: number;
  /**
   * Which execution method ultimately succeeded (Reliability Stack tracking).
   * Absent = primary method (Stagehand) succeeded on first try.
   */
  execution_method?: "stagehand" | "selector_hint" | "instruction_mutation" | "computer_use";
  /**
   * Optional signal bundle captured during the step (autonomous mode).
   * Types are `unknown` at this layer to avoid a circular dep back into signal modules;
   * the agent loop fills this with network/performance/error/interaction snapshots.
   */
  signals?: {
    network?: unknown;
    performance?: unknown;
    errors?: unknown;
    interaction?: unknown;
  };
}

export interface ConsoleError {
  type: "console" | "pageerror" | "requestfailed";
  text: string;
  location?: string;
  timestamp: string;
}

export interface DimensionScore {
  dimension: string;
  score: number; // 0-10
  justification: string;
}

export interface Issue {
  severity: "critical" | "high" | "medium" | "low";
  step_id?: string;
  dimension?: string;
  description: string;
  screenshot?: string;
  recommendation: string;
  /**
   * WCAG 2.x conformance level the violation is graded at, when this
   * issue came from an accessibility audit step (axe-core).
   * Absent for vision-critic-only issues. See src/core/wcag.ts.
   */
  wcag_level?: "A" | "AA" | "AAA";
  /**
   * Dotted WCAG Success Criterion id ("1.4.3", "2.1.1", etc.) when
   * the violation maps to a specific clause. Used by reporters to
   * group accessibility issues for compliance teams (ADA / EAA /
   * Section 508). See src/core/wcag.ts for the catalog.
   */
  wcag_criterion?: string;
}

export interface ScenarioRunResult {
  scenario_id: string;
  scenario_name: string;
  persona_id: string;
  persona_display_name: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: "pass" | "pass_with_issues" | "fail";
  fingerprint_id: string;
  steps: StepResult[];
  scores: DimensionScore[];
  overall_score: number;
  issues: Issue[];
  artifacts: {
    video?: string;
    har?: string;
    console_log?: string;
    storage_state?: string;
  };
  cost_usd: number;
  /** Present only for autonomous mode runs */
  agent_summary?: {
    mode: "autonomous";
    plan_count: number;
    total_actions: number;
    criteria_met: string[];
    criteria_missed: string[];
    convergence_reason: "goal_met" | "budget_exceeded" | "max_actions" | "max_replans" | "no_progress" | "error";
  };
}

export interface AuditRun {
  /**
   * Result schema version (SemVer). Stamped by `runAudit` from
   * `RESULT_SCHEMA_VERSION` in `result-schema.ts`. Optional in the type so
   * legacy fixtures and historical JSON files still parse; producers always
   * set it on freshly emitted runs.
   */
  schema_version?: string;
  run_id: string;
  project_name: string;
  base_url: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  results: ScenarioRunResult[];
  summary: {
    total: number;
    pass: number;
    pass_with_issues: number;
    fail: number;
    total_cost_usd: number;
    total_issues: number;
    critical_issues: number;
  };
  config: ProjectConfig;
  /** Patterns the reporter should redact from output */
  redact_patterns?: string[];
}
