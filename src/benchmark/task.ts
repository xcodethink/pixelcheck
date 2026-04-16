/**
 * Benchmark Task — WebArena-compatible task specification.
 *
 * We match the shape of WebArena's config_files/*.json so the same runner can
 * consume official WebArena tasks AND our own local mini-benchmark tasks
 * without translation.
 *
 * WebArena reference schema (subset we care about):
 *   {
 *     "task_id": "0001",
 *     "intent": "Find the cheapest laptop",
 *     "start_url": "https://shopping.webarena.com",
 *     "sites": ["shopping"],
 *     "eval": {
 *       "eval_types": ["string_match" | "url_match" | "program_html"],
 *       "reference_answers": { "must_include": ["..."], "exact_match": "..." },
 *       "reference_url": "https://.../checkout",
 *       "program_html": [{ "url": "...", "locator": "...", "required_contents": { ... } }]
 *     }
 *   }
 *
 * Our extensions (optional, backward-compatible with WebArena parsers):
 *   - difficulty: 'easy' | 'medium' | 'hard'
 *   - tags: free-form labels for filtering
 */

import { z } from "zod";

export const EvalTypeSchema = z.enum([
  "string_match",
  "url_match",
  "program_html",
  "page_image_query",
  "exact_match",
]);

export const ReferenceAnswersSchema = z
  .object({
    must_include: z.array(z.string()).optional(),
    must_exclude: z.array(z.string()).optional(),
    exact_match: z.string().optional(),
    fuzzy_match: z.array(z.string()).optional(),
  })
  .partial();

export const ProgramHtmlCheckSchema = z.object({
  url: z.string(),
  locator: z.string(),
  required_contents: z.record(z.unknown()).optional(),
});

export const TaskEvalSchema = z.object({
  eval_types: z.array(EvalTypeSchema).min(1),
  reference_answers: ReferenceAnswersSchema.optional(),
  reference_url: z.string().optional(),
  reference_url_match: z.enum(["exact", "prefix", "substring"]).default("exact"),
  program_html: z.array(ProgramHtmlCheckSchema).optional(),
});

export const BenchmarkTaskSchema = z.object({
  task_id: z.union([z.string(), z.number()]).transform((x) => String(x)),
  intent: z.string().min(1),
  start_url: z.string().min(1),
  sites: z.array(z.string()).default([]),
  eval: TaskEvalSchema,
  // Optional extensions
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  tags: z.array(z.string()).default([]),
  /** Persona id to run as (our extension). Defaults to a neutral US persona. */
  persona_id: z.string().optional(),
  /** Max actions cap for this task (our extension) */
  max_actions: z.number().int().positive().optional(),
  /** Budget override in USD */
  budget_usd: z.number().positive().optional(),
});

export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;
export type TaskEval = z.infer<typeof TaskEvalSchema>;
export type ReferenceAnswers = z.infer<typeof ReferenceAnswersSchema>;
