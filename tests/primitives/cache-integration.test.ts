/**
 * Result-cache integration tests (M9-4).
 *
 * Verify that the cache wrapping in see / extract / judge primitives
 * actually round-trips: first call computes, second call hits cache,
 * cost_usd is zeroed, cost_saved_usd populates, cacheBust forces
 * recompute, cache=false bypasses entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _resetCacheForTests } from "../../src/core/result-cache.js";
import { see } from "../../src/core/primitives/see.js";
import { extract } from "../../src/core/primitives/extract.js";
import { judge } from "../../src/core/primitives/judge.js";

// Re-enable the cache: the global setup disables it; integration here
// flips it back on with a temp DB path so we don't pollute the user's
// real cache.
function enableCacheWithTmpDb(): { dbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-int-"));
  const dbPath = path.join(tmpDir, "cache.db");
  const prevDisabled = process.env.AUDIT_RESULT_CACHE_DISABLED;
  const prevPath = process.env.AUDIT_RESULT_CACHE_PATH;
  delete process.env.AUDIT_RESULT_CACHE_DISABLED;
  process.env.AUDIT_RESULT_CACHE_PATH = dbPath;
  _resetCacheForTests();
  return {
    dbPath,
    cleanup: () => {
      _resetCacheForTests();
      if (prevDisabled === undefined) delete process.env.AUDIT_RESULT_CACHE_DISABLED;
      else process.env.AUDIT_RESULT_CACHE_DISABLED = prevDisabled;
      if (prevPath === undefined) delete process.env.AUDIT_RESULT_CACHE_PATH;
      else process.env.AUDIT_RESULT_CACHE_PATH = prevPath;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

const FIXTURE_BUFFER = Buffer.from(
  // 1x1 transparent PNG
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

// ─────────────────────────────────────────────────────────────
// see — caches when goal is set
// ─────────────────────────────────────────────────────────────

describe("see — cache integration (M9-4)", () => {
  let env: ReturnType<typeof enableCacheWithTmpDb>;
  let artifactsRoot: string;
  beforeEach(() => {
    env = enableCacheWithTmpDb();
    artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "see-art-"));
  });
  afterEach(() => {
    env.cleanup();
    try {
      fs.rmSync(artifactsRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function fakeOpen(): Parameters<typeof see>[0]["_open"] {
    return async () => ({
      page: {
        url: () => "https://fixture.example/",
        title: async () => "Fixture",
        screenshot: async () => FIXTURE_BUFFER,
        evaluate: async () => [] as string[],
      } as any,
      consoleErrors: [],
      close: async () => {},
    });
  }

  function fakeVision(label: string): Parameters<typeof see>[0]["_callVision"] {
    let n = 0;
    return async () => {
      n++;
      return {
        text: `${label} #${n}`,
        costUsd: 0.0042,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 5,
      } as any;
    };
  }

  it("caches when goal is set: second call is a hit, cost zeroed, cost_saved_usd populated", async () => {
    const visionImpl = fakeVision("note");
    const opts = {
      url: "https://fixture.example/",
      goal: "What is the headline?",
      includeDom: false,
      includeConsole: false,
      artifactsRoot,
      _open: fakeOpen(),
      _callVision: visionImpl,
    };
    const first = await see(opts);
    expect(first.cache).toBeDefined();
    expect(first.cache!.hit).toBe(false);
    expect(first.cost_usd).toBeCloseTo(0.0042, 6);

    const second = await see(opts);
    expect(second.cache!.hit).toBe(true);
    expect(second.cache!.cost_saved_usd).toBeCloseTo(0.0042, 6);
    expect(second.cost_usd).toBe(0);
    expect(second.note).toBe(first.note); // returned from cache verbatim
  });

  it("does NOT cache when goal is absent (no LLM call → cache not applicable)", async () => {
    const opts = {
      url: "https://fixture.example/",
      includeDom: false,
      includeConsole: false,
      artifactsRoot,
      _open: fakeOpen(),
    };
    const r = await see(opts);
    expect(r.cache).toBeUndefined();
  });

  it("cache=false bypasses cache entirely", async () => {
    let visionCalls = 0;
    const vision: Parameters<typeof see>[0]["_callVision"] = async () => {
      visionCalls++;
      return {
        text: `n${visionCalls}`,
        costUsd: 0.0042,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 1,
        outputTokens: 1,
      } as any;
    };
    const opts = {
      url: "https://fixture.example/",
      goal: "test",
      includeDom: false,
      includeConsole: false,
      artifactsRoot,
      _open: fakeOpen(),
      _callVision: vision,
      cache: false,
    };
    const r1 = await see(opts);
    const r2 = await see(opts);
    expect(visionCalls).toBe(2);
    expect(r1.cache).toBeUndefined();
    expect(r2.cache).toBeUndefined();
  });

  it("cacheBust forces recompute on the second call", async () => {
    let visionCalls = 0;
    const vision: Parameters<typeof see>[0]["_callVision"] = async () => {
      visionCalls++;
      return {
        text: `n${visionCalls}`,
        costUsd: 0.0042,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 1,
        outputTokens: 1,
      } as any;
    };
    const opts = {
      url: "https://fixture.example/",
      goal: "test",
      includeDom: false,
      includeConsole: false,
      artifactsRoot,
      _open: fakeOpen(),
      _callVision: vision,
    };
    const r1 = await see(opts);
    const r2 = await see({ ...opts, cacheBust: true });
    expect(visionCalls).toBe(2);
    expect(r1.cache!.hit).toBe(false);
    expect(r2.cache!.hit).toBe(false);
    expect(r2.note).toBe("n2");
  });

  it("different goals produce different cache keys (no collision)", async () => {
    let visionCalls = 0;
    const vision: Parameters<typeof see>[0]["_callVision"] = async () => {
      visionCalls++;
      return {
        text: `n${visionCalls}`,
        costUsd: 0.0042,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 1,
        outputTokens: 1,
      } as any;
    };
    const base = {
      url: "https://fixture.example/",
      includeDom: false,
      includeConsole: false,
      artifactsRoot,
      _open: fakeOpen(),
      _callVision: vision,
    };
    const a = await see({ ...base, goal: "What is the headline?" });
    const b = await see({ ...base, goal: "What is the CTA?" });
    expect(visionCalls).toBe(2);
    expect(a.cache!.hit).toBe(false);
    expect(b.cache!.hit).toBe(false);
    expect(a.cache!.key).not.toBe(b.cache!.key);
  });
});

// ─────────────────────────────────────────────────────────────
// extract — caches every call
// ─────────────────────────────────────────────────────────────

describe("extract — cache integration (M9-4)", () => {
  let env: ReturnType<typeof enableCacheWithTmpDb>;
  let artifactsRoot: string;
  beforeEach(() => {
    env = enableCacheWithTmpDb();
    artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extract-art-"));
  });
  afterEach(() => {
    env.cleanup();
    try {
      fs.rmSync(artifactsRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function fakeOpenStagehand(): Parameters<typeof extract>[0]["_openStagehand"] {
    return async () => ({
      page: {
        url: () => "https://fixture.example/",
        title: async () => "Fixture",
        screenshot: async () => FIXTURE_BUFFER,
        evaluate: async () => [] as string[],
      } as any,
      context: null,
      consoleErrors: [],
      extract: async () => ({ name: "Acme", price: 9.99 }),
      readMetrics: () => ({ extractPromptTokens: 0, extractCompletionTokens: 0 }),
      close: async () => {},
    });
  }

  it("caches identical extract calls; second is a hit with cost_usd=0", async () => {
    let calls = 0;
    const opts = {
      url: "https://fixture.example/",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "number" },
        },
        required: ["name"],
      },
      includeDom: false,
      includeConsole: false,
      artifactsRoot,
      _openStagehand: fakeOpenStagehand(),
      _callExtract: async () => {
        calls++;
        return { name: `Acme${calls}`, price: 9.99 };
      },
    };
    const first = await extract(opts);
    expect(first.cache!.hit).toBe(false);
    const second = await extract(opts);
    expect(calls).toBe(1);
    expect(second.cache!.hit).toBe(true);
    expect(second.cost_usd).toBe(0);
    expect((second.data as { name: string }).name).toBe("Acme1");
  });

  it("different schemas produce different cache keys", async () => {
    let calls = 0;
    const base = {
      url: "https://fixture.example/",
      includeDom: false,
      includeConsole: false,
      artifactsRoot,
      _openStagehand: fakeOpenStagehand(),
      _callExtract: async () => {
        calls++;
        return { v: calls };
      },
    };
    const a = await extract({
      ...base,
      schema: { type: "object", properties: { name: { type: "string" } } },
    });
    const b = await extract({
      ...base,
      schema: { type: "object", properties: { price: { type: "number" } } },
    });
    expect(calls).toBe(2);
    expect(a.cache!.key).not.toBe(b.cache!.key);
  });
});

// ─────────────────────────────────────────────────────────────
// judge — caches every call
// ─────────────────────────────────────────────────────────────

describe("judge — cache integration (M9-4)", () => {
  let env: ReturnType<typeof enableCacheWithTmpDb>;
  let artifactsRoot: string;
  beforeEach(() => {
    env = enableCacheWithTmpDb();
    artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "judge-art-"));
  });
  afterEach(() => {
    env.cleanup();
    try {
      fs.rmSync(artifactsRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function fakeSee(): Parameters<typeof judge>[0]["_see"] {
    return (async () => ({
      schema_version: "1.1.0",
      url_input: "https://fixture.example/",
      url_final: "https://fixture.example/",
      title: "Fixture",
      loaded_at: new Date().toISOString(),
      status: "ok" as const,
      dom: null,
      console: null,
      screenshot: {
        path: (() => {
          const p = path.join(artifactsRoot, "fixture.png");
          fs.writeFileSync(p, FIXTURE_BUFFER);
          return p;
        })(),
        sha256: "deadbeef",
        bytes: FIXTURE_BUFFER.length,
        width: 1,
        height: 1,
      },
      note: null,
      persona_id: "judge-default-desktop",
      artifacts_dir: artifactsRoot,
      cost_usd: 0,
      duration_ms: 1,
    })) as any;
  }

  function fakeVisionVerdict(): Parameters<typeof judge>[0]["_callVision"] {
    let n = 0;
    return async () => {
      n++;
      const verdicts = [
        {
          criterion_id: "visual_hierarchy",
          score: 7,
          rationale: `r${n}`,
          evidence: [],
        },
      ];
      return {
        text: JSON.stringify({ verdicts, findings: [], summary: null }),
        costUsd: 0.0123,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
      } as any;
    };
  }

  it("caches identical judge calls; second is a hit with cost_usd=0", async () => {
    const visionImpl = fakeVisionVerdict();
    const opts = {
      url: "https://fixture.example/",
      rubrics: ["aesthetic" as const],
      _see: fakeSee(),
      _callVision: visionImpl,
    };
    const first = await judge(opts);
    expect(first.cache!.hit).toBe(false);
    expect(first.cost_usd).toBeCloseTo(0.0123, 6);

    const second = await judge(opts);
    expect(second.cache!.hit).toBe(true);
    expect(second.cost_usd).toBe(0);
    expect(second.cache!.cost_saved_usd).toBeCloseTo(0.0123, 6);
  });

  it("different rubrics produce different cache keys", async () => {
    const opts = {
      url: "https://fixture.example/",
      _see: fakeSee(),
      _callVision: fakeVisionVerdict(),
    };
    const a = await judge({ ...opts, rubrics: ["aesthetic" as const] });
    const b = await judge({
      ...opts,
      rubrics: ["aesthetic" as const],
      customCriteria: [
        { id: "x", label: "X", description: "Test custom criterion." },
      ],
    });
    expect(a.cache!.hit).toBe(false);
    expect(b.cache!.hit).toBe(false);
    expect(a.cache!.key).not.toBe(b.cache!.key);
  });
});
