#!/usr/bin/env tsx
/**
 * Export every public result Zod schema as JSON Schema (Draft 7) to
 * docs/schemas/. Output is checked in so external AI agents and consumers
 * can fetch the contract directly from GitHub raw without running this
 * package. (M9-2 C4)
 *
 * Run:  npm run schemas
 * Output: docs/schemas/<name>.schema.json + docs/schemas/index.json
 *
 * The exported files are derived purely from src/core/result-schema.ts —
 * never edit them by hand. Bump RESULT_SCHEMA_VERSION there and re-run
 * this script per the SemVer policy in docs/contracts/RESULT_SCHEMA.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";

import {
  RESULT_SCHEMA_VERSION,
  AuditRunSchema,
  ScenarioRunResultSchema,
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
  HistoryEntrySchema,
  PersonaSummarySchema,
  ConsoleErrorSchema,
  SeeResultSchema,
  ActResultSchema,
  ExtractResultSchema,
  JudgeResultSchema,
  CompareResultSchema,
  DiagnoseResultSchema,
  ResultCacheMetaSchema,
  ListCapabilitiesResultSchema,
  ToolCapabilitySchema,
  EnvVarDocSchema,
  CostEstimateSchema,
  CacheInfoSchema,
} from "../src/core/result-schema.js";

interface SchemaEntry {
  /** File-name slug (e.g., "audit-run") */
  slug: string;
  /** Human-friendly title for the JSON Schema document */
  title: string;
  /** One-line summary the index manifest exposes */
  description: string;
  /** The Zod schema to export */
  schema: z.ZodTypeAny;
}

