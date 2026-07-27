/**
 * `diagnose` primitive (PR-E / ADR-034) — holistic page-health diagnosis.
 *
 * Where `judge` answers "score this page against a rubric" and `compare`
 * answers "which of A vs B is better", `diagnose` answers
 *
 *     "what is wrong with this page, why, and how should it be fixed".
 *
 * Pipeline:
 *   1. Run `see({ url, visualScoring: 'eager' })` — captures the page,
 *      whitebox / performance / visual diagnostics, and a screenshot.
 *   2. Serialise every diagnostics dimension into a vision-call prompt
 *      ("Network: 47 requests, 2 failed (https://api.x.com/... 503)
 *      | Performance: LCP=4200ms (poor) | Visual: aesthetic score 5.5,
 *      contrast finding flagged | ...").
 *   3. One vision call (Claude Sonnet by default) reads the prompt +
 *      screenshot and emits structured findings: severity / dimension /
 *      title / description / root_cause / recommendation / confidence /
 *      evidence_refs / standards_mapping.
 *   4. Compose the final commercial-grade report:
 *      - executive_summary (≤ 3 sentences)
 *      - overall_health_score (0..100, severity-weighted)
 *      - dimension_scores (per-dimension drill-down)
 *      - findings_by_dimension (index for grouped rendering)
 *      - findings sorted severity desc, confidence desc
 *
 * Anti-hallucination contract: every finding (severity != 'low') MUST
 * cite at least one `evidence_ref` pointing at a real diagnostics field.
 * The post-parse validator drops findings that violate this rule rather
 * than emit a fabricated diagnosis.
 *
 * Cost: 1 LLM cost from `see` (only if `goal` was set, typically 0)
 *     + 1 vision call for visual scoring (visualScoring='eager')
 *     + 1 vision call for the diagnosis itself
 *     ≈ $0.02-0.04 per call. Documented in ToolDefinition cost band.
 *
 * Test seams: `_see` (replace upstream capture) + `_callVision` (stub
 * the diagnosis vision call). Production callers never set these.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { getLogger } from "../logger.js";
import { callVision, extractJson } from "../llm.js";
import { compressForVisionMulti, MULTI_IMAGE_PROMPT_NOTE } from "../image.js";
import {
  RESULT_SCHEMA_VERSION,
  type DiagnoseDimension,
  type DiagnoseFinding,
  type DiagnoseDimensionScore,
  type DiagnoseResultShape,
  type DiagnoseSeverity,
  type EvidenceRef,
  type StandardsReference,
} from "../result-schema.js";
import { withResultCache } from "../result-cache.js";
import {
  see,
  type SeeOptions,
  type SeePersonaHints,
  type SeeResult,
  type WaitFor,
} from "./see.js";
import type { JudgeRubricKind, JudgeCriterionSpec } from "../result-schema.js";

const log = getLogger("primitive.diagnose");

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export interface DiagnoseOptions {
  /** Target URL. Required. */
  url: string;
  /** Persona-shaped hints forwarded to upstream see. */
  persona?: SeePersonaHints;
  /** Page wait strategy after navigation. Default `"networkidle"`. */
  waitFor?: WaitFor;
  /** Override viewport. Default: persona viewport, else 1280x800. */
  viewport?: { width: number; height: number };
  /** Per-navigation timeout ms. Default 30000. */
  timeoutMs?: number;
  /** Run headless. Default true. */
  headless?: boolean;
  /** Where to write per-call artifacts. Default `$AUDIT_DIAGNOSE_DIR`
   *  or `~/.pixelcheck/diagnoses/`. */
  artifactsRoot?: string;
  /** Diagnosis vision model id. Default `"claude-sonnet-4-6"`. */
  model?: string;
  /** Visual rubrics for the upstream visualScoring='eager' call. */
  visualRubrics?: JudgeRubricKind[];
  /** Caller-supplied custom criteria forwarded to visual scoring. */
  visualCustomCriteria?: Array<Omit<JudgeCriterionSpec, "kind">>;
  /** Vision model used for visual scoring. Default same as `model`. */
  visualModel?: string;

  /** Result cache (M9-4). Default on. */
  cache?: boolean;
  cacheBust?: boolean;
  cacheTtlMs?: number;

  /** Test seams. */
  _see?: typeof see;
  _callVision?: typeof callVision;
}

