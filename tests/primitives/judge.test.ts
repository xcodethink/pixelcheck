/**
 * Tests for the `judge` primitive (N-8).
 *
 * Layers:
 *   1. resolveCriteria — rubric assembly logic, dedupe, errors.
 *   2. Prompt construction — system + user prompt embed every criterion id.
 *   3. parseJudgeRawJson — defensive coercion of raw model output.
 *   4. Primitive seam tests — `_see` + `_callVision` stubs cover schema
 *      field plumbing, error paths, capture re-use, artifacts isolation,
 *      cost accounting, sidecar JSON write.
 *   5. Real Chromium integration test — end-to-end against the fixture
 *      site with a stub vision call (no real LLM credit spend).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";

import {
  judge,
  resolveCriteria,
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  parseJudgeRawJson,
  computeOverallScore,
  defaultJudgeArtifactsRoot,
  DEFAULT_JUDGE_PERSONA_ID,
  DEFAULT_JUDGE_MODEL,
} from "../../src/core/primitives/judge.js";
import type { JudgeOptions } from "../../src/core/primitives/judge.js";
import type { SeeResult } from "../../src/core/primitives/see.js";
import { AESTHETIC_CRITERIA } from "../../src/core/critics/aesthetic.js";
import { DARK_PATTERN_CRITERIA } from "../../src/core/critics/dark-pattern.js";
import { RESULT_SCHEMA_VERSION } from "../../src/core/result-schema.js";
import { startFixtureServer, type FixtureServer } from "../fixtures/test-site/server.js";

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
  screenshot_buf?: Buffer;
  cost?: number;
}): typeof import("../../src/core/primitives/see.js").see {
  return async (opts) => {
    const buf = args.screenshot_buf ?? tinyPng();
    if (!fs.existsSync(args.screenshot_path)) {
      fs.mkdirSync(path.dirname(args.screenshot_path), { recursive: true });
      fs.writeFileSync(args.screenshot_path, buf);
    }
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const finalUrl = args.url ?? opts.url;
    const result: SeeResult = {
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
    };
    return result;
  };
}

function visionStub(text: string, costUsd = 0.005) {
  return async () => ({
    text,
    inputTokens: 100,
    outputTokens: 200,
    costUsd,
  });
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "judge-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// resolveCriteria
// ─────────────────────────────────────────────────────────────

describe("judge — resolveCriteria", () => {
  it("default rubric is aesthetic", () => {
    const { criteria, rubrics } = resolveCriteria({});
    expect(rubrics).toEqual(["aesthetic"]);
    expect(criteria.length).toBe(AESTHETIC_CRITERIA.length);
    expect(criteria.every((c) => c.kind === "aesthetic")).toBe(true);
  });

  it("aesthetic + dark_pattern emits both rubrics' criteria, in order", () => {
    const { criteria, rubrics } = resolveCriteria({
      rubrics: ["aesthetic", "dark_pattern"],
    });
    expect(rubrics).toEqual(["aesthetic", "dark_pattern"]);
    expect(criteria.length).toBe(
      AESTHETIC_CRITERIA.length + DARK_PATTERN_CRITERIA.length,
    );
    // First N are aesthetic, then dark_pattern
    expect(criteria[0]!.kind).toBe("aesthetic");
    expect(criteria[AESTHETIC_CRITERIA.length]!.kind).toBe("dark_pattern");
  });

  it("dedupes repeated rubrics in input", () => {
    const { rubrics, criteria } = resolveCriteria({
      rubrics: ["aesthetic", "aesthetic"],
    });
    expect(rubrics).toEqual(["aesthetic"]);
    expect(criteria.length).toBe(AESTHETIC_CRITERIA.length);
  });

  it("appends custom criteria with kind=custom and adds 'custom' rubric tag", () => {
    const { rubrics, criteria } = resolveCriteria({
      rubrics: ["aesthetic"],
      customCriteria: [
        { id: "pricing_clarity", label: "Pricing clarity", description: "How clear is pricing?" },
      ],
    });
    expect(rubrics).toEqual(["aesthetic", "custom"]);
    expect(criteria[criteria.length - 1]!).toEqual({
      id: "pricing_clarity",
      label: "Pricing clarity",
      description: "How clear is pricing?",
      kind: "custom",
    });
  });

  it("dedupes criteria by id across rubrics + custom", () => {
    const { criteria } = resolveCriteria({
      rubrics: ["aesthetic"],
      customCriteria: [
        { id: "visual_hierarchy", label: "Hierarchy", description: "dup" },
      ],
    });
    // visual_hierarchy already in aesthetic — not duplicated
    const ids = criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("standalone 'custom' rubric with no customCriteria errors", () => {
    expect(() => resolveCriteria({ rubrics: ["custom"] })).toThrow(
      /no criteria/,
    );
  });

  it("empty input errors (defensive — caller cannot send no rubrics + no custom)", () => {
    expect(() => resolveCriteria({ rubrics: [] })).toThrow(/no criteria/);
  });

  it("ids are stable snake_case (no spaces, no uppercase)", () => {
    for (const c of [...AESTHETIC_CRITERIA, ...DARK_PATTERN_CRITERIA]) {
      expect(c.id).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────

describe("judge — prompts", () => {
  it("system prompt embeds every criterion id, label, and description", () => {
    const { criteria } = resolveCriteria({ rubrics: ["aesthetic"] });
    const sys = buildJudgeSystemPrompt(criteria);
    for (const c of criteria) {
      expect(sys).toContain(`id: ${c.id}`);
      expect(sys).toContain(`label: ${c.label}`);
      expect(sys).toContain(c.description);
    }
  });

  it("system prompt requires JSON output and lists severity values", () => {
    const sys = buildJudgeSystemPrompt(AESTHETIC_CRITERIA);
    expect(sys).toMatch(/Return ONLY the JSON/);
    expect(sys).toContain("critical");
    expect(sys).toContain("high");
    expect(sys).toContain("medium");
    expect(sys).toContain("low");
  });

  it("user prompt enumerates criterion ids comma-separated", () => {
    const u = buildJudgeUserPrompt(AESTHETIC_CRITERIA);
    for (const c of AESTHETIC_CRITERIA) {
      expect(u).toContain(c.id);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// parseJudgeRawJson — defensive coercion
// ─────────────────────────────────────────────────────────────

describe("judge — parseJudgeRawJson", () => {
  const criteria = AESTHETIC_CRITERIA.slice(0, 2);
  const fakeResp = {
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  it("clamps scores into 0..10", () => {
    const raw = {
      verdicts: [
        { criterion_id: "visual_hierarchy", score: 11, rationale: "hi", evidence: [] },
        { criterion_id: "typography", score: -2, rationale: "lo", evidence: [] },
      ],
      findings: [],
    };
    const out = parseJudgeRawJson(raw, criteria, fakeResp);
    expect(out.verdicts[0]!.score).toBe(10);
    expect(out.verdicts[1]!.score).toBe(0);
  });

  it("drops verdicts with unknown criterion_id", () => {
    const raw = {
      verdicts: [
        { criterion_id: "not_a_real_criterion", score: 7, rationale: "x", evidence: [] },
        { criterion_id: "visual_hierarchy", score: 7, rationale: "y", evidence: [] },
      ],
      findings: [],
    };
    const out = parseJudgeRawJson(raw, criteria, fakeResp);
    expect(out.verdicts.map((v) => v.criterion_id)).toEqual(["visual_hierarchy"]);
  });

  it("drops findings with unknown severity", () => {
    const raw = {
      verdicts: [],
      findings: [
        { severity: "fatal", criterion_id: null, description: "x", recommendation: "y" },
        { severity: "high", criterion_id: null, description: "ok", recommendation: "ok" },
      ],
    };
    const out = parseJudgeRawJson(raw, criteria, fakeResp);
    expect(out.findings.length).toBe(1);
    expect(out.findings[0]!.severity).toBe("high");
  });

  it("normalises unknown criterion_id on a finding to null (cross-cutting)", () => {
    const raw = {
      verdicts: [],
      findings: [
        { severity: "low", criterion_id: "ghost", description: "x", recommendation: "y" },
      ],
    };
    const out = parseJudgeRawJson(raw, criteria, fakeResp);
    expect(out.findings[0]!.criterion_id).toBeNull();
  });

  it("treats malformed input as empty verdicts/findings + null summary", () => {
    const out = parseJudgeRawJson("not json at all", criteria, fakeResp);
    expect(out.verdicts).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.summary).toBeNull();
  });

  it("preserves summary string when present", () => {
    const raw = {
      verdicts: [],
      findings: [],
      summary: "Strong polish but obstruction lowers trust.",
    };
    const out = parseJudgeRawJson(raw, criteria, fakeResp);
    expect(out.summary).toBe("Strong polish but obstruction lowers trust.");
  });
});

// ─────────────────────────────────────────────────────────────
// computeOverallScore
// ─────────────────────────────────────────────────────────────

describe("judge — computeOverallScore", () => {
  it("returns null when no verdicts", () => {
    expect(computeOverallScore([])).toBeNull();
  });
  it("returns mean rounded to 2dp", () => {
    const v = [
      { criterion_id: "a", score: 7, rationale: "", evidence: [] },
      { criterion_id: "b", score: 8, rationale: "", evidence: [] },
      { criterion_id: "c", score: 6.7, rationale: "", evidence: [] },
    ];
    expect(computeOverallScore(v)).toBeCloseTo(7.23, 2);
  });

  it("does not let a missing verdict inflate the score (E6)", () => {
    // 3 criteria were expected, but the model only returned 2 (both high).
    // Averaging over the 2 present would read 8.0; scaling to the full
    // rubric treats the omitted criterion as 0 → 16/3 = 5.33.
    const v = [
      { criterion_id: "a", score: 8, rationale: "", evidence: [] },
      { criterion_id: "b", score: 8, rationale: "", evidence: [] },
    ];
    expect(computeOverallScore(v)).toBeCloseTo(8.0, 2); // legacy (no count)
    expect(computeOverallScore(v, 3)).toBeCloseTo(5.33, 2); // scaled to rubric
  });

  it("never divides by less than the verdicts present", () => {
    const v = [
      { criterion_id: "a", score: 6, rationale: "", evidence: [] },
      { criterion_id: "b", score: 8, rationale: "", evidence: [] },
    ];
    // A bogus tiny criteriaCount must not over-inflate by shrinking denom.
    expect(computeOverallScore(v, 1)).toBeCloseTo(7.0, 2);
  });
});

// ─────────────────────────────────────────────────────────────
// Primitive — seam tests
// ─────────────────────────────────────────────────────────────

describe("judge — schema field plumbing via _see + _callVision", () => {
  it("populates url, title, dom, console, screenshot from upstream see", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const mockJson = JSON.stringify({
      verdicts: AESTHETIC_CRITERIA.map((c) => ({
        criterion_id: c.id,
        score: 7,
        rationale: `ok ${c.id}`,
        evidence: [],
      })),
      findings: [],
      summary: "Looks fine.",
    });

    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ url: "https://example.com/", screenshot_path: screenshotPath }),
      _callVision: visionStub(mockJson),
    } satisfies JudgeOptions);

    expect(r.status).toBe("ok");
    expect(r.url_input).toBe("https://example.com");
    expect(r.url_final).toBe("https://example.com/");
    expect(r.title).toBe("Stub page");
    expect(r.dom).not.toBeNull();
    expect(r.console).not.toBeNull();
    expect(r.screenshot?.path).toBe(screenshotPath);
    expect(r.persona_id).toBe(DEFAULT_JUDGE_PERSONA_ID);
    expect(r.model).toBe(DEFAULT_JUDGE_MODEL);
    expect(r.rubrics).toEqual(["aesthetic"]);
    expect(r.criteria.length).toBe(AESTHETIC_CRITERIA.length);
    expect(r.verdicts.length).toBe(AESTHETIC_CRITERIA.length);
    expect(r.summary).toBe("Looks fine.");
    expect(r.cost_usd).toBeCloseTo(0.005, 5);
    expect(r.schema_version).toBe(RESULT_SCHEMA_VERSION);
  });

  it("uses pre-existing capture without calling _see", async () => {
    const screenshotPath = path.join(workspace, "preexisting.png");
    fs.writeFileSync(screenshotPath, tinyPng());

    let seeWasCalled = false;
    const r = await judge({
      capture: {
        url_input: "https://cached.example.com",
        url_final: "https://cached.example.com/x",
        title: "Cached page",
        screenshot_path: screenshotPath,
        loaded_at: "2026-04-30T00:00:00.000Z",
      },
      artifactsRoot: workspace,
      _see: ((async () => {
        seeWasCalled = true;
        return null as unknown as SeeResult;
      }) as unknown) as typeof import("../../src/core/primitives/see.js").see,
      _callVision: visionStub(
        JSON.stringify({ verdicts: [], findings: [], summary: null }),
      ),
    } satisfies JudgeOptions);

    expect(seeWasCalled).toBe(false);
    expect(r.status).toBe("ok");
    expect(r.url_input).toBe("https://cached.example.com");
    expect(r.url_final).toBe("https://cached.example.com/x");
    expect(r.title).toBe("Cached page");
    expect(r.loaded_at).toBe("2026-04-30T00:00:00.000Z");
    expect(r.screenshot?.path).toBe(screenshotPath);
  });

  it("rubrics arg drives criteria + rubrics in result", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const r = await judge({
      url: "https://example.com",
      rubrics: ["dark_pattern"],
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath }),
      _callVision: visionStub(JSON.stringify({ verdicts: [], findings: [], summary: null })),
    });
    expect(r.rubrics).toEqual(["dark_pattern"]);
    expect(r.criteria.length).toBe(DARK_PATTERN_CRITERIA.length);
    expect(r.criteria.every((c) => c.kind === "dark_pattern")).toBe(true);
  });

  it("custom criteria appear in result with kind=custom", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const r = await judge({
      url: "https://example.com",
      rubrics: ["aesthetic"],
      customCriteria: [
        { id: "pricing_clarity", label: "Pricing clarity", description: "Is pricing clear?" },
      ],
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath }),
      _callVision: visionStub(JSON.stringify({ verdicts: [], findings: [], summary: null })),
    });
    const last = r.criteria[r.criteria.length - 1]!;
    expect(last.id).toBe("pricing_clarity");
    expect(last.kind).toBe("custom");
    expect(r.rubrics).toContain("custom");
  });

  it("propagates upstream see's cost into total cost_usd", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath, cost: 0.001 }),
      _callVision: visionStub(
        JSON.stringify({ verdicts: [], findings: [], summary: null }),
        0.005,
      ),
    });
    expect(r.cost_usd).toBeCloseTo(0.006, 5);
  });

  it("error from upstream see surfaces as status=error with the message", async () => {
    const failingSee = (async () => {
      const failed: SeeResult = {
        schema_version: RESULT_SCHEMA_VERSION,
        url_input: "https://example.com",
        url_final: "https://example.com",
        title: "",
        loaded_at: new Date().toISOString(),
        status: "error",
        error: "net::ERR_NAME_NOT_RESOLVED",
        dom: null,
        console: null,
        screenshot: null,
        note: null,
        persona_id: "see-default-desktop",
        artifacts_dir: "/tmp",
        cost_usd: 0,
        duration_ms: 1,
      };
      return failed;
    }) as unknown as typeof import("../../src/core/primitives/see.js").see;

    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: failingSee,
      _callVision: visionStub("{}"),
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("ERR_NAME_NOT_RESOLVED");
    expect(r.verdicts).toEqual([]);
  });

  it("missing url and capture throws synchronously", async () => {
    await expect(judge({ artifactsRoot: workspace } as JudgeOptions)).rejects.toThrow(
      /url.*capture/i,
    );
  });

  it("artifacts dir is unique per call", async () => {
    const ssA = path.join(workspace, "a.png");
    const ssB = path.join(workspace, "b.png");
    const stub = visionStub(JSON.stringify({ verdicts: [], findings: [], summary: null }));

    const a = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: ssA }),
      _callVision: stub,
    });
    const b = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: ssB }),
      _callVision: stub,
    });
    expect(a.artifacts_dir).not.toBe(b.artifacts_dir);
    expect(fs.existsSync(a.artifacts_dir)).toBe(true);
    expect(fs.existsSync(b.artifacts_dir)).toBe(true);
  });

  it("writes a judge.json sidecar with the full result", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath }),
      _callVision: visionStub(JSON.stringify({ verdicts: [], findings: [], summary: "ok" })),
    });
    const sidecar = path.join(r.artifacts_dir, "judge.json");
    expect(fs.existsSync(sidecar)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    expect(parsed.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(parsed.summary).toBe("ok");
  });

  it("AUDIT_JUDGES_DIR env override changes default artifacts root", () => {
    const prev = process.env.AUDIT_JUDGES_DIR;
    try {
      process.env.AUDIT_JUDGES_DIR = "/tmp/judge-test-override";
      expect(defaultJudgeArtifactsRoot()).toBe("/tmp/judge-test-override");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_JUDGES_DIR;
      else process.env.AUDIT_JUDGES_DIR = prev;
    }
  });

  it("model option propagates into the result envelope", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const r = await judge({
      url: "https://example.com",
      model: "claude-haiku-4-5-20251001",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath }),
      _callVision: visionStub(JSON.stringify({ verdicts: [], findings: [], summary: null })),
    });
    expect(r.model).toBe("claude-haiku-4-5-20251001");
  });

  it("vision returns malformed JSON → result still ok with empty verdicts + diagnostic finding", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath }),
      _callVision: visionStub("totally not json", 0.003),
    });
    expect(r.status).toBe("ok");
    expect(r.verdicts).toEqual([]);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.severity).toBe("low");
    expect(r.findings[0]!.description.toLowerCase()).toContain("malformed");
    // cost still recorded
    expect(r.cost_usd).toBeCloseTo(0.003, 5);
  });

  it("overall_score scales partial verdicts to the full rubric (E6)", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const mock = JSON.stringify({
      verdicts: [
        { criterion_id: "visual_hierarchy", score: 8, rationale: "x", evidence: [] },
        { criterion_id: "typography", score: 6, rationale: "y", evidence: [] },
      ],
      findings: [],
      summary: null,
    });
    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath }),
      _callVision: visionStub(mock),
    });
    // Only 2 of the aesthetic rubric's criteria were scored; the rest count
    // as 0 so an incomplete judgment can't inflate the headline score.
    expect(r.overall_score).toBeCloseTo(14 / AESTHETIC_CRITERIA.length, 2);
  });

  // ── PR-D / ADR-034 — diagnostics.visual mirror ───────────────
  it("emits diagnostics.visual mirroring its own verdicts/findings/summary (PR-D)", async () => {
    const screenshotPath = path.join(workspace, "ss.png");
    const mock = JSON.stringify({
      verdicts: [
        { criterion_id: "visual_hierarchy", score: 9, rationale: "Strong.", evidence: [] },
      ],
      findings: [
        {
          severity: "low",
          criterion_id: "visual_hierarchy",
          description: "Minor whitespace gap.",
          location: "hero",
          recommendation: "Tighten margin.",
        },
      ],
      summary: "Strong layout overall.",
    });
    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: fakeSee({ screenshot_path: screenshotPath }),
      _callVision: visionStub(mock, 0.012),
    });
    expect(r.status).toBe("ok");
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics?.collected_at).toBe("always");
    expect(r.diagnostics?.visual).toBeDefined();
    expect(r.diagnostics?.visual?.scored).toBe(true);
    expect(r.diagnostics?.visual?.rubrics).toContain("aesthetic");
    expect(r.diagnostics?.visual?.verdicts).toHaveLength(1);
    expect(r.diagnostics?.visual?.verdicts[0]?.criterion_id).toBe("visual_hierarchy");
    // The mirror attaches label + kind so consumers don't need to join the rubric.
    expect(r.diagnostics?.visual?.verdicts[0]?.label).toBe("Visual hierarchy");
    expect(r.diagnostics?.visual?.verdicts[0]?.kind).toBe("aesthetic");
    expect(r.diagnostics?.visual?.findings).toHaveLength(1);
    expect(r.diagnostics?.visual?.summary).toBe("Strong layout overall.");
    // One verdict (score 9) over the full aesthetic rubric — scaled down so a
    // single returned verdict can't read as a perfect overall score (E6).
    expect(r.diagnostics?.visual?.overall_score).toBeCloseTo(
      9 / AESTHETIC_CRITERIA.length,
      2,
    );
  });

  it("emits a vision_error diagnostics.visual envelope when status='error' (PR-D)", async () => {
    // Force the inner see to fail so the judge result is status='error'.
    const r = await judge({
      url: "https://example.com",
      artifactsRoot: workspace,
      _see: async () => {
        throw new Error("simulated capture failure");
      },
      _callVision: visionStub("{}"),
    });
    expect(r.status).toBe("error");
    expect(r.diagnostics?.visual?.scored).toBe(false);
    expect(r.diagnostics?.visual?.skip_reason).toBe("vision_error");
  });
});

// ─────────────────────────────────────────────────────────────
// Real Chromium integration
// ─────────────────────────────────────────────────────────────

describe("judge — integration (real Chromium + fixture site, stubbed vision)", () => {
  let fixture: FixtureServer;
  let intWorkspace: string;
  let warmBrowser: Browser | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    intWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "judge-int-"));
    try {
      warmBrowser = await chromium.launch({ headless: true });
    } catch {
      warmBrowser = null;
    }
  }, 60_000);

  afterAll(async () => {
    await warmBrowser?.close().catch(() => {});
    await fixture?.close().catch(() => {});
    try {
      fs.rmSync(intWorkspace, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("loads a real fixture page, navigates via see, runs judge with stub vision", async () => {
    if (!warmBrowser) return;
    const mockJson = JSON.stringify({
      verdicts: AESTHETIC_CRITERIA.slice(0, 2).map((c) => ({
        criterion_id: c.id,
        score: 7,
        rationale: `${c.label} looks ok`,
        evidence: [],
      })),
      findings: [
        {
          severity: "low" as const,
          criterion_id: "visual_hierarchy",
          description: "Headline could be bolder.",
          location: "hero",
          recommendation: "Increase headline weight to 700.",
        },
      ],
      summary: "Solid first impression.",
    });

    const r = await judge({
      url: `${fixture.url}/index.html`,
      rubrics: ["aesthetic"],
      artifactsRoot: intWorkspace,
      waitFor: "domcontentloaded",
      timeoutMs: 15000,
      _callVision: visionStub(mockJson, 0.0042),
    });
    expect(r.status).toBe("ok");
    expect(r.url_final).toContain("index.html");
    expect(r.title).toBe("AV Fixture — Home");
    expect(r.dom).not.toBeNull();
    expect(r.dom!.interactive_count).toBeGreaterThan(0);
    expect(r.screenshot).not.toBeNull();
    expect(fs.statSync(r.screenshot!.path).size).toBeGreaterThan(100);
    expect(r.verdicts.length).toBe(2);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.criterion_id).toBe("visual_hierarchy");
    expect(r.summary).toBe("Solid first impression.");
    expect(r.cost_usd).toBeCloseTo(0.0042, 5);
    // sidecar
    expect(fs.existsSync(path.join(r.artifacts_dir, "judge.json"))).toBe(true);
  }, 30_000);
});
