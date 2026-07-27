/**
 * Tests for the `diagnose` primitive (PR-E / ADR-034).
 *
 * Layers:
 *   1. serializeDiagnosticsForPrompt — every dimension is rendered with
 *      stable JSON-pointer paths the model can cite.
 *   2. parseDiagnoseRawJson — defensive coercion + anti-hallucination
 *      gates (drop findings without evidence_refs, drop findings whose
 *      claimed dimension has no collected data).
 *   3. Score math — buildDimensionScores + computeOverallHealthScore +
 *      indexFindingsByDimension.
 *   4. Primitive seam tests — `_see` + `_callVision` stubs cover schema
 *      field plumbing, error paths, anti-hallucination dropping, sidecar.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  diagnose,
  serializeDiagnosticsForPrompt,
  parseDiagnoseRawJson,
  buildDimensionScores,
  computeOverallHealthScore,
  indexFindingsByDimension,
  buildDiagnoseSystemPrompt,
  buildDiagnoseUserPrompt,
  DEFAULT_DIAGNOSE_MODEL,
  DEFAULT_DIAGNOSE_PERSONA_ID,
  defaultDiagnoseArtifactsRoot,
} from "../../src/core/primitives/diagnose.js";
import type { SeeResult } from "../../src/core/primitives/see.js";
import {
  DiagnoseResultSchema,
  RESULT_SCHEMA_VERSION,
  type DiagnoseFinding,
} from "../../src/core/result-schema.js";

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

function tinyPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
}

function fakeSee(args: {
  url?: string;
  screenshot_path: string;
  diagnostics?: SeeResult["diagnostics"];
  cost?: number;
}): typeof import("../../src/core/primitives/see.js").see {
  return async (opts) => {
    const buf = tinyPng();
    if (!fs.existsSync(args.screenshot_path)) {
      fs.mkdirSync(path.dirname(args.screenshot_path), { recursive: true });
      fs.writeFileSync(args.screenshot_path, buf);
    }
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const finalUrl = args.url ?? opts.url;
    return {
      schema_version: RESULT_SCHEMA_VERSION,
      url_input: opts.url,
      url_final: finalUrl,
      title: "Stub page",
      loaded_at: new Date().toISOString(),
      status: "ok",
      dom: {
        interactive_count: 4,
        headings: ["h1: Stub"],
        summary: "[Headings]\nh1: Stub",
      },
      console: { errors_count: 0, errors: [] },
      screenshot: {
        path: args.screenshot_path,
        sha256: sha,
        bytes: buf.length,
        width: 1280,
        height: 800,
      },
      note: null,
      persona_id: opts.persona?.id ?? "see-default-desktop",
      artifacts_dir: opts.artifactsRoot ?? "/tmp",
      cost_usd: args.cost ?? 0,
      duration_ms: 12,
      ...(args.diagnostics ? { diagnostics: args.diagnostics } : {}),
    };
  };
}

function visionStub(text: string, costUsd = 0.012) {
  return async () => ({
    model: "stub-vision",
    text,
    costUsd,
    usage: { input_tokens: 200, output_tokens: 800 },
  });
}

function richDiagnostics(): NonNullable<SeeResult["diagnostics"]> {
  return {
    collected_at: "always",
    popups: [],
    network: {
      request_count: 47,
      failure_count: 2,
      requests: [],
      failures: [
        {
          url: "https://api.example.com/profile",
          method: "GET",
          resource_type: "fetch",
          error_text: "503 Service Unavailable",
        },
      ],
    },
    cookies: [
      {
        name: "session",
        value: "[REDACTED]",
        domain: ".example.com",
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
    performance: {
      lcp_ms: 4200, // poor
      cls: 0.05,
      inp_ms: 120,
      fcp_ms: 1100,
      ttfb_ms: 320,
      dom_content_loaded_ms: 850,
      load_ms: 2400,
      resources: { total: 47, script: 12, stylesheet: 3, image: 22, xhr_or_fetch: 5 },
      transfer_bytes: 482_311,
      window_ms: 5400,
    },
    visual: {
      scored: true,
      rubrics: ["aesthetic"],
      verdicts: [
        {
          criterion_id: "color_contrast",
          label: "Color contrast",
          kind: "aesthetic",
          score: 4,
          rationale: "Body text on light grey fails WCAG AA.",
          evidence: [],
        },
      ],
      findings: [],
      overall_score: 4,
      summary: "Contrast fail.",
      cost_usd: 0.008,
      duration_ms: 1500,
    },
  };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "diagnose-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// 1. serializeDiagnosticsForPrompt
// ─────────────────────────────────────────────────────────────

describe("serializeDiagnosticsForPrompt", () => {
  it("renders performance with Core Web Vitals threshold context", () => {
    const out = serializeDiagnosticsForPrompt(richDiagnostics());
    expect(out).toContain("/diagnostics/performance/lcp_ms = 4200");
    expect(out).toContain("Core Web Vitals");
    expect(out).toContain("good ≤ 2500");
  });

  it("renders network failures with method + url + error_text", () => {
    const out = serializeDiagnosticsForPrompt(richDiagnostics());
    expect(out).toContain("/diagnostics/network/failure_count = 2");
    expect(out).toContain("GET https://api.example.com/profile");
    expect(out).toContain("503 Service Unavailable");
  });

  it("renders visual verdicts with criterion_id paths the model can cite", () => {
    const out = serializeDiagnosticsForPrompt(richDiagnostics());
    expect(out).toContain("/diagnostics/visual/verdicts/color_contrast");
    expect(out).toContain("4/10");
  });

  it("emits an explicit '(collector did not run)' marker when the dimension is absent", () => {
    const partial: NonNullable<SeeResult["diagnostics"]> = {
      collected_at: "always",
      // no performance / no network / no visual
    };
    const out = serializeDiagnosticsForPrompt(partial);
    expect(out).toContain("# performance: (collector did not run)");
  });

  it("returns a placeholder string when diagnostics envelope is undefined", () => {
    const out = serializeDiagnosticsForPrompt(undefined);
    expect(out).toContain("no diagnostics envelope");
  });
});

// ─────────────────────────────────────────────────────────────
// 2. parseDiagnoseRawJson — anti-hallucination gates
// ─────────────────────────────────────────────────────────────

describe("parseDiagnoseRawJson", () => {
  it("parses a well-formed finding with evidence + standards", () => {
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "LCP exceeds Core Web Vitals poor threshold.",
        findings: [
          {
            id: "lcp_above_poor_threshold",
            severity: "high",
            dimension: "performance",
            title: "LCP exceeds 4000ms poor threshold",
            description:
              "Largest Contentful Paint at 4200ms places this page in the Core Web Vitals 'poor' bucket.",
            root_cause: "Hero image is uncompressed and render-blocking.",
            recommendation: "Preload the hero image and serve as AVIF.",
            confidence: 0.95,
            evidence_refs: [
              {
                path: "/diagnostics/performance/lcp_ms",
                value: "4200",
                note: "Above 4000ms poor threshold.",
              },
            ],
            standards_mapping: [
              { framework: "Core Web Vitals", id: "LCP", url: "https://web.dev/lcp/" },
            ],
          },
        ],
      },
      richDiagnostics(),
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].id).toBe("lcp_above_poor_threshold");
    expect(out.findings[0].confidence).toBe(0.95);
    expect(out.findings[0].standards_mapping[0].framework).toBe("Core Web Vitals");
    expect(out.executiveSummary).toContain("LCP");
  });

  it("DROPS a high-severity finding with no evidence_refs (anti-hallucination)", () => {
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "x",
        findings: [
          {
            id: "fabricated",
            severity: "high",
            dimension: "performance",
            title: "Made up issue",
            description: "Long description without supporting evidence.",
            root_cause: "Unknown",
            recommendation: "Unknown",
            confidence: 0.9,
            evidence_refs: [], // empty → must be dropped
          },
        ],
      },
      richDiagnostics(),
    );
    expect(out.findings).toHaveLength(0);
  });

  it("DROPS a finding whose only evidence_ref cites a fabricated path (E7)", () => {
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "x",
        findings: [
          {
            id: "fake_a11y",
            severity: "high",
            dimension: "accessibility",
            title: "Contrast too low",
            description: "Cites a diagnostics path that was never collected.",
            root_cause: "Unknown",
            recommendation: "Unknown",
            confidence: 0.9,
            // No accessibility collector exists → this path is not in the
            // serialized diagnostics. Pre-E7 it passed the non-empty check.
            evidence_refs: [
              { path: "/diagnostics/accessibility/contrast_ratio", value: "2.1" },
            ],
          },
        ],
      },
      richDiagnostics(),
    );
    expect(out.findings).toHaveLength(0);
  });

  it("keeps a finding when at least one evidence_ref is grounded, dropping the fabricated one (E7)", () => {
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "x",
        findings: [
          {
            id: "mixed_refs",
            severity: "high",
            dimension: "performance",
            title: "LCP slow",
            description: "One real ref, one fabricated.",
            root_cause: "Heavy hero.",
            recommendation: "Optimize.",
            confidence: 0.9,
            evidence_refs: [
              { path: "/diagnostics/made/up/path", value: "x" },
              { path: "/diagnostics/performance/lcp_ms", value: "4200" },
            ],
          },
        ],
      },
      richDiagnostics(),
    );
    expect(out.findings).toHaveLength(1);
    // The fabricated ref is stripped; only the grounded one survives.
    expect(out.findings[0].evidence_refs).toHaveLength(1);
    expect(out.findings[0].evidence_refs[0].path).toBe(
      "/diagnostics/performance/lcp_ms",
    );
  });

  it("ALLOWS a low-severity finding without evidence_refs (low bar exempt)", () => {
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "x",
        findings: [
          {
            id: "minor_polish",
            severity: "low",
            dimension: "visual",
            title: "Minor polish",
            description: "Small spacing inconsistency.",
            root_cause: "n/a",
            recommendation: "Tighten margin.",
            confidence: 0.4,
            evidence_refs: [],
          },
        ],
      },
      richDiagnostics(),
    );
    expect(out.findings).toHaveLength(1);
  });

  it("DROPS a finding whose dimension has no collected data", () => {
    // diagnostics has no performance section → performance findings dropped
    const partialDiagnostics: NonNullable<SeeResult["diagnostics"]> = {
      collected_at: "always",
      // no performance
    };
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "x",
        findings: [
          {
            id: "perf_with_no_data",
            severity: "medium",
            dimension: "performance",
            title: "Perf claim with no perf data",
            description: "Long description.",
            root_cause: "Unknown",
            recommendation: "Unknown",
            confidence: 0.7,
            evidence_refs: [
              { path: "/diagnostics/performance/lcp_ms", value: "9999" },
            ],
          },
        ],
      },
      partialDiagnostics,
    );
    expect(out.findings).toHaveLength(0);
  });

  it("clamps confidence into 0..1 and falls back to 0.5 for non-numeric", () => {
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "x",
        findings: [
          {
            id: "a",
            severity: "low",
            dimension: "cross_cutting",
            title: "a",
            description: "a",
            confidence: 1.7, // out of range
            evidence_refs: [],
          },
          {
            id: "b",
            severity: "low",
            dimension: "cross_cutting",
            title: "b",
            description: "b",
            confidence: "not-a-number",
            evidence_refs: [],
          },
        ],
      },
      richDiagnostics(),
    );
    expect(out.findings[0].confidence).toBe(1);
    expect(out.findings[1].confidence).toBe(0.5);
  });

  it("auto-generates a stable id from dimension + title when id is missing", () => {
    const out = parseDiagnoseRawJson(
      {
        executive_summary: "x",
        findings: [
          {
            severity: "low",
            dimension: "performance",
            title: "LCP exceeds 4000ms threshold",
            description: "x",
            confidence: 0.9,
            evidence_refs: [],
          },
        ],
      },
      richDiagnostics(),
    );
    expect(out.findings[0].id).toMatch(/^performance_/);
    expect(out.findings[0].id).toContain("lcp");
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Score math
// ─────────────────────────────────────────────────────────────

function mkFinding(over: Partial<DiagnoseFinding> = {}): DiagnoseFinding {
  return {
    id: "x",
    severity: "medium",
    dimension: "performance",
    title: "x",
    description: "x",
    root_cause: "",
    recommendation: "",
    confidence: 1,
    evidence_refs: [],
    standards_mapping: [],
    ...over,
  };
}

describe("buildDimensionScores", () => {
  it("includes dimensions with collected data even when no findings", () => {
    const scores = buildDimensionScores([], richDiagnostics());
    const dims = scores.map((s) => s.dimension);
    expect(dims).toContain("performance");
    expect(dims).toContain("visual");
    expect(dims).toContain("whitebox");
    const perf = scores.find((s) => s.dimension === "performance");
    expect(perf?.score).toBe(100);
    expect(perf?.summary).toContain("No findings");
  });

  it("penalises severities and weights by confidence", () => {
    const findings = [
      mkFinding({ severity: "critical", confidence: 1.0 }),
      mkFinding({ severity: "low", confidence: 0.5 }),
    ];
    const scores = buildDimensionScores(findings, richDiagnostics());
    const perf = scores.find((s) => s.dimension === "performance");
    // 100 - 35 (critical*1) - 2*0.5 (low*0.5) = 64
    expect(perf?.score).toBe(64);
    expect(perf?.finding_counts.critical).toBe(1);
    expect(perf?.finding_counts.low).toBe(1);
  });
});

describe("computeOverallHealthScore", () => {
  it("weights performance + visual higher than seo", () => {
    // Two equal-score dimensions, one heavy (perf=1.0) one light (seo=0.6).
    // Drop perf to 50, keep seo at 100 → weighted should be lower than 75.
    const ds = [
      { dimension: "performance" as const, score: 50, finding_counts: { critical: 0, high: 0, medium: 0, low: 0 }, summary: "" },
      { dimension: "seo" as const, score: 100, finding_counts: { critical: 0, high: 0, medium: 0, low: 0 }, summary: "" },
    ];
    const score = computeOverallHealthScore(ds, []);
    // (50*1.0 + 100*0.6) / (1.0 + 0.6) = 110/1.6 = 68.75 → 69
    expect(score).toBe(69);
  });

  it("returns 100 when no dimensions evaluated and no findings", () => {
    expect(computeOverallHealthScore([], [])).toBe(100);
  });

  it("falls back to findings-only when no dimension scores", () => {
    const score = computeOverallHealthScore([], [mkFinding({ severity: "high", confidence: 1 })]);
    expect(score).toBe(80);
  });
});

describe("indexFindingsByDimension", () => {
  it("groups finding ids by dimension", () => {
    const findings = [
      mkFinding({ id: "a", dimension: "performance" }),
      mkFinding({ id: "b", dimension: "visual" }),
      mkFinding({ id: "c", dimension: "performance" }),
    ];
    const idx = indexFindingsByDimension(findings);
    expect(idx.performance).toEqual(["a", "c"]);
    expect(idx.visual).toEqual(["b"]);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Primitive seam tests
// ─────────────────────────────────────────────────────────────

describe("diagnose — primitive plumbing", () => {
  it("end-to-end: stub see + stub vision returns parseable DiagnoseResult", async () => {
    const screenshotPath = path.join(workspace, "stub.png");
    const visionJson = JSON.stringify({
      executive_summary:
        "LCP at 4200ms is in the Core Web Vitals poor band; one network request failed; color contrast verdict is below WCAG AA.",
      findings: [
        {
          id: "lcp_poor",
          severity: "high",
          dimension: "performance",
          title: "LCP exceeds poor threshold",
          description:
            "Largest Contentful Paint of 4200ms places the page in the Core Web Vitals 'poor' bucket (>4000ms).",
          root_cause: "Hero image not preloaded.",
          recommendation: "Preload hero image and serve as AVIF.",
          confidence: 0.95,
          evidence_refs: [{ path: "/diagnostics/performance/lcp_ms", value: "4200" }],
          standards_mapping: [{ framework: "Core Web Vitals", id: "LCP" }],
        },
        {
          id: "contrast_fail",
          severity: "medium",
          dimension: "visual",
          title: "Color contrast below WCAG AA",
          description:
            "Aesthetic rubric scored color_contrast at 4/10, indicating likely WCAG AA failure.",
          root_cause: "Body text on light-grey background.",
          recommendation: "Use #333 on white.",
          confidence: 0.8,
          evidence_refs: [
            { path: "/diagnostics/visual/verdicts/color_contrast", value: "4" },
          ],
          standards_mapping: [{ framework: "WCAG 2.2", id: "SC 1.4.3", label: "Contrast (Minimum)" }],
        },
      ],
    });

    const r = await diagnose({
      url: "https://target.example/",
      artifactsRoot: workspace,
      _see: fakeSee({
        screenshot_path: screenshotPath,
        diagnostics: richDiagnostics(),
        cost: 0.008,
      }),
      _callVision: visionStub(visionJson, 0.025),
    });

    expect(() => DiagnoseResultSchema.parse(r)).not.toThrow();
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].severity).toBe("high"); // sorted: high before medium
    expect(r.executive_summary).toContain("LCP");
    expect(r.overall_health_score).toBeGreaterThan(0);
    expect(r.overall_health_score).toBeLessThan(100);
    expect(r.dimension_scores.length).toBeGreaterThan(0);
    expect(r.findings_by_dimension.performance).toContain("lcp_poor");
    expect(r.findings_by_dimension.visual).toContain("contrast_fail");
    // Cost accumulates upstream see cost + diagnose vision cost
    expect(r.cost_usd).toBeCloseTo(0.008 + 0.025, 3);
    // Sidecar
    expect(fs.existsSync(path.join(r.artifacts_dir, "diagnose.json"))).toBe(true);
    // Diagnostics passthrough
    expect(r.diagnostics?.performance?.lcp_ms).toBe(4200);
  });

  it("degrades gracefully when vision returns malformed JSON", async () => {
    const screenshotPath = path.join(workspace, "stub.png");
    const r = await diagnose({
      url: "https://target.example/",
      artifactsRoot: workspace,
      _see: fakeSee({
        screenshot_path: screenshotPath,
        diagnostics: richDiagnostics(),
      }),
      _callVision: visionStub("totally not json", 0.005),
    });
    expect(r.status).toBe("ok");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].id).toBe("diagnose_parser_failure");
    expect(r.findings[0].severity).toBe("low");
    expect(r.executive_summary).toContain("malformed");
  });

  it("captures status='error' when upstream see fails (no findings produced)", async () => {
    const r = await diagnose({
      url: "https://broken.example/",
      artifactsRoot: workspace,
      _see: async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
      _callVision: visionStub("{}"),
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("ERR_NAME_NOT_RESOLVED");
    expect(r.findings).toHaveLength(0);
    expect(r.executive_summary).toContain("Diagnose failed");
  });

  it("system prompt embeds the schema + anti-hallucination rules", () => {
    const sys = buildDiagnoseSystemPrompt();
    expect(sys).toContain("evidence_refs");
    expect(sys).toContain("standards_mapping");
    expect(sys).toContain("Anti-hallucination");
    expect(sys).toContain("Core Web Vitals");
    expect(sys).toContain("WCAG");
  });

  it("user prompt embeds the rendered diagnostics block", () => {
    const userPrompt = buildDiagnoseUserPrompt({
      urlFinal: "https://target.example/",
      title: "Target",
      diagnosticsBlock: "/diagnostics/performance/lcp_ms = 4200",
    });
    expect(userPrompt).toContain("https://target.example/");
    expect(userPrompt).toContain("/diagnostics/performance/lcp_ms = 4200");
  });

  it("default model + persona id are exported as constants", () => {
    expect(DEFAULT_DIAGNOSE_MODEL).toBe("claude-sonnet-4-6");
    expect(DEFAULT_DIAGNOSE_PERSONA_ID).toBe("diagnose-default-desktop");
    expect(defaultDiagnoseArtifactsRoot()).toMatch(/diagnoses$|diagnoses\//);
  });
});