const ENTRIES: SchemaEntry[] = [
  {
    slug: "audit-run",
    title: "AuditRun",
    description:
      "The top-level result of a `runAudit` invocation. Written to audit.json and returned by the audit_url MCP tool's `report_json` artefact.",
    schema: AuditRunSchema,
  },
  {
    slug: "scenario-run-result",
    title: "ScenarioRunResult",
    description: "Per-(scenario, persona) execution result — nested under AuditRun.results[].",
    schema: ScenarioRunResultSchema,
  },
  {
    slug: "step-result",
    title: "StepResult",
    description: "Per-step execution record. Includes status, retries, execution_method, and optional signals.",
    schema: StepResultSchema,
  },
  {
    slug: "issue",
    title: "Issue",
    description: "A single audit issue (severity + description + recommendation).",
    schema: IssueSchema,
  },
  {
    slug: "dimension-score",
    title: "DimensionScore",
    description: "Score for one scoring dimension on a 0..10 scale with a justification string.",
    schema: DimensionScoreSchema,
  },
  {
    slug: "console-error",
    title: "ConsoleError",
    description: "A captured browser console error / pageerror / failed request.",
    schema: ConsoleErrorSchema,
  },
  {
    slug: "critic-result",
    title: "CriticResult",
    description: "Output of the vision critic (runCritic).",
    schema: CriticResultSchema,
  },
  {
    slug: "gate-result",
    title: "GateResult",
    description: "Calibration gate verdict (passed + violations + computed metrics).",
    schema: GateResultSchema,
  },
  {
    slug: "calibration-report",
    title: "CalibrationReport",
    description: "Full calibration run report with per-sample agreement details.",
    schema: CalibrationReportSchema,
  },
  {
    slug: "benchmark-report",
    title: "BenchmarkReport",
    description: "Aggregate benchmark report (pass@1, by_difficulty, by_tag, durations).",
    schema: BenchmarkReportSchema,
  },
  {
    slug: "benchmark-task-result",
    title: "BenchmarkTaskResult",
    description: "Per-task benchmark result.",
    schema: BenchmarkTaskResultSchema,
  },
  {
    slug: "mutation-result",
    title: "MutationResult",
    description: "Single instruction-mutation variant (rephrase | decompose | specific).",
    schema: MutationResultSchema,
  },
  {
    slug: "audit-url-result",
    title: "AuditUrlResult",
    description: "MCP tool envelope returned by audit_url.",
    schema: AuditUrlResultSchema,
  },
  {
    slug: "explore-url-result",
    title: "ExploreUrlResult",
    description: "MCP tool envelope returned by explore_url.",
    schema: ExploreUrlResultSchema,
  },
  {
    slug: "calibrate-critic-result",
    title: "CalibrateCriticResult",
    description: "MCP tool envelope returned by calibrate_critic.",
    schema: CalibrateCriticResultSchema,
  },
  {
    slug: "see-result",
    title: "SeeResult",
    description:
      "MCP tool envelope returned by `see` (N-1 primitive). One-shot navigation snapshot: DOM summary, console errors, screenshot, and an optional vision note.",
    schema: SeeResultSchema,
  },
  {
    slug: "act-result",
    title: "ActResult",
    description:
      "MCP tool envelope returned by `act` (N-2 primitive). Per-step outcome of an action sequence (goto / click / fill / press / wait / wait_for / scroll / screenshot / act / note) plus a final DOM summary, console errors, and screenshot.",
    schema: ActResultSchema,
  },
  {
    slug: "extract-result",
    title: "ExtractResult",
    description:
      "MCP tool envelope returned by `extract` (N-4 primitive). Schema-bound structured extraction: caller passes a JSON Schema describing the desired shape, the primitive runs Stagehand's extract() and returns matching `data` plus DOM summary, console errors, and screenshot.",
    schema: ExtractResultSchema,
  },
  {
    slug: "judge-result",
    title: "JudgeResult",
    description:
      "MCP tool envelope returned by `judge` (N-8 primitive). Single-page rubric-driven critic — captures a screenshot+DOM and runs one vision call against the chosen rubric(s) (aesthetic, dark_pattern, custom), returning per-criterion verdicts (0..10 score + rationale + evidence) and severity-graded findings.",
    schema: JudgeResultSchema,
  },
  {
    slug: "compare-result",
    title: "CompareResult",
    description:
      "MCP tool envelope returned by `compare` (N-3 primitive). A/B comparison primitive. Default mode is `double_blind`: judges each side independently with the same rubric, then runs a synthesis vision call that sees both screenshots and emits per-criterion winners. `fast` mode collapses to a single side-by-side call (cheaper but susceptible to anchoring bias).",
    schema: CompareResultSchema,
  },
  {
    slug: "diagnose-result",
    title: "DiagnoseResult",
    description:
      "MCP tool envelope returned by `diagnose` (PR-E preset / ADR-034). Holistic page-health diagnosis. Captures the URL with eager visual scoring, reads every diagnostics dimension (performance / network / popups / cookies / storage / visual), and returns a commercial-grade structured report: per-finding severity + dimension + confidence + evidence_refs + standards_mapping (Core Web Vitals / WCAG / OWASP / GDPR), a 0-100 overall_health_score, per-dimension drill-down scores, and a CTO-readable executive_summary.",
    schema: DiagnoseResultSchema,
  },
  {
    slug: "list-personas-result",
    title: "ListPersonasResult",
    description: "MCP tool envelope returned by list_personas (array of PersonaSummary).",
    schema: ListPersonasResultSchema,
  },
  {
    slug: "list-scenarios-result",
    title: "ListScenariosResult",
    description: "MCP tool envelope returned by list_scenarios (array of YAML file names).",
    schema: ListScenariosResultSchema,
  },
  {
    slug: "history-entry",
    title: "HistoryEntry",
    description: "Compact summary of a historical audit run as returned by get_last_report.",
    schema: HistoryEntrySchema,
  },
  {
    slug: "persona-summary",
    title: "PersonaSummary",
    description: "Short persona descriptor used inside ListPersonasResult.",
    schema: PersonaSummarySchema,
  },
  {
    slug: "result-cache-meta",
    title: "ResultCacheMeta",
    description:
      "Annotation attached by the result cache (M9-4) to primitive result envelopes (see / act / extract / judge / compare). Distinguishes cache hit / miss / not-applicable. On hit the original cost moves to `cost_saved_usd` and the envelope's `cost_usd` is zeroed.",
    schema: ResultCacheMetaSchema,
  },
  {
    slug: "list-capabilities-result",
    title: "ListCapabilitiesResult",
    description:
      "MCP tool envelope returned by `list_capabilities` (M9-5). Self-describes the server: every shipped tool with its kind, input schema, result schema title, cacheability, static cost-estimate band, side-effects, and dependency declarations; plus the public env-var table and M9-4 cache state. Static introspection — no LLM, no browser, no runtime probe of secrets.",
    schema: ListCapabilitiesResultSchema,
  },
  {
    slug: "tool-capability",
    title: "ToolCapability",
    description:
      "Per-tool descriptor inside ListCapabilitiesResult.tools[]. Mirrors the MCP `tools/list` shape (name / description / kind / input_schema / result_schema) and adds the richer fields that are deliberately not in the spec-level catalog: cacheable, cost_estimate_usd, side_effects, requires.",
    schema: ToolCapabilitySchema,
  },
  {
    slug: "env-var-doc",
    title: "EnvVarDoc",
    description:
      "Documentation for one environment variable that influences server behaviour, returned inside ListCapabilitiesResult.env[]. Names secrets but never values; `required: true` is a static dependency declaration, not a presence probe.",
    schema: EnvVarDocSchema,
  },
  {
    slug: "cost-estimate",
    title: "CostEstimate",
    description:
      "Static cost band ({typical, min, max, unit, notes?}) for one invocation of a tool. Used by AI agents at plan time to budget calls. Real spend is reported on each tool's envelope `cost_usd`.",
    schema: CostEstimateSchema,
  },
  {
    slug: "cache-info",
    title: "CacheInfo",
    description:
      "Live state of the M9-4 result cache (enabled / ttl_ms_default / path) inside ListCapabilitiesResult.cache. Path is exposed for diagnostics (paths are not secrets); the cache file's contents stay opaque.",
    schema: CacheInfoSchema,
  },
];

