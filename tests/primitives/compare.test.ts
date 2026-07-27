/**
 * Tests for the `compare` primitive (N-3).
 *
 * Layers:
 *   1. Prompt construction — system + user prompts embed every criterion id
 *      and switch behaviour by mode.
 *   2. parseCompareRawJson — defensive coercion + majority-winner fallback.
 *   3. Primitive seam tests — `_judge` + `_callVision` stubs cover both
 *      modes, error paths, captures vs urls, ledger cost accounting,
 *      sidecar JSON write, anchor-bias-free double-blind path.
 *   4. Real Chromium integration — fixture site A vs A (same URL twice)
 *      end-to-end with stub vision.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser } from "playwright";

import {
  compare,
  buildCompareSystemPrompt,
  buildCompareUserPrompt,
  parseCompareRawJson,
  majorityWinner,
  defaultCompareArtifactsRoot,
  DEFAULT_COMPARE_MODE,
  DEFAULT_COMPARE_MODEL,
} from "../../src/core/primitives/compare.js";
import type { CompareOptions } from "../../src/core/primitives/compare.js";
import type { JudgeOptions } from "../../src/core/primitives/judge.js";
import { AESTHETIC_CRITERIA } from "../../src/core/critics/aesthetic.js";
import { RESULT_SCHEMA_VERSION, type JudgeResultShape } from "../../src/core/result-schema.js";
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

function fakeJudge(args: {
  url?: string;
  screenshotPath: string;
  status?: "ok" | "error";
  error?: string;
  cost?: number;
  verdicts?: JudgeResultShape["verdicts"];
}): typeof import("../../src/core/primitives/judge.js").judge {
  return async (opts: JudgeOptions): Promise<JudgeResultShape> => {
    if (!fs.existsSync(args.screenshotPath)) {
      fs.mkdirSync(path.dirname(args.screenshotPath), { recursive: true });
      fs.writeFileSync(args.screenshotPath, tinyPng());
    }
    const sha = crypto.createHash("sha256").update(tinyPng()).digest("hex");
    const url = args.url ?? opts.url ?? "https://stub";
    return {
      schema_version: RESULT_SCHEMA_VERSION,
      url_input: url,
      url_final: url,
      title: "Stub side",
      loaded_at: new Date().toISOString(),
      status: args.status ?? "ok",
      error: args.error,
      rubrics: ["aesthetic"],
      criteria: AESTHETIC_CRITERIA.slice(0, 2),
      verdicts: args.verdicts ?? [
        { criterion_id: "visual_hierarchy", score: 7, rationale: "ok", evidence: [] },
        { criterion_id: "typography", score: 6, rationale: "ok", evidence: [] },
      ],
      findings: [],
      overall_score: 6.5,
      summary: null,
      dom: { interactive_count: 3, headings: ["h1"], summary: "[Headings]\nh1" },
      console: { errors_count: 0, errors: [] },
      screenshot: {
        path: args.screenshotPath,
        sha256: sha,
        bytes: tinyPng().length,
        width: 1280,
        height: 800,
      },
      persona_id: opts.persona?.id ?? "judge-default-desktop",
      artifacts_dir: opts.artifactsRoot ?? "/tmp",
      model: opts.model ?? "claude-sonnet-4-6",
      cost_usd: args.cost ?? 0.005,
      duration_ms: 12,
    };
  };
}

function visionStub(text: string, costUsd = 0.006) {
  return async () => ({
    text,
    inputTokens: 100,
    outputTokens: 200,
    costUsd,
  });
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "compare-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────

describe("compare — prompts", () => {
  it("system prompt embeds every criterion id and references both sides", () => {
    const sys = buildCompareSystemPrompt({
      criteria: AESTHETIC_CRITERIA.slice(0, 3),
      mode: "double_blind",
    });
    expect(sys).toMatch(/SIDE A/);
    expect(sys).toMatch(/SIDE B/);
    for (const c of AESTHETIC_CRITERIA.slice(0, 3)) {
      expect(sys).toContain(c.id);
    }
  });

  it("system prompt switches mode-specific instructions for fast vs double_blind", () => {
    const fast = buildCompareSystemPrompt({
      criteria: AESTHETIC_CRITERIA.slice(0, 1),
      mode: "fast",
    });
    const blind = buildCompareSystemPrompt({
      criteria: AESTHETIC_CRITERIA.slice(0, 1),
      mode: "double_blind",
    });
    expect(fast).toMatch(/REQUIRED.*score side A/);
    expect(blind).toMatch(/per-side judgements/);
  });

  it("user prompt includes prior judgements when both judges are passed", () => {
    const fakeJ: JudgeResultShape = {
      schema_version: RESULT_SCHEMA_VERSION,
      url_input: "https://a",
      url_final: "https://a",
      title: "A",
      loaded_at: "x",
      status: "ok",
      rubrics: ["aesthetic"],
      criteria: AESTHETIC_CRITERIA.slice(0, 1),
      verdicts: [{ criterion_id: "visual_hierarchy", score: 8, rationale: "Hero CTA strong.", evidence: [] }],
      findings: [],
      overall_score: 8,
      summary: null,
      dom: null,
      console: null,
      screenshot: null,
      persona_id: "x",
      artifacts_dir: "x",
      model: "x",
      cost_usd: 0,
      duration_ms: 0,
    };
    const u = buildCompareUserPrompt({
      criteria: AESTHETIC_CRITERIA.slice(0, 1),
      judgeA: fakeJ,
      judgeB: { ...fakeJ, url_input: "https://b", verdicts: [{ criterion_id: "visual_hierarchy", score: 5, rationale: "Cluttered.", evidence: [] }] },
    });
    expect(u).toMatch(/Prior independent judgements/);
    expect(u).toContain("A.visual_hierarchy: 8");
    expect(u).toContain("B.visual_hierarchy: 5");
  });

  it("user prompt omits prior section when judges are not provided (fast mode)", () => {
    const u = buildCompareUserPrompt({
      criteria: AESTHETIC_CRITERIA.slice(0, 1),
    });
    expect(u).not.toMatch(/Prior independent judgements/);
  });
});

// ─────────────────────────────────────────────────────────────
// parseCompareRawJson + majorityWinner
// ─────────────────────────────────────────────────────────────

describe("compare — parseCompareRawJson", () => {
  const criteria = AESTHETIC_CRITERIA.slice(0, 3);

  it("clamps per-side scores into 0..10 and accepts null", () => {
    const raw = {
      per_criterion: [
        { criterion_id: "visual_hierarchy", score_a: 11, score_b: -2, winner: "a", rationale: "x" },
        { criterion_id: "typography", score_a: null, score_b: null, winner: "tie", rationale: "y" },
      ],
      overall_winner: "a",
      summary: "z",
    };
    const out = parseCompareRawJson(raw, criteria);
    expect(out.perCriterion[0]!.score_a).toBe(10);
    expect(out.perCriterion[0]!.score_b).toBe(0);
    expect(out.perCriterion[1]!.score_a).toBeNull();
    expect(out.perCriterion[1]!.score_b).toBeNull();
  });

  it("reconciles a winner that contradicts its numeric scores (E6)", () => {
    const raw = {
      per_criterion: [
        // Stated winner "a" but b scored higher — derive from scores → "b".
        { criterion_id: "visual_hierarchy", score_a: 3, score_b: 8, winner: "a", rationale: "x" },
        // Scores tie → "tie" regardless of stated "a".
        { criterion_id: "typography", score_a: 6, score_b: 6, winner: "a", rationale: "y" },
      ],
      overall_winner: "a",
      summary: null,
    };
    const out = parseCompareRawJson(raw, criteria);
    expect(out.perCriterion[0]!.winner).toBe("b");
    expect(out.perCriterion[1]!.winner).toBe("tie");
  });

  it("keeps the stated label when a side score is null (fast label-only)", () => {
    const raw = {
      per_criterion: [
        { criterion_id: "visual_hierarchy", score_a: null, score_b: null, winner: "a", rationale: "x" },
      ],
      overall_winner: "a",
      summary: null,
    };
    const out = parseCompareRawJson(raw, criteria);
    expect(out.perCriterion[0]!.winner).toBe("a");
  });

  it("drops per-criterion entries with unknown criterion_id or invalid winner", () => {
    const raw = {
      per_criterion: [
        { criterion_id: "ghost", score_a: 5, score_b: 5, winner: "a", rationale: "x" },
        { criterion_id: "visual_hierarchy", score_a: 7, score_b: 5, winner: "draw", rationale: "y" },
        { criterion_id: "typography", score_a: 8, score_b: 6, winner: "a", rationale: "z" },
      ],
      overall_winner: "a",
      summary: null,
    };
    const out = parseCompareRawJson(raw, criteria);
    expect(out.perCriterion.length).toBe(1);
    expect(out.perCriterion[0]!.criterion_id).toBe("typography");
  });

  it("falls back to majority winner when overall_winner is missing/invalid", () => {
    const raw = {
      per_criterion: [
        { criterion_id: "visual_hierarchy", score_a: 7, score_b: 5, winner: "a", rationale: "" },
        { criterion_id: "typography", score_a: 6, score_b: 8, winner: "b", rationale: "" },
        { criterion_id: "alignment_grid", score_a: 7, score_b: 5, winner: "a", rationale: "" },
      ],
      overall_winner: "draw", // invalid
      summary: null,
    };
    const out = parseCompareRawJson(raw, criteria);
    expect(out.overallWinner).toBe("a"); // majority
  });

  it("treats malformed input as empty + tie", () => {
    const out = parseCompareRawJson("garbage", criteria);
    expect(out.perCriterion).toEqual([]);
    expect(out.overallWinner).toBe("tie");
    expect(out.summary).toBeNull();
  });
});

describe("compare — majorityWinner", () => {
  it("returns tie on empty", () => {
    expect(majorityWinner([])).toBe("tie");
  });
  it("returns tie when a==b", () => {
    expect(
      majorityWinner([
        { criterion_id: "x", score_a: 1, score_b: 1, winner: "a", rationale: "" },
        { criterion_id: "y", score_a: 1, score_b: 1, winner: "b", rationale: "" },
      ]),
    ).toBe("tie");
  });
  it("returns the side with more wins", () => {
    expect(
      majorityWinner([
        { criterion_id: "x", score_a: 1, score_b: 1, winner: "a", rationale: "" },
        { criterion_id: "y", score_a: 1, score_b: 1, winner: "a", rationale: "" },
        { criterion_id: "z", score_a: 1, score_b: 1, winner: "b", rationale: "" },
      ]),
    ).toBe("a");
  });
});

// ─────────────────────────────────────────────────────────────
// Primitive — seam tests
// ─────────────────────────────────────────────────────────────

describe("compare — double_blind mode (default)", () => {
  it("calls _judge twice in parallel + 1 synthesis call; sums all costs", async () => {
    const ssA = path.join(workspace, "a.png");
    const ssB = path.join(workspace, "b.png");

    const judgeImpl = fakeJudge({ screenshotPath: ssA, cost: 0.004 });
    let judgeCalls = 0;
    const wrappedJudge = (async (opts: JudgeOptions) => {
      judgeCalls += 1;
      const isB = (opts.url ?? "").includes("b.example");
      return fakeJudge({
        url: opts.url,
        screenshotPath: isB ? ssB : ssA,
        cost: 0.004,
      })(opts);
    }) as typeof import("../../src/core/primitives/judge.js").judge;

    const synthMock = JSON.stringify({
      per_criterion: [
        { criterion_id: "visual_hierarchy", score_a: 8, score_b: 6, winner: "a", rationale: "A's hero is bolder." },
        { criterion_id: "typography", score_a: 7, score_b: 7, winner: "tie", rationale: "Comparable type ramps." },
      ],
      overall_winner: "a",
      summary: "Side A leads on hero clarity.",
    });

    const r = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      artifactsRoot: workspace,
      _judge: wrappedJudge,
      _callVision: visionStub(synthMock, 0.006),
    } satisfies CompareOptions);

    expect(judgeCalls).toBe(2);
    expect(r.mode).toBe("double_blind");
    expect(r.status).toBe("ok");
    expect(r.side_a.judge).not.toBeNull();
    expect(r.side_b.judge).not.toBeNull();
    expect(r.per_criterion.length).toBe(2);
    expect(r.overall_winner).toBe("a");
    expect(r.summary).toBe("Side A leads on hero clarity.");
    expect(r.cost_usd).toBeCloseTo(0.004 + 0.004 + 0.006, 5);
    expect(r.schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(r.model).toBe(DEFAULT_COMPARE_MODEL);
    void judgeImpl;
  });

  it("default mode is double_blind", async () => {
    const ssA = path.join(workspace, "a.png");
    const r = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      artifactsRoot: workspace,
      _judge: fakeJudge({ screenshotPath: ssA }),
      _callVision: visionStub(JSON.stringify({ per_criterion: [], overall_winner: "tie", summary: null })),
    });
    expect(r.mode).toBe(DEFAULT_COMPARE_MODE);
    expect(r.mode).toBe("double_blind");
  });

  it("side A judge failure surfaces as compare-level error with cost from both judges retained", async () => {
    const ssA = path.join(workspace, "a.png");
    const ssB = path.join(workspace, "b.png");

    const wrappedJudge = (async (opts: JudgeOptions) => {
      const isB = (opts.url ?? "").includes("b.example");
      if (!isB) {
        return fakeJudge({
          url: opts.url,
          screenshotPath: ssA,
          status: "error",
          error: "net::ERR_NAME_NOT_RESOLVED",
          cost: 0.001,
        })(opts);
      }
      return fakeJudge({ url: opts.url, screenshotPath: ssB, cost: 0.004 })(opts);
    }) as typeof import("../../src/core/primitives/judge.js").judge;

    const r = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      artifactsRoot: workspace,
      _judge: wrappedJudge,
      _callVision: visionStub("{}"),
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("ERR_NAME_NOT_RESOLVED");
    expect(r.cost_usd).toBeCloseTo(0.005, 5); // 0.001 + 0.004 — synthesis NOT charged
  });

  it("re-uses an existing capture instead of calling _judge", async () => {
    const ssA = path.join(workspace, "preexisting-a.png");
    const ssB = path.join(workspace, "preexisting-b.png");
    fs.writeFileSync(ssA, tinyPng());
    fs.writeFileSync(ssB, tinyPng());

    let judgeCalls = 0;
    const wrappedJudge = (async (opts: JudgeOptions) => {
      judgeCalls++;
      // judge with capture should NOT call see, but may still do its own
      // vision call. We honour that with a minimal happy-path stub.
      return fakeJudge({
        url: opts.capture?.url_final ?? opts.url,
        screenshotPath: opts.capture?.screenshot_path ?? ssA,
      })(opts);
    }) as typeof import("../../src/core/primitives/judge.js").judge;

    const r = await compare({
      a: {
        capture: {
          url_final: "https://a.example.com/",
          title: "A",
          screenshot_path: ssA,
        },
      },
      b: {
        capture: {
          url_final: "https://b.example.com/",
          title: "B",
          screenshot_path: ssB,
        },
      },
      artifactsRoot: workspace,
      _judge: wrappedJudge,
      _callVision: visionStub(JSON.stringify({ per_criterion: [], overall_winner: "tie", summary: null })),
    });
    expect(judgeCalls).toBe(2); // judge IS called per side, but with capture (not url)
    expect(r.side_a.url_final).toBe("https://a.example.com/");
    expect(r.side_b.url_final).toBe("https://b.example.com/");
  });

  it("rubric arg flows through to embedded judge results", async () => {
    const ssA = path.join(workspace, "a.png");
    const wrappedJudge = (async (opts: JudgeOptions) => {
      // Echo whatever rubrics caller passed.
      const j = await fakeJudge({ url: opts.url, screenshotPath: ssA })(opts);
      return { ...j, rubrics: opts.rubrics ?? ["aesthetic"] };
    }) as typeof import("../../src/core/primitives/judge.js").judge;

    const r = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      rubrics: ["aesthetic", "dark_pattern"],
      artifactsRoot: workspace,
      _judge: wrappedJudge,
      _callVision: visionStub(JSON.stringify({ per_criterion: [], overall_winner: "tie", summary: null })),
    });
    expect(r.rubrics).toEqual(["aesthetic", "dark_pattern"]);
    expect(r.side_a.judge?.rubrics).toEqual(["aesthetic", "dark_pattern"]);
  });

  it("custom criteria flow through and appear in result.criteria", async () => {
    const ssA = path.join(workspace, "a.png");
    const r = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      rubrics: ["aesthetic"],
      customCriteria: [
        { id: "pricing_clarity", label: "Pricing clarity", description: "How clear is pricing?" },
      ],
      artifactsRoot: workspace,
      _judge: fakeJudge({ screenshotPath: ssA }),
      _callVision: visionStub(JSON.stringify({ per_criterion: [], overall_winner: "tie", summary: null })),
    });
    expect(r.rubrics).toContain("custom");
    const ids = r.criteria.map((c) => c.id);
    expect(ids).toContain("pricing_clarity");
  });

  it("missing url AND capture on side A throws", async () => {
    await expect(
      compare({
        a: {} as never,
        b: { url: "https://b.example.com" },
        artifactsRoot: workspace,
        _judge: fakeJudge({ screenshotPath: path.join(workspace, "a.png") }),
        _callVision: visionStub("{}"),
      }),
    ).rejects.toThrow(/side A.*url.*capture/i);
  });

  it("missing url AND capture on side B throws", async () => {
    await expect(
      compare({
        a: { url: "https://a.example.com" },
        b: {} as never,
        artifactsRoot: workspace,
        _judge: fakeJudge({ screenshotPath: path.join(workspace, "b.png") }),
        _callVision: visionStub("{}"),
      }),
    ).rejects.toThrow(/side B.*url.*capture/i);
  });

  it("artifacts dir is unique per call and isolates side a vs b", async () => {
    const ssA = path.join(workspace, "x.png");
    const stubVision = visionStub(JSON.stringify({ per_criterion: [], overall_winner: "tie", summary: null }));
    const r1 = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      artifactsRoot: workspace,
      _judge: fakeJudge({ screenshotPath: ssA }),
      _callVision: stubVision,
    });
    const r2 = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      artifactsRoot: workspace,
      _judge: fakeJudge({ screenshotPath: ssA }),
      _callVision: stubVision,
    });
    expect(r1.artifacts_dir).not.toBe(r2.artifacts_dir);
    // Each has /a and /b subdirs
    expect(fs.existsSync(path.join(r1.artifacts_dir, "a"))).toBe(true);
    expect(fs.existsSync(path.join(r1.artifacts_dir, "b"))).toBe(true);
  });

  it("writes a compare.json sidecar", async () => {
    const ssA = path.join(workspace, "a.png");
    const r = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      artifactsRoot: workspace,
      _judge: fakeJudge({ screenshotPath: ssA }),
      _callVision: visionStub(
        JSON.stringify({ per_criterion: [], overall_winner: "tie", summary: "ok" }),
      ),
    });
    const sidecar = path.join(r.artifacts_dir, "compare.json");
    expect(fs.existsSync(sidecar)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    expect(parsed.summary).toBe("ok");
    expect(parsed.schema_version).toBe(RESULT_SCHEMA_VERSION);
  });

  it("AUDIT_COMPARES_DIR env override changes default artifacts root", () => {
    const prev = process.env.AUDIT_COMPARES_DIR;
    try {
      process.env.AUDIT_COMPARES_DIR = "/tmp/compare-test-override";
      expect(defaultCompareArtifactsRoot()).toBe("/tmp/compare-test-override");
    } finally {
      if (prev === undefined) delete process.env.AUDIT_COMPARES_DIR;
      else process.env.AUDIT_COMPARES_DIR = prev;
    }
  });
});

describe("compare — fast mode", () => {
  it("does NOT call _judge for the per-side rubric pass; cost is just the synthesis call", async () => {
    const ssA = path.join(workspace, "a.png");

    let judgeCalls = 0;
    const wrappedJudge = (async (opts: JudgeOptions) => {
      judgeCalls++;
      // Fast mode uses judge as a capture proxy with a no-op vision
      // stub the primitive injects internally; we only care that the
      // capture happens so this stub returns a valid happy-path result.
      return fakeJudge({ url: opts.url, screenshotPath: ssA, cost: 0 })(opts);
    }) as typeof import("../../src/core/primitives/judge.js").judge;

    const synthMock = JSON.stringify({
      per_criterion: [
        { criterion_id: "visual_hierarchy", score_a: 8, score_b: 6, winner: "a", rationale: "Bolder hero on A." },
      ],
      overall_winner: "a",
      summary: "A wins on hero.",
    });

    const r = await compare({
      a: { url: "https://a.example.com" },
      b: { url: "https://b.example.com" },
      mode: "fast",
      artifactsRoot: workspace,
      _judge: wrappedJudge,
      _callVision: visionStub(synthMock, 0.006),
    });
    expect(r.mode).toBe("fast");
    expect(r.status).toBe("ok");
    // Both side captures happened; embedded judge in result is null (we don't surface the proxy)
    expect(r.side_a.judge).toBeNull();
    expect(r.side_b.judge).toBeNull();
    // judge primitive was called twice (for capture)
    expect(judgeCalls).toBe(2);
    // Cost is only the synthesis call (capture proxy uses noop vision = 0)
    expect(r.cost_usd).toBeCloseTo(0.006, 5);
  });
});

// ─────────────────────────────────────────────────────────────
// Real Chromium integration
// ─────────────────────────────────────────────────────────────

describe("compare — integration (real Chromium + fixture site, stubbed vision)", () => {
  let fixture: FixtureServer;
  let intWorkspace: string;
  let warmBrowser: Browser | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    intWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "compare-int-"));
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

  it("compares the same fixture URL twice (A=B), uses real captures end-to-end, returns tie", async () => {
    if (!warmBrowser) return;

    const synthMock = JSON.stringify({
      per_criterion: AESTHETIC_CRITERIA.slice(0, 2).map((c) => ({
        criterion_id: c.id,
        score_a: 7,
        score_b: 7,
        winner: "tie" as const,
        rationale: "Identical pages.",
      })),
      overall_winner: "tie",
      summary: "Both sides identical.",
    });

    const r = await compare({
      a: { url: `${fixture.url}/index.html` },
      b: { url: `${fixture.url}/index.html` },
      rubrics: ["aesthetic"],
      mode: "fast", // cheaper for integration; only 1 stub vision call total
      artifactsRoot: intWorkspace,
      waitFor: "domcontentloaded",
      timeoutMs: 15000,
      _callVision: visionStub(synthMock, 0.005),
    });
    expect(r.status).toBe("ok");
    expect(r.side_a.url_final).toContain("index.html");
    expect(r.side_b.url_final).toContain("index.html");
    expect(r.side_a.title).toBe("AV Fixture — Home");
    expect(r.side_b.title).toBe("AV Fixture — Home");
    expect(r.side_a.screenshot).not.toBeNull();
    expect(r.side_b.screenshot).not.toBeNull();
    expect(fs.statSync(r.side_a.screenshot!.path).size).toBeGreaterThan(100);
    expect(fs.statSync(r.side_b.screenshot!.path).size).toBeGreaterThan(100);
    expect(r.overall_winner).toBe("tie");
    expect(r.per_criterion.every((v) => v.winner === "tie")).toBe(true);
    expect(r.summary).toBe("Both sides identical.");
    expect(fs.existsSync(path.join(r.artifacts_dir, "compare.json"))).toBe(true);
    expect(r.cost_usd).toBeCloseTo(0.005, 5);
  }, 60_000);
});
