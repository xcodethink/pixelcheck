/**
 * Critic Calibration — types.
 *
 * Each calibration sample pairs a screenshot with human-labeled truth for one
 * or more dimensions. The calibration runner invokes the critic against every
 * sample and measures agreement with the labels.
 *
 * We deliberately label a RANGE (min_score, max_score) rather than a point
 * because LLM scoring has irreducible variance; the goal is "directionally
 * correct", not "exact match".
 */

import { z } from "zod";

export const DimensionLabelSchema = z.object({
  dimension: z.string().min(1),
  /** Expected score range [min, max]. Inclusive. Scale: 0..10. */
  min_score: z.number().min(0).max(10),
  max_score: z.number().min(0).max(10),
  /** Human-written note explaining why this range */
  rationale: z.string().optional(),
});

export type DimensionLabel = z.infer<typeof DimensionLabelSchema>;

export const CalibrationSampleSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  /** Relative path to the screenshot file (resolved against fixtures dir) */
  screenshot: z.string(),
  /** Context metadata for the critic prompt */
  persona_id: z.string().default("us-desktop"),
  scenario_goal: z.string(),
  instruction: z.string(),
  /** Dimensions and their expected ranges */
  labels: z.array(DimensionLabelSchema).min(1),
  /** Optional issue expectations */
  expected_issues: z
    .object({
      min_critical: z.number().int().nonnegative().optional(),
      max_critical: z.number().int().nonnegative().optional(),
      must_flag_any_of: z.array(z.string()).optional(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
});

export type CalibrationSample = z.infer<typeof CalibrationSampleSchema>;

export interface DimensionAgreement {
  dimension: string;
  /** Score the critic returned (null if missing) */
  critic_score: number | null;
  expected_min: number;
  expected_max: number;
  in_range: boolean;
  /** How far outside the range (0 if in range) */
  distance: number;
}

export interface SampleAgreement {
  sample_id: string;
  description: string;
  tags: string[];
  per_dimension: DimensionAgreement[];
  /** Fraction of labeled dimensions in range */
  agreement_rate: number;
  /** Max distance across all labeled dimensions */
  max_distance: number;
  issue_check: {
    passed: boolean;
    detail: string;
  };
  cost_usd: number;
  duration_ms: number;
  error?: string;
}

export interface CalibrationReport {
  /** Result schema version (SemVer). Stamped by `aggregateReport`. */
  schema_version?: string;
  tag: string;
  model: string;
  started_at: string;
  finished_at: string;
  total_samples: number;
  /** Samples where ALL labeled dimensions landed in range AND issue_check passed */
  fully_aligned: number;
  /** Samples where ALL labeled dimensions landed in range (issues ignored) */
  dimensions_aligned: number;
  /** Mean agreement_rate across samples */
  mean_agreement: number;
  /** Mean max distance (how far off the worst dimension was) */
  mean_max_distance: number;
  per_dimension_stats: Record<
    string,
    { count: number; in_range: number; in_range_rate: number; avg_distance: number }
  >;
  samples: SampleAgreement[];
  total_cost_usd: number;
}