export type DiagnoseResult = DiagnoseResultShape;

// ─────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────

export const DEFAULT_DIAGNOSE_PERSONA_ID = "diagnose-default-desktop";
export const DEFAULT_DIAGNOSE_MODEL = "claude-sonnet-4-6";

export function defaultDiagnoseArtifactsRoot(): string {
  const envDir = process.env.AUDIT_DIAGNOSE_DIR;
  if (envDir && envDir.length > 0) return envDir;
  const home =
    process.env.PIXELCHECK_HOME ??
    process.env.AUDIT_HOME ??
    path.join(os.homedir(), ".pixelcheck");
  return path.join(home, "diagnoses");
}

function makeRunDir(root: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const dir = path.join(root, `${ts}-${rand}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ─────────────────────────────────────────────────────────────
// Diagnostics → prompt serialisation
// ─────────────────────────────────────────────────────────────

/**
 * Render the diagnostics envelope into a compact, deterministic string
 * the vision model can read. We intentionally include EVERY dimension
 * (even when empty / null) so the model knows "we looked, here's nothing"
 * vs "we didn't look at all" — both branches inform the diagnosis.
 *
 * Each line uses a stable JSON-pointer-style label so the model can
 * cite back into `evidence_refs[].path`.
 */
export function serializeDiagnosticsForPrompt(
  diagnostics: SeeResult["diagnostics"] | undefined,
): string {
  if (!diagnostics) return "(no diagnostics envelope — upstream capture did not attach collectors)";
  const lines: string[] = [];

  // Performance
  const perf = diagnostics.performance;
  if (perf) {
    lines.push("# performance");
    lines.push(`/diagnostics/performance/lcp_ms = ${fmtN(perf.lcp_ms)}  (Core Web Vitals: good ≤ 2500, needs improvement ≤ 4000, poor > 4000)`);
    lines.push(`/diagnostics/performance/cls = ${fmtN(perf.cls)}  (good ≤ 0.1, needs improvement ≤ 0.25, poor > 0.25)`);
    lines.push(`/diagnostics/performance/inp_ms = ${fmtN(perf.inp_ms)}  (good ≤ 200, needs improvement ≤ 500, poor > 500)`);
    lines.push(`/diagnostics/performance/fcp_ms = ${fmtN(perf.fcp_ms)}  (good ≤ 1800)`);
    lines.push(`/diagnostics/performance/ttfb_ms = ${fmtN(perf.ttfb_ms)}  (good ≤ 800)`);
    lines.push(`/diagnostics/performance/dom_content_loaded_ms = ${fmtN(perf.dom_content_loaded_ms)}`);
    lines.push(`/diagnostics/performance/load_ms = ${fmtN(perf.load_ms)}`);
    lines.push(`/diagnostics/performance/transfer_bytes = ${perf.transfer_bytes}`);
    lines.push(`/diagnostics/performance/resources/total = ${perf.resources.total}`);
    lines.push("");
  } else {
    lines.push("# performance: (collector did not run)\n");
  }

  // Network (whitebox)
  const net = diagnostics.network;
  if (net) {
    lines.push("# network (whitebox)");
    lines.push(`/diagnostics/network/request_count = ${net.request_count}`);
    lines.push(`/diagnostics/network/failure_count = ${net.failure_count}`);
    if (net.failures.length > 0) {
      lines.push(`/diagnostics/network/failures (first 10):`);
      for (const f of net.failures.slice(0, 10)) {
        lines.push(`  - ${f.method} ${f.url} → ${f.error_text}`);
      }
    }
    lines.push("");
  }

  // Popups (whitebox)
  const popups = diagnostics.popups ?? [];
  if (popups.length > 0) {
    lines.push("# popups (whitebox)");
    for (const p of popups) {
      lines.push(
        `/diagnostics/popups/${p.index} = ${p.closed ? "closed" : "open"} | url=${p.url || "(none)"} | title=${JSON.stringify(p.title)}`,
      );
    }
    lines.push("");
  }

  // Cookies (whitebox) — counts only; values already redacted upstream
  const cookies = diagnostics.cookies ?? [];
  if (cookies.length > 0) {
    const httpOnly = cookies.filter((c) => c.http_only).length;
    const secure = cookies.filter((c) => c.secure).length;
    lines.push("# cookies (whitebox)");
    lines.push(`/diagnostics/cookies/count = ${cookies.length}`);
    lines.push(`/diagnostics/cookies/http_only_count = ${httpOnly}`);
    lines.push(`/diagnostics/cookies/secure_count = ${secure}`);
    lines.push("");
  }

  // Storage (whitebox)
  const storage = diagnostics.storage;
  if (storage) {
    lines.push("# storage (whitebox)");
    lines.push(`/diagnostics/storage/local_storage_keys = ${storage.local_storage_keys}`);
    lines.push(`/diagnostics/storage/session_storage_keys = ${storage.session_storage_keys}`);
    lines.push("");
  }

  // Visual (PR-D)
  const visual = diagnostics.visual;
  if (visual) {
    lines.push("# visual (rubric-based scoring)");
    lines.push(`/diagnostics/visual/scored = ${visual.scored}`);
    if (visual.scored) {
      lines.push(`/diagnostics/visual/overall_score = ${fmtN(visual.overall_score)}  (0..10 scale, higher better)`);
      lines.push(`/diagnostics/visual/rubrics = [${visual.rubrics.join(", ")}]`);
      for (const v of visual.verdicts) {
        lines.push(
          `/diagnostics/visual/verdicts/${v.criterion_id} = ${v.score}/10 | ${v.label} | ${v.rationale}`,
        );
      }
      for (const f of visual.findings) {
        lines.push(
          `/diagnostics/visual/findings = [${f.severity}] ${f.description}${f.location ? ` @ ${f.location}` : ""}`,
        );
      }
    } else {
      lines.push(`/diagnostics/visual/skip_reason = ${visual.skip_reason}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function fmtN(v: number | null | undefined): string {
  if (v === null || v === undefined) return "null";
  return String(v);
}

// ─────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────

const VALID_DIMENSIONS: DiagnoseDimension[] = [
  "performance",
  "visual",
  "whitebox",
  "security",
  "accessibility",
  "seo",
  "privacy",
  "cross_cutting",
];

const VALID_SEVERITIES: DiagnoseSeverity[] = ["critical", "high", "medium", "low"];

export function buildDiagnoseSystemPrompt(): string {
  return `You are a senior product-engineering auditor producing a commercial-grade page-health diagnosis. The audience is a CTO who needs to triage what to fix in the next sprint, plus the engineers who will fix it.

You are given:
  1. A screenshot of the page (full-page or viewport — use it for visual evidence).
  2. A diagnostics envelope summarising six observed dimensions (performance / network / popups / cookies / storage / visual scoring) with concrete numeric values and JSON-pointer paths to each field.

Your job is to emit a structured commercial-grade diagnosis.

# Output schema (single JSON object)

{
  "executive_summary": string (≤ 3 sentences, PM/CTO readable, dominant story only),
  "findings": [
    {
      "id": string (snake_case, stable across runs of the same issue, e.g. "lcp_above_poor_threshold"),
      "severity": "critical" | "high" | "medium" | "low",
      "dimension": "performance" | "visual" | "whitebox" | "security" | "accessibility" | "seo" | "privacy" | "cross_cutting",
      "title": string (one sentence),
      "description": string (2-5 sentences explaining the problem),
      "root_cause": string (1-3 sentences inferring why),
      "recommendation": string (1-3 sentences, concrete and actionable),
      "confidence": number 0..1 (your certainty this is a real defect, not a false positive),
      "evidence_refs": [
        { "path": "/diagnostics/...", "value": "...", "note": "optional one-sentence why this supports the finding" }
      ],
      "standards_mapping": [
        { "framework": "Core Web Vitals" | "WCAG 2.2" | "OWASP Top 10 2021" | "GDPR" | ... ,
          "id": "LCP" | "SC 1.4.3" | "A01:2021" | ... ,
          "url": "https://...",
          "label": "..." }
      ],
      "affected_location": string (optional, physical area on screen),
      "affected_url": string (optional, e.g. failing network request),
      "affected_selector": string (optional, CSS selector)
    }
  ]
}

# Anti-hallucination rules (MANDATORY — false positives are worse than misses)

1. EVERY finding with severity 'critical' / 'high' / 'medium' MUST include at least one \`evidence_refs\` entry pointing at a SPECIFIC diagnostics field path supplied in the input. If you cannot cite a path, drop the finding.
2. \`evidence_refs[].value\` must be the actual value from the input, character for character. Do NOT round or paraphrase.
3. Visual findings (dimension='visual') must reference paths like /diagnostics/visual/findings or /diagnostics/visual/verdicts/<id>. Performance findings must reference /diagnostics/performance/* paths. Etc.
4. Do NOT fabricate findings about dimensions whose collectors did not run. If /diagnostics/performance is "(collector did not run)", do NOT emit performance findings.
5. \`confidence\` calibration: 1.0 only when the diagnostics value clearly violates a published threshold (e.g. LCP > 4000 violates Core Web Vitals "poor"). Use 0.5-0.8 for inferred issues. Below 0.5 means you should probably drop the finding.
6. Map to industry standards whenever possible: Core Web Vitals (LCP/CLS/INP/FCP/TTFB), WCAG 2.2 (contrast, target size, focus), OWASP Top 10 2021 (auth, injection, broken access), GDPR (cookies / tracking).

# Severity calibration

- critical: production outage / blocked user / security or privacy breach
- high: severely degraded UX (> Core Web Vitals "poor" threshold, broken auth flow, contrast WCAG AA fail)
- medium: noticeable defect (Core Web Vitals "needs improvement", visual polish < 6/10)
- low: minor polish / nit

# Output discipline

- Limit findings to the 12 most important across all dimensions.
- Group similar issues (3 small contrast misses → 1 finding citing all locations).
- Order findings inside the array by severity desc then confidence desc.
- Return ONLY the JSON object. No prose, no code fences. Must parse cleanly.`;
}

export function buildDiagnoseUserPrompt(args: {
  urlFinal: string;
  title: string;
  diagnosticsBlock: string;
}): string {
  return `URL: ${args.urlFinal}
Title: ${JSON.stringify(args.title)}

Diagnostics envelope (every line is a JSON-pointer path you may cite in evidence_refs):
\`\`\`
${args.diagnosticsBlock}
\`\`\`

Return ONLY the JSON object matching the schema in the system prompt.`;
}

// ─────────────────────────────────────────────────────────────
// Primitive
// ─────────────────────────────────────────────────────────────

function diagnoseCacheKeyInputs(opts: DiagnoseOptions): unknown {
  const persona = opts.persona ?? {};
  return {
    url: opts.url,
    waitFor: opts.waitFor,
    viewport: opts.viewport ?? persona.viewport,
    locale: persona.locale,
    timezone: persona.timezone,
    user_agent: persona.user_agent,
    persona_id: persona.id,
    model: opts.model ?? DEFAULT_DIAGNOSE_MODEL,
    visual_rubrics: opts.visualRubrics,
    visual_custom_criteria: opts.visualCustomCriteria,
    visual_model: opts.visualModel,
  };
}

export async function diagnose(opts: DiagnoseOptions): Promise<DiagnoseResult> {
  return withResultCache<DiagnoseResult>({
    primitive: "diagnose",
    cacheKeyInputs: diagnoseCacheKeyInputs(opts),
    cacheEnabled: opts.cache !== false,
    cacheBust: opts.cacheBust,
    ttlMs: opts.cacheTtlMs,
    compute: () => computeDiagnose(opts),
  });
}

async function computeDiagnose(opts: DiagnoseOptions): Promise<DiagnoseResult> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();

  const personaId = opts.persona?.id ?? DEFAULT_DIAGNOSE_PERSONA_ID;
  const model = opts.model ?? DEFAULT_DIAGNOSE_MODEL;
  const artifactsRoot = opts.artifactsRoot ?? defaultDiagnoseArtifactsRoot();
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  const runDir = makeRunDir(artifactsRoot);

  let urlFinal = opts.url;
  let title = "";
  let screenshot: DiagnoseResult["screenshot"] = null;
  let diagnostics: DiagnoseResult["diagnostics"] = undefined;
  let costUsd = 0;
  let status: DiagnoseResult["status"] = "ok";
  let errorMsg: string | undefined;
  let findings: DiagnoseFinding[] = [];
  let executiveSummary = "Diagnose did not produce a summary.";

  try {
    const seeImpl = opts._see ?? see;
    const seeOpts: SeeOptions = {
      url: opts.url,
      persona: opts.persona,
      waitFor: opts.waitFor,
      viewport: opts.viewport,
      fullPage: true,
      includeDom: true,
      includeConsole: true,
      timeoutMs: opts.timeoutMs,
      headless: opts.headless,
      artifactsRoot: runDir,
      visualScoring: "eager",
      visualRubrics: opts.visualRubrics,
      visualCustomCriteria: opts.visualCustomCriteria,
      visualModel: opts.visualModel ?? model,
      _callVision: opts._callVision,
    };
    const captured: SeeResult = await seeImpl(seeOpts);
    if (captured.status !== "ok") {
      throw new Error(captured.error ?? "see failed during diagnose capture");
    }
    urlFinal = captured.url_final;
    title = captured.title;
    screenshot = captured.screenshot;
    diagnostics = captured.diagnostics;
    costUsd += captured.cost_usd;

    if (!screenshot) {
      throw new Error("diagnose: see returned no screenshot");
    }

    const buf = fs.readFileSync(screenshot.path);
    const compressed = await compressForVisionMulti(buf);
    const multiImage = compressed.length > 1;
    const diagnosticsBlock = serializeDiagnosticsForPrompt(diagnostics);
    const systemPrompt = buildDiagnoseSystemPrompt();
    const baseUserPrompt = buildDiagnoseUserPrompt({
      urlFinal,
      title,
      diagnosticsBlock,
    });
    const userPrompt = multiImage
      ? baseUserPrompt + MULTI_IMAGE_PROMPT_NOTE
      : baseUserPrompt;

    const callVisionImpl = opts._callVision ?? callVision;
    const resp = await callVisionImpl({
      model,
      systemPrompt,
      userPrompt,
      images: compressed.map((c) => ({
        base64: c.base64,
        mediaType: c.mediaType,
      })),
      maxTokens: 6144,
    });
    costUsd += resp.costUsd;

    let parsed: unknown;
    try {
      parsed = extractJson(resp.text);
    } catch (jsonErr) {
      log.warn(
        { err: jsonErr instanceof Error ? jsonErr.message : String(jsonErr) },
        "diagnose: vision returned malformed JSON",
      );
      // Degrade — emit a single low-severity finding documenting the parser failure.
      findings = [
        {
          id: "diagnose_parser_failure",
          severity: "low",
          dimension: "cross_cutting",
          title: "Diagnose vision call returned malformed JSON",
          description:
            "The diagnostic vision model returned a response that could not be parsed as JSON. " +
            "Findings could not be enumerated for this run.",
          root_cause: "Model output stability / prompt formatting issue.",
          recommendation:
            "Re-run with cache_bust=true. If the failure repeats, file a bug with the artifacts dir.",
          confidence: 1.0,
          evidence_refs: [],
          standards_mapping: [],
        },
      ];
      executiveSummary =
        "Diagnose was unable to produce findings: the vision model returned malformed output.";
    }

    if (parsed) {
      const parseOut = parseDiagnoseRawJson(parsed, diagnostics);
      findings = parseOut.findings;
      executiveSummary =
        parseOut.executiveSummary || "Diagnose produced findings but no executive summary.";
    }
  } catch (err) {
    status = "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err: errorMsg, url: opts.url, runDir }, "diagnose: failed");
    executiveSummary = `Diagnose failed: ${errorMsg}`;
  }

  // Sort findings: severity desc, confidence desc.
  findings.sort((a, b) => {
    const dSev = severityRank(b.severity) - severityRank(a.severity);
    if (dSev !== 0) return dSev;
    return b.confidence - a.confidence;
  });

  const dimensionScores = buildDimensionScores(findings, diagnostics);
  const overallHealth = computeOverallHealthScore(dimensionScores, findings);
  const findingsByDimension = indexFindingsByDimension(findings);

  const durationMs = Date.now() - t0;

  const result: DiagnoseResult = {
    schema_version: RESULT_SCHEMA_VERSION,
    url_input: opts.url,
    url_final: urlFinal,
    title,
    loaded_at: startedAt,
    status,
    error: errorMsg,
    executive_summary: executiveSummary,
    overall_health_score: overallHealth,
    dimension_scores: dimensionScores,
    findings,
    findings_by_dimension: findingsByDimension,
    screenshot,
    persona_id: personaId,
    artifacts_dir: runDir,
    model,
    cost_usd: costUsd,
    duration_ms: durationMs,
    ...(diagnostics ? { diagnostics } : {}),
  };

  // Sidecar for reproducibility.
  try {
    fs.writeFileSync(
      path.join(runDir, "diagnose.json"),
      JSON.stringify(result, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "diagnose: failed to write diagnose.json sidecar",
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Defensive parse — drop hallucinated entries
// ─────────────────────────────────────────────────────────────

export interface ParsedDiagnose {
  findings: DiagnoseFinding[];
  executiveSummary: string;
}

export function parseDiagnoseRawJson(
  raw: unknown,
  diagnostics: SeeResult["diagnostics"] | undefined,
): ParsedDiagnose {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const executiveSummary =
    typeof obj.executive_summary === "string" ? obj.executive_summary : "";
  const findingsIn = Array.isArray(obj.findings) ? (obj.findings as unknown[]) : [];

  const findings: DiagnoseFinding[] = [];
  for (const f of findingsIn) {
    const parsed = parseFinding(f, diagnostics);
    if (parsed) findings.push(parsed);
  }

  return { findings, executiveSummary };
}

function parseFinding(
  raw: unknown,
  diagnostics: SeeResult["diagnostics"] | undefined,
): DiagnoseFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const severity = asEnum(o.severity, VALID_SEVERITIES);
  if (!severity) return null;
  const dimension = asEnum(o.dimension, VALID_DIMENSIONS);
  if (!dimension) return null;

  const title = asNonEmpty(o.title);
  const description = asNonEmpty(o.description);
  if (!title || !description) return null;

  const id =
    asNonEmpty(o.id) ??
    fallbackFindingId(dimension, title);
  const rootCause = asNonEmpty(o.root_cause) ?? "";
  const recommendation = asNonEmpty(o.recommendation) ?? "";

  const confidenceRaw =
    typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : 0.5;

  const allRefs = parseEvidenceRefs(o.evidence_refs);
  const standardsMapping = parseStandardsMapping(o.standards_mapping);

  // Anti-hallucination, part 2: an evidence_ref must point at a path that
  // actually exists in the diagnostics envelope the model was shown. Before
  // this, any non-empty string passed — so a model could cite
  // `/diagnostics/accessibility/contrast` (no such collector) and the finding
  // sailed through. Keep only refs whose path is grounded in the real
  // serialized diagnostics. (Audit 2026-06-02 E7/D3-M5.)
  const validPaths = collectDiagnosticsPaths(diagnostics);
  const evidenceRefs = allRefs.filter((r) => isGroundedPath(r.path, validPaths));

  // severity != 'low' MUST cite at least one GROUNDED evidence ref. Drop the
  // finding rather than emit a claim sourced from fabricated paths.
  if (severity !== "low" && evidenceRefs.length === 0) {
    log.warn(
      { id, severity, dimension, title, citedPaths: allRefs.map((r) => r.path) },
      "diagnose: dropped finding without grounded evidence_refs (anti-hallucination)",
    );
    return null;
  }

  // Soft anti-hallucination: drop findings that name dimensions whose
  // collectors did not run. (E.g. performance finding when /diagnostics/performance
  // was absent.)
  if (!dimensionDataAvailable(dimension, diagnostics)) {
    log.warn(
      { id, dimension },
      "diagnose: dropped finding for dimension with no collected data",
    );
    return null;
  }

  return {
    id,
    severity,
    dimension,
    title,
    description,
    root_cause: rootCause,
    recommendation,
    confidence,
    evidence_refs: evidenceRefs,
    standards_mapping: standardsMapping,
    affected_location: asNonEmpty(o.affected_location),
    affected_url: asNonEmpty(o.affected_url),
    affected_selector: asNonEmpty(o.affected_selector),
  };
}

function parseEvidenceRefs(v: unknown): EvidenceRef[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceRef[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const path = asNonEmpty(o.path);
    if (!path) continue;
    const value =
      typeof o.value === "string"
        ? o.value
        : o.value === null || o.value === undefined
          ? ""
          : String(o.value);
    out.push({
      path,
      value,
      note: asNonEmpty(o.note),
    });
  }
  return out;
}

function parseStandardsMapping(v: unknown): StandardsReference[] {
  if (!Array.isArray(v)) return [];
  const out: StandardsReference[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const framework = asNonEmpty(o.framework);
    const id = asNonEmpty(o.id);
    if (!framework || !id) continue;
    out.push({
      framework,
      id,
      url: asNonEmpty(o.url),
      label: asNonEmpty(o.label),
    });
  }
  return out;
}

/**
 * The set of JSON-pointer paths the model was actually shown — derived from
 * the SAME serializer that builds the prompt's diagnostics block, so "what
 * the model can cite" and "what we validate against" can never drift apart.
 * Every rendered line carries its `/diagnostics/...` path as the leading
 * token; collect them all.
 */
function collectDiagnosticsPaths(
  diagnostics: SeeResult["diagnostics"] | undefined,
): Set<string> {
  const paths = new Set<string>();
  const block = serializeDiagnosticsForPrompt(diagnostics);
  for (const line of block.split("\n")) {
    for (const token of line.trim().split(/\s+/)) {
      if (token.startsWith("/diagnostics/")) {
        paths.add(token.replace(/\/+$/, ""));
      }
    }
  }
  return paths;
}

/**
 * A cited evidence path is grounded if it lines up (segment-wise) with a path
 * the model was actually shown: an exact match, an ancestor of a rendered
 * path (e.g. `/diagnostics/performance`), or a descendant of one (citing a
 * field deeper than the summary rendered). A fabricated section like
 * `/diagnostics/accessibility/*` matches none and is rejected.
 */
function isGroundedPath(refPath: string, validPaths: Set<string>): boolean {
  const p = refPath.replace(/\/+$/, "");
  if (validPaths.has(p)) return true;
  for (const vp of validPaths) {
    if (vp.startsWith(p + "/") || p.startsWith(vp + "/")) return true;
  }
  return false;
}

function dimensionDataAvailable(
  dim: DiagnoseDimension,
  diagnostics: SeeResult["diagnostics"] | undefined,
): boolean {
  if (!diagnostics) {
    // No diagnostics envelope at all → only cross_cutting findings are
    // legal (they don't claim to be sourced from any specific dimension).
    return dim === "cross_cutting" || dim === "security" || dim === "seo";
  }
  switch (dim) {
    case "performance":
      return Boolean(diagnostics.performance);
    case "visual":
      return Boolean(diagnostics.visual);
    case "whitebox":
      return (
        Boolean(diagnostics.network) ||
        Boolean(diagnostics.popups) ||
        Boolean(diagnostics.cookies) ||
        Boolean(diagnostics.storage)
      );
    case "privacy":
      return Boolean(diagnostics.cookies) || Boolean(diagnostics.storage);
    case "accessibility":
    case "security":
    case "seo":
    case "cross_cutting":
      // These dimensions don't have dedicated collectors yet — allow them
      // through if the model can substantiate via evidence_refs (which
      // are checked separately).
      return true;
  }
}

function asEnum<T extends string>(v: unknown, allowed: T[]): T | undefined {
  return typeof v === "string" && allowed.includes(v as T) ? (v as T) : undefined;
}

function asNonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function fallbackFindingId(dim: DiagnoseDimension, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return `${dim}_${slug || "issue"}`;
}

// ─────────────────────────────────────────────────────────────
// Health-score math
// ─────────────────────────────────────────────────────────────

function severityRank(s: DiagnoseSeverity): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s];
}

/**
 * Per-dimension weight in the overall health score. Values sum to 1.0
 * across the dimensions actually present. Performance + visual are
 * weighted slightly higher because they are the dimensions with hard
 * collected data; security / seo / accessibility lean on inference.
 */
const DIMENSION_WEIGHTS: Record<DiagnoseDimension, number> = {
  performance: 1.0,
  visual: 1.0,
  whitebox: 0.8,
  accessibility: 0.8,
  security: 0.8,
  privacy: 0.7,
  seo: 0.6,
  cross_cutting: 0.5,
};

const SEVERITY_PENALTY: Record<DiagnoseSeverity, number> = {
  critical: 35,
  high: 20,
  medium: 8,
  low: 2,
};

export function buildDimensionScores(
  findings: DiagnoseFinding[],
  diagnostics: SeeResult["diagnostics"] | undefined,
): DiagnoseDimensionScore[] {
  const byDim = new Map<DiagnoseDimension, DiagnoseFinding[]>();
  for (const f of findings) {
    const arr = byDim.get(f.dimension) ?? [];
    arr.push(f);
    byDim.set(f.dimension, arr);
  }

  // Always include dimensions with collected data even if there are no
  // findings — "we looked, you're clean" is itself useful signal.
  const present = new Set<DiagnoseDimension>(byDim.keys());
  if (diagnostics?.performance) present.add("performance");
  if (diagnostics?.visual) present.add("visual");
  if (
    diagnostics?.network ||
    diagnostics?.popups ||
    diagnostics?.cookies ||
    diagnostics?.storage
  ) {
    present.add("whitebox");
  }
  if (diagnostics?.cookies || diagnostics?.storage) present.add("privacy");

  const out: DiagnoseDimensionScore[] = [];
  for (const dim of present) {
    const arr = byDim.get(dim) ?? [];
    const counts = {
      critical: arr.filter((f) => f.severity === "critical").length,
      high: arr.filter((f) => f.severity === "high").length,
      medium: arr.filter((f) => f.severity === "medium").length,
      low: arr.filter((f) => f.severity === "low").length,
    };
    let score = 100;
    for (const f of arr) {
      score -= SEVERITY_PENALTY[f.severity] * f.confidence;
    }
    score = Math.max(0, Math.min(100, Math.round(score)));
    const summary = arr.length === 0
      ? "No findings — dimension passes audit."
      : `${arr.length} finding${arr.length === 1 ? "" : "s"} (${counts.critical}C/${counts.high}H/${counts.medium}M/${counts.low}L).`;
    out.push({ dimension: dim, score, finding_counts: counts, summary });
  }
  return out;
}

export function computeOverallHealthScore(
  dimensionScores: DiagnoseDimensionScore[],
  findings: DiagnoseFinding[],
): number {
  if (dimensionScores.length === 0) {
    // No dimensions evaluated — fall back to a simple findings-based score
    // so the field is never spurious-100 on a failed run.
    if (findings.length === 0) return 100;
    let s = 100;
    for (const f of findings) s -= SEVERITY_PENALTY[f.severity] * f.confidence;
    return Math.max(0, Math.min(100, Math.round(s)));
  }
  let weighted = 0;
  let totalWeight = 0;
  for (const ds of dimensionScores) {
    const w = DIMENSION_WEIGHTS[ds.dimension] ?? 0.5;
    weighted += ds.score * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? Math.round(weighted / totalWeight) : 100;
}

export function indexFindingsByDimension(
  findings: DiagnoseFinding[],
): Record<DiagnoseDimension, string[]> {
  const out: Partial<Record<DiagnoseDimension, string[]>> = {};
  for (const f of findings) {
    const arr = out[f.dimension] ?? [];
    arr.push(f.id);
    out[f.dimension] = arr;
  }
  return out as Record<DiagnoseDimension, string[]>;
}