function repoOutDir(): string {
  // This script lives at <repo>/scripts/export-result-schemas.ts at runtime.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "docs", "schemas");
}

function main(): void {
  const outDir = repoOutDir();
  fs.mkdirSync(outDir, { recursive: true });

  const indexEntries: Array<{ slug: string; title: string; description: string; file: string }> = [];

  for (const entry of ENTRIES) {
    const json = zodToJsonSchema(entry.schema, {
      name: entry.title,
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as Record<string, unknown>;

    // Stamp identification at the top of every emitted document so consumers
    // can match by $id / x-schema-version without parsing structure.
    const wrapped = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: `https://github.com/xcodethink/pixelcheck/blob/main/docs/schemas/${entry.slug}.schema.json`,
      title: entry.title,
      description: entry.description,
      "x-result-schema-version": RESULT_SCHEMA_VERSION,
      ...json,
    };

    const outPath = path.join(outDir, `${entry.slug}.schema.json`);
    fs.writeFileSync(outPath, JSON.stringify(wrapped, null, 2) + "\n", "utf8");
    indexEntries.push({
      slug: entry.slug,
      title: entry.title,
      description: entry.description,
      file: `${entry.slug}.schema.json`,
    });
    process.stdout.write(`wrote ${path.relative(process.cwd(), outPath)}\n`);
  }

  const index = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "AI Browser Auditor — result schemas index",
    "x-result-schema-version": RESULT_SCHEMA_VERSION,
    description:
      "Index of every public result schema. Generated from src/core/result-schema.ts; do not edit by hand. See docs/contracts/RESULT_SCHEMA.md for the SemVer policy.",
    schemas: indexEntries,
  };
  const indexPath = path.join(outDir, "index.json");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${path.relative(process.cwd(), indexPath)}\n`);
  process.stdout.write(`done — ${indexEntries.length} schemas at version ${RESULT_SCHEMA_VERSION}\n`);
}

main();
