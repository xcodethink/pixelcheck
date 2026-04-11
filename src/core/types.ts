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
export type CustomStep = z.infer<typeof CustomStepSchema>;

// ─────────────────────────────────────────────────────────────
// Scenario
// ─────────────────────────────────────────────────────────────

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  goal: z.string(),
  applies_to: z.object({
    personas: z.array(z.string()).min(1),
  }),
  scoring_dimensions: z
    .array(
      z.enum([
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
      ]),
    )
    .default(["completion", "localization", "visual_polish"]),
  steps: z.array(StepSchema).min(1),
  persistent_storage: z.boolean().default(false),
});

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
  models: z
    .object({
      default: z.string().default("claude-sonnet-4-6"),
      critic: z.string().default("claude-sonnet-4-6"),
      computer_use: z.string().default("claude-opus-4-6"),
    })
    .default({
      default: "claude-sonnet-4-6",
      critic: "claude-sonnet-4-6",
      computer_use: "claude-opus-4-6",
    }),
  budget_usd: z.number().positive().default(3.0),
  redact_patterns: z.array(z.string()).default([]),
  notifications: z
    .object({
      slack_webhook_env: z.string().optional(),
      telegram_chat_id_env: z.string().optional(),
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
}

export interface AuditRun {
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
