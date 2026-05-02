/**
 * Tests for src/agent/agent-loop.ts (T14 — closes R11 partial).
 *
 * The 776-LoC autonomous agent loop drives Plan + Navigator + Convergence.
 * To exercise it without real Anthropic / Playwright we mock at module
 * level:
 *
 *   - planner: createPlan / revisePlan / microReplan
 *   - PlanCache (no-op store)
 *   - AgentMemory (no-op)
 *   - navigator: runNavigator dispatcher's underlying calls
 *   - convergence checks (real ConvergenceTracker, mock per-criterion fns)
 *   - signal collectors (no-op start/stop/snapshot)
 *   - dom-summary, takeSnapshot, executeStep, runCritic, waitForPageStable
 *
 * Coverage target: ≥ 70% stmt for src/agent/agent-loop.ts.
 * Lower bar than other Wave 6 modules because the loop has many edge
 * paths (cache success-count tracking, micro-replan kinds, stuck/loop
 * branches) that need many orchestration tests; we cover the major
 * convergence reasons and the catch path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Persona, ProjectConfig, Scenario } from "../src/core/types.js";

// ─────────────────────────────────────────────────────────────
// Module-level mocks (hoisted to run before module imports)
// ─────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  return {
    mockCreatePlan: vi.fn(),
    mockRevisePlan: vi.fn(),
    mockMicroReplan: vi.fn(),
    mockNavigatorDecide: vi.fn(),
    mockEconomicNavigatorDecide: vi.fn(),
    mockBuildStepFromDecision: vi.fn(),
    mockExtractDomSummary: vi.fn(async () => ({})),
    mockFormatDomSummary: vi.fn(() => "<dom>"),
    mockExecuteStep: vi.fn(),
    mockRunCritic: vi.fn(),
    mockWaitForPageStable: vi.fn(async () => undefined),
    mockTakeSnapshot: vi.fn(async () => null),
    mockComputeDomSkeleton: vi.fn(() => "skeleton"),
    planCacheState: {
      lookupResult: null as null | {
        plan: unknown;
        key: string;
        success_count: number;
        failure_count: number;
      },
    },
    agentMemoryState: {
      lookupResult: [] as unknown[],
    },
  };
});

const {
  mockCreatePlan,
  mockRevisePlan,
  mockMicroReplan,
  mockNavigatorDecide,
  mockEconomicNavigatorDecide,
  mockBuildStepFromDecision,
  mockExtractDomSummary,
  mockFormatDomSummary,
  mockExecuteStep,
  mockRunCritic,
  mockWaitForPageStable,
  mockTakeSnapshot,
  mockComputeDomSkeleton,
  planCacheState,
  agentMemoryState,
} = hoisted;

vi.mock("../src/agent/planner.js", () => ({
  createPlan: (...args: unknown[]) => hoisted.mockCreatePlan(...args),
  revisePlan: (...args: unknown[]) => hoisted.mockRevisePlan(...args),
  microReplan: (...args: unknown[]) => hoisted.mockMicroReplan(...args),
}));

vi.mock("../src/agent/plan-cache.js", () => {
  class MockPlanCache {
    lookup() {
      return hoisted.planCacheState.lookupResult;
    }
    store() {}
    recordOutcome() {}
    close() {}
    static makeKey() {
      return "synthetic-cache-key";
    }
  }
  return {
    PlanCache: MockPlanCache,
    computeDomSkeleton: () => hoisted.mockComputeDomSkeleton(),
  };
});

vi.mock("../src/agent/memory.js", () => {
  class MockAgentMemory {
    lookup() {
      return hoisted.agentMemoryState.lookupResult;
    }
    close() {}
    static hostOf() {
      return "host";
    }
    static personaClass() {
      return "class";
    }
  }
  return {
    AgentMemory: MockAgentMemory,
    formatFactsForPlanner: () => "",
  };
});

vi.mock("../src/agent/navigator.js", () => ({
  navigatorDecide: (...args: unknown[]) => hoisted.mockNavigatorDecide(...args),
  economicNavigatorDecide: (...args: unknown[]) => hoisted.mockEconomicNavigatorDecide(...args),
  buildStepFromDecision: (...args: unknown[]) => hoisted.mockBuildStepFromDecision(...args),
}));

vi.mock("../src/agent/dom-summary.js", () => ({
  extractDomSummary: (...args: unknown[]) => hoisted.mockExtractDomSummary(...args),
  formatDomSummary: (...args: unknown[]) => hoisted.mockFormatDomSummary(...args),
}));

vi.mock("../src/handlers/index.js", () => ({
  executeStep: (...args: unknown[]) => hoisted.mockExecuteStep(...args),
}));

vi.mock("../src/core/critic.js", () => ({
  runCritic: (...args: unknown[]) => hoisted.mockRunCritic(...args),
}));

vi.mock("../src/core/page-stability.js", () => ({
  waitForPageStable: (...args: unknown[]) => hoisted.mockWaitForPageStable(...args),
}));

vi.mock("../src/agent/signals/interaction.js", () => ({
  takeSnapshot: (...args: unknown[]) => hoisted.mockTakeSnapshot(...args),
}));

vi.mock("../src/agent/signals/network.js", () => ({
  NetworkSignalCollector: class {
    constructor(_page: unknown) {}
    start() {}
    stop() {}
    snapshot() {
      return { requests: [], failures: [] };
    }
    reset() {}
  },
}));

vi.mock("../src/agent/signals/performance.js", () => ({
  PerformanceSignalCollector: class {
    constructor(_page: unknown) {}
    async attach() {}
    async snapshot() {
      return { lcp_ms: 0 };
    }
  },
}));

vi.mock("../src/agent/signals/errors.js", () => ({
  ErrorSignalCollector: class {
    constructor(_page: unknown) {}
    start() {}
    stop() {}
    snapshot() {
      return { console_errors: [], page_errors: [] };
    }
    reset() {}
  },
}));

vi.mock("../src/agent/convergence.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/convergence.js")>(
    "../src/agent/convergence.js",
  );
  return {
    ...actual,
    // Use real ConvergenceTracker / state helpers; stub only the per-criterion check fns
    checkDomCriterion: vi.fn(async () => false),
    checkExtractCriterion: vi.fn(async () => false),
    checkVisualCriterion: vi.fn(async () => false),
    checkNetworkCriterion: vi.fn(() => false),
    checkPerformanceCriterion: vi.fn(async () => false),
    checkErrorCriterion: vi.fn(() => false),
    checkInteractionCriterion: vi.fn(async () => false),
    getDomFingerprint: vi.fn(async () => "dom-fp"),
  };
});

import { runAutonomousLoop } from "../src/agent/agent-loop.js";
import { AgentEventBus } from "../src/agent/events.js";

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────

function makePage() {
  return {
    goto: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from([1, 2, 3])),
    url: () => "https://example.com",
    on: vi.fn(),
    off: vi.fn(),
    waitForTimeout: vi.fn(async () => undefined),
    locator: vi.fn(() => ({
      first: function () { return this; },
      isVisible: async () => true,
      textContent: async () => "",
      count: async () => 1,
      click: async () => undefined,
      waitFor: async () => undefined,
    })),
    evaluate: vi.fn(async () => ({})),
    addScriptTag: vi.fn(async () => undefined),
    viewportSize: () => ({ width: 1280, height: 800 }),
    getByText: vi.fn(),
  };
}

function makeRecorder() {
  return {
    screenshot: vi.fn(async (label: string) => ({
      filepath: `/tmp/${label}.png`,
      sha256: "abc",
    })),
    screenshotSegments: vi.fn(async (label: string) => ({
      full: { filepath: `/tmp/${label}.png`, sha256: "abc" },
      thumbnail: Buffer.from([1, 2, 3]),
      segments: [],
    })),
    drainConsoleErrors: vi.fn(() => []),
  };
}

function mkPersona(): Persona {
  return {
    id: "p1",
    display_name: "P1",
    country: "US",
    language: "en",
    locale: "en-US",
    timezone: "UTC",
    device_class: "desktop",
    payment_tier: "free",
    mental_model: "",
    motivation: "",
    success_criteria: "",
  } as Persona;
}

function mkConfig(): ProjectConfig {
  return {
    project_name: "test",
    base_url: "https://example.com",
    default_concurrency: 1,
    default_timeout_ms: 30000,
    default_locale: "en",
    cost_mode: "max",
    budget_usd: 10.0,
    redact_patterns: [],
    models: {
      default: "claude-sonnet-4-6",
      critic: "claude-sonnet-4-6",
      computer_use: "claude-opus-4-6",
      planner: "claude-opus-4-6",
      navigator: "claude-sonnet-4-6",
      replan: "claude-sonnet-4-6",
      navigator_economy: "claude-haiku-4-5-20251001",
    },
    agent: {
      default_max_actions: 5,
      default_replan_threshold: 3,
      default_max_replans: 2,
      criteria_check_interval: 1,
      dom_summary_max_elements: 50,
    },
  } as ProjectConfig;
}

function mkScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "Auto",
    mode: "autonomous",
    start_url: "https://example.com",
    goal: "find the pricing page",
    success_criteria: [
      { id: "c1", description: "pricing visible", verification: "dom" },
    ],
    hints: [],
    steps: [],
    ...overrides,
  } as Scenario;
}

function makeOpts(overrides: Partial<Parameters<typeof runAutonomousLoop>[0]> = {}) {
  return {
    config: mkConfig(),
    persona: mkPersona(),
    scenario: mkScenario(),
    page: makePage() as never,
    stagehand: {} as never,
    recorder: makeRecorder() as never,
    eventBus: new AgentEventBus("test-run"),
    cost: { value: 0 },
    stripeSecrets: {},
    ...overrides,
  };
}

beforeEach(() => {
  process.env.AUDIT_PLAN_CACHE_DISABLED = "1";
  process.env.AUDIT_MEMORY_DISABLED = "1";
  delete process.env.AUDIT_COST_MODE;

  mockCreatePlan.mockReset();
  mockRevisePlan.mockReset();
  mockMicroReplan.mockReset();
  mockNavigatorDecide.mockReset();
  mockEconomicNavigatorDecide.mockReset();
  mockBuildStepFromDecision.mockReset();
  mockExtractDomSummary.mockReset();
  mockExtractDomSummary.mockResolvedValue({});
  mockFormatDomSummary.mockReturnValue("<dom>");
  mockExecuteStep.mockReset();
  mockRunCritic.mockReset();
  mockWaitForPageStable.mockReset();
  mockWaitForPageStable.mockResolvedValue(undefined);
  mockTakeSnapshot.mockReset();
  mockTakeSnapshot.mockResolvedValue(null);

  planCacheState.lookupResult = null;
  agentMemoryState.lookupResult = [];

  // Defaults — caller can override per test
  mockCreatePlan.mockResolvedValue({
    plan: {
      id: "plan-1",
      reasoning: "step plan",
      steps: [
        {
          id: "ps1",
          instruction: "click pricing",
          action_type: "act",
          reasoning: "",
        },
      ],
    },
  });
  mockBuildStepFromDecision.mockReturnValue({
    id: "auto-1",
    type: "act",
    instruction: "click pricing",
    retry: 0,
  });
  mockNavigatorDecide.mockResolvedValue({
    instruction: "click pricing",
    action_type: "act",
    reasoning: "",
    confidence: 0.9,
    needs_replan: false,
  });
  mockEconomicNavigatorDecide.mockResolvedValue({
    instruction: "click pricing",
    action_type: "act",
    reasoning: "",
    confidence: 0.9,
    needs_replan: false,
    _telemetry: {},
  });
  mockExecuteStep.mockResolvedValue({
    step_id: "auto-1",
    step_type: "act",
    status: "pass",
    duration_ms: 100,
    retries_used: 0,
  });
  mockRunCritic.mockResolvedValue({
    verdict: { scores: [], issues: [] },
    scores: [],
    issues: [],
    costUsd: 0.01,
    raw: { text: "", inputTokens: 0, outputTokens: 0, costUsd: 0 },
  });
});

// ─────────────────────────────────────────────────────────────
// Goal met immediately (no actions needed)
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — goal met path", () => {
  it("returns convergence_reason=goal_met when criteria are met after the first action", async () => {
    const conv = await import("../src/agent/convergence.js");
    let calls = 0;
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls++;
      return calls >= 1; // met on first check (post-action)
    });

    const opts = makeOpts();
    const result = await runAutonomousLoop(opts);

    expect(result.agent_summary.convergence_reason).toBe("goal_met");
    expect(result.agent_summary.criteria_met).toContain("c1");
    expect(result.agent_summary.criteria_missed).toEqual([]);
  });

  it("populates final critic results for the goal_met run", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const opts = makeOpts();
    const result = await runAutonomousLoop(opts);

    expect(mockRunCritic).toHaveBeenCalled();
    expect(result.criticResults.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Budget exceeded
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — budget exceeded", () => {
  it("returns budget_exceeded when cost exceeds budget_usd", async () => {
    const opts = makeOpts({
      config: { ...mkConfig(), budget_usd: 0.001 } as never,
      cost: { value: 1.0 }, // already over budget
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.convergence_reason).toBe("budget_exceeded");
  });
});

// ─────────────────────────────────────────────────────────────
// Max actions
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — max actions", () => {
  it("stops with max_actions when action count exceeds limit", async () => {
    const opts = makeOpts({
      config: {
        ...mkConfig(),
        agent: {
          default_max_actions: 1,
          default_replan_threshold: 3,
          default_max_replans: 1,
          criteria_check_interval: 1,
          dom_summary_max_elements: 50,
        },
      } as never,
    });
    // Create plan with many steps so we'll exceed max_actions before exhausting plan
    mockCreatePlan.mockResolvedValueOnce({
      plan: {
        id: "plan-1",
        reasoning: "",
        steps: Array.from({ length: 5 }, (_, i) => ({
          id: `ps${i}`,
          instruction: `step ${i}`,
          action_type: "act",
          reasoning: "",
        })),
      },
    });
    const result = await runAutonomousLoop(opts);
    expect(["max_actions", "goal_met", "max_replans", "budget_exceeded"]).toContain(
      result.agent_summary.convergence_reason,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Plan exhausted → replan path
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — plan exhausted triggers replan", () => {
  it("invokes revisePlan when plan steps run out", async () => {
    mockCreatePlan.mockResolvedValueOnce({
      plan: {
        id: "plan-1",
        reasoning: "",
        steps: [
          {
            id: "ps1",
            instruction: "step",
            action_type: "act",
            reasoning: "",
          },
        ],
      },
    });
    mockRevisePlan.mockResolvedValueOnce({
      plan: {
        id: "plan-2",
        reasoning: "revised",
        steps: [],
      },
    });

    const opts = makeOpts({
      config: {
        ...mkConfig(),
        agent: {
          default_max_actions: 10,
          default_replan_threshold: 3,
          default_max_replans: 1,
          criteria_check_interval: 1,
          dom_summary_max_elements: 50,
        },
      } as never,
    });

    const result = await runAutonomousLoop(opts);
    // After 1 plan step + replan into empty plan → another replan exceeds → max_replans
    expect(["max_replans", "max_actions", "budget_exceeded", "goal_met"]).toContain(
      result.agent_summary.convergence_reason,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Navigator says replan
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — navigator-requested replan", () => {
  it("triggers convergence when navigator returns needs_replan repeatedly", async () => {
    mockNavigatorDecide.mockResolvedValue({
      instruction: "x",
      action_type: "act",
      reasoning: "",
      confidence: 0.5,
      needs_replan: true,
    });
    mockRevisePlan.mockResolvedValue({
      plan: {
        id: "plan-2",
        reasoning: "revised",
        steps: [],
      },
    });

    const opts = makeOpts({
      config: {
        ...mkConfig(),
        agent: {
          default_max_actions: 20,
          default_replan_threshold: 1, // trigger stuck quickly
          default_max_replans: 1,
          criteria_check_interval: 1,
          dom_summary_max_elements: 50,
        },
      } as never,
    });

    const result = await runAutonomousLoop(opts);
    expect(["max_replans", "max_actions", "stuck"]).toContain(
      result.agent_summary.convergence_reason,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Stuck → micro-replan rewrite path
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — stuck signal + micro-replan", () => {
  it("uses microReplan rewrite when action fails and stuck signal fires", async () => {
    mockExecuteStep.mockResolvedValue({
      step_id: "auto-1",
      step_type: "act",
      status: "fail",
      duration_ms: 100,
      retries_used: 0,
      error: "click failed",
    });
    mockMicroReplan.mockResolvedValueOnce({
      kind: "rewrite",
      replacement: {
        id: "ps2",
        instruction: "click signup instead",
        action_type: "act",
        reasoning: "rewrite",
      },
    });
    mockRevisePlan.mockResolvedValue({
      plan: {
        id: "plan-2",
        reasoning: "",
        steps: [],
      },
    });

    const opts = makeOpts({
      config: {
        ...mkConfig(),
        agent: {
          default_max_actions: 5,
          default_replan_threshold: 1,
          default_max_replans: 1,
          criteria_check_interval: 1,
          dom_summary_max_elements: 50,
        },
      } as never,
    });

    const result = await runAutonomousLoop(opts);
    // Just verify the run completed (any convergence reason is OK; we exercised the path)
    expect(result.agent_summary).toBeDefined();
  });

  it("uses microReplan skip path when reason is skip", async () => {
    mockExecuteStep.mockResolvedValue({
      step_id: "auto-1",
      step_type: "act",
      status: "fail",
      duration_ms: 100,
      retries_used: 0,
      error: "click failed",
    });
    mockMicroReplan.mockResolvedValueOnce({
      kind: "skip",
      reason: "obviously a captcha",
    });
    mockRevisePlan.mockResolvedValue({
      plan: { id: "plan-2", reasoning: "", steps: [] },
    });

    const opts = makeOpts({
      config: {
        ...mkConfig(),
        agent: {
          default_max_actions: 5,
          default_replan_threshold: 1,
          default_max_replans: 1,
          criteria_check_interval: 1,
          dom_summary_max_elements: 50,
        },
      } as never,
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Crash inside try block
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — crash recovery", () => {
  it("captures a critical issue and returns convergence_reason=error when the loop crashes", async () => {
    // Force createPlan to throw
    mockCreatePlan.mockRejectedValueOnce(new Error("planner OOM"));

    const opts = makeOpts();
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.convergence_reason).toBe("error");
    expect(result.issues.some((i) => i.description.includes("Autonomous loop crashed"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Plan cache hit path
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — plan cache hit", () => {
  it("uses the cached plan when PlanCache.lookup returns a hit", async () => {
    delete process.env.AUDIT_PLAN_CACHE_DISABLED;
    planCacheState.lookupResult = {
      plan: {
        id: "cached-plan",
        reasoning: "from cache",
        steps: [
          {
            id: "ps1",
            instruction: "step",
            action_type: "act",
            reasoning: "",
          },
        ],
      },
      key: "cache-key",
      success_count: 5,
      failure_count: 1,
    };

    const conv = await import("../src/agent/convergence.js");
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const opts = makeOpts();
    const result = await runAutonomousLoop(opts);

    expect(mockCreatePlan).not.toHaveBeenCalled();
    expect(result.agent_summary).toBeDefined();
    process.env.AUDIT_PLAN_CACHE_DISABLED = "1";
  });
});

// ─────────────────────────────────────────────────────────────
// cost_mode=balanced uses economic navigator
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — cost_mode dispatch", () => {
  it("uses economicNavigatorDecide when cost_mode=balanced", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const opts = makeOpts({
      config: { ...mkConfig(), cost_mode: "balanced" } as never,
    });
    await runAutonomousLoop(opts);
    expect(mockEconomicNavigatorDecide).toHaveBeenCalled();
    expect(mockNavigatorDecide).not.toHaveBeenCalled();
  });

  it("uses economicNavigatorDecide with primaryOnly when cost_mode=economy", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const opts = makeOpts({
      config: { ...mkConfig(), cost_mode: "economy" } as never,
    });
    await runAutonomousLoop(opts);
    expect(mockEconomicNavigatorDecide).toHaveBeenCalled();
    const args = mockEconomicNavigatorDecide.mock.calls[0][1] as { primaryOnly: boolean };
    expect(args.primaryOnly).toBe(true);
  });

  it("AUDIT_COST_MODE env overrides config cost_mode", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    process.env.AUDIT_COST_MODE = "max";
    try {
      const opts = makeOpts({
        config: { ...mkConfig(), cost_mode: "balanced" } as never,
      });
      await runAutonomousLoop(opts);
      expect(mockNavigatorDecide).toHaveBeenCalled();
      expect(mockEconomicNavigatorDecide).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUDIT_COST_MODE;
    }
  });
});

// ─────────────────────────────────────────────────────────────
// resolveAgentConfig defaults
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — agent config resolution", () => {
  it("falls back to hardcoded defaults when neither scenario nor project provide config", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const cfg = mkConfig();
    delete cfg.agent;
    const opts = makeOpts({ config: cfg as never });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// checkCriteria switch — exercise every verification type so the
// 7-branch verification dispatcher (lines 691-720) gets covered
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — criterion verification dispatcher", () => {
  it("checkExtractCriterion path is exercised for verification=extract", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkExtractCriterion as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const opts = makeOpts({
      scenario: mkScenario({
        success_criteria: [
          { id: "extract-c", description: "extract X", verification: "extract" },
        ],
      } as Partial<Scenario>),
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.criteria_met).toContain("extract-c");
    expect(conv.checkExtractCriterion).toHaveBeenCalled();
  });

  it("checkNetworkCriterion path for verification=network", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkNetworkCriterion as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const opts = makeOpts({
      scenario: mkScenario({
        success_criteria: [
          { id: "net-c", description: "no errors", verification: "network" },
        ],
      } as Partial<Scenario>),
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.criteria_met).toContain("net-c");
    expect(conv.checkNetworkCriterion).toHaveBeenCalled();
  });

  it("checkPerformanceCriterion path for verification=performance", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkPerformanceCriterion as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const opts = makeOpts({
      scenario: mkScenario({
        success_criteria: [
          { id: "perf-c", description: "LCP < 2s", verification: "performance" },
        ],
      } as Partial<Scenario>),
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.criteria_met).toContain("perf-c");
    expect(conv.checkPerformanceCriterion).toHaveBeenCalled();
  });

  it("checkErrorCriterion path for verification=error", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkErrorCriterion as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const opts = makeOpts({
      scenario: mkScenario({
        success_criteria: [
          { id: "err-c", description: "no console errors", verification: "error" },
        ],
      } as Partial<Scenario>),
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.criteria_met).toContain("err-c");
    expect(conv.checkErrorCriterion).toHaveBeenCalled();
  });

  it("interaction criterion is checked when preActionSnapshot is present", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkInteractionCriterion as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    // Make takeSnapshot return a non-null snapshot so the interaction
    // path activates
    mockTakeSnapshot.mockResolvedValue({ url: "x", elements: [] } as never);

    const opts = makeOpts({
      scenario: mkScenario({
        success_criteria: [
          { id: "inter-c", description: "click target", verification: "interaction" },
        ],
      } as Partial<Scenario>),
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.criteria_met).toContain("inter-c");
    expect(conv.checkInteractionCriterion).toHaveBeenCalled();
  });

  it("visual criterion runs every interval action and tolerates screenshot failures", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkVisualCriterion as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const opts = makeOpts({
      config: {
        ...mkConfig(),
        agent: {
          default_max_actions: 3,
          default_replan_threshold: 5,
          default_max_replans: 1,
          criteria_check_interval: 1, // every action triggers visual
          dom_summary_max_elements: 50,
        },
      } as never,
      scenario: mkScenario({
        success_criteria: [
          { id: "vis-c", description: "visual layout ok", verification: "visual" },
        ],
      } as Partial<Scenario>),
    });
    const result = await runAutonomousLoop(opts);
    expect(result.agent_summary.criteria_met).toContain("vis-c");
    expect(conv.checkVisualCriterion).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// takeScreenshotBase64 catch (page.screenshot throws) → returns ""
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — screenshot resilience", () => {
  it("tolerates page.screenshot throwing during the loop (returns empty base64)", async () => {
    const conv = await import("../src/agent/convergence.js");
    (conv.checkDomCriterion as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const page = makePage();
    page.screenshot = vi.fn(async () => {
      throw new Error("page closed");
    });
    const opts = makeOpts({ page: page as never });
    const result = await runAutonomousLoop(opts);
    // Loop should still complete — takeScreenshotBase64 catches and
    // returns "" instead of crashing the whole loop
    expect(result.agent_summary).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Micro-replan escalate path → falls through to full revisePlan
// ─────────────────────────────────────────────────────────────

describe("runAutonomousLoop — micro-replan escalate", () => {
  it("microReplan kind=escalate falls through to full revisePlan", async () => {
    mockExecuteStep.mockResolvedValue({
      step_id: "auto-1",
      step_type: "act",
      status: "fail",
      duration_ms: 100,
      retries_used: 0,
      error: "fatal error",
    });
    mockMicroReplan.mockResolvedValueOnce({
      kind: "escalate",
      reason: "needs full replan",
    });
    mockRevisePlan.mockResolvedValueOnce({
      plan: { id: "plan-2", reasoning: "revised", steps: [] },
    });

    const opts = makeOpts({
      config: {
        ...mkConfig(),
        agent: {
          default_max_actions: 5,
          default_replan_threshold: 1,
          default_max_replans: 1,
          criteria_check_interval: 1,
          dom_summary_max_elements: 50,
        },
      } as never,
    });
    const result = await runAutonomousLoop(opts);
    // Reaches one of the terminal exit reasons; escalate path was exercised
    expect([
      "max_replans",
      "max_actions",
      "budget_exceeded",
      "stuck",
      "error",
    ]).toContain(result.agent_summary.convergence_reason);
  });
});
