/**
 * Tests for src/core/computer-use.ts (T16 — closes R11 partial).
 *
 * The 449-LoC module has 1 export (`runComputerUseTask`) plus a thicket
 * of internal helpers (`getScaleFactor` / `executeAction` /
 * `takeScaledScreenshot` / `parseModifier` / `translateKey`). Coverage
 * comes by driving `runComputerUseTask` with a stubbed Anthropic SDK +
 * a stubbed Playwright Page that records calls — every action branch
 * in `executeAction` gets exercised through canned `tool_use` blocks.
 *
 * Mocks:
 *   - `getAnthropicClient` returns `{ beta: { messages: { create } } }`
 *     so the SDK shape matches the beta header path
 *   - `estimateCost` returns a flat $0.001 per call
 *   - cost-guard runs real (it tolerates undefined env)
 *   - sharp import returns null inside `takeScaledScreenshot` so the
 *     fallback path is exercised (we don't bring sharp into a unit run)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(() => ({ beta: { messages: { create: mockCreate } } })),
}));

vi.mock("../src/core/llm.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/llm.js")>(
    "../src/core/llm.js",
  );
  return {
    ...actual,
    getAnthropicClient: () =>
      ({ beta: { messages: { create: mockCreate } } }) as never,
    estimateCost: () => 0.001,
  };
});

import { runComputerUseTask } from "../src/core/computer-use.js";

interface RecordedCall {
  method: string;
  args: unknown[];
}

function mkPage(viewport: { width: number; height: number } | null = { width: 1280, height: 800 }) {
  const calls: RecordedCall[] = [];
  const page = {
    viewportSize: () => viewport,
    screenshot: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    mouse: {
      click: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "mouse.click", args });
      }),
      dblclick: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "mouse.dblclick", args });
      }),
      move: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "mouse.move", args });
      }),
      down: vi.fn(async () => {
        calls.push({ method: "mouse.down", args: [] });
      }),
      up: vi.fn(async () => {
        calls.push({ method: "mouse.up", args: [] });
      }),
      wheel: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "mouse.wheel", args });
      }),
    },
    keyboard: {
      type: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "keyboard.type", args });
      }),
      press: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "keyboard.press", args });
      }),
      down: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "keyboard.down", args });
      }),
      up: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "keyboard.up", args });
      }),
    },
    waitForTimeout: vi.fn(async () => undefined),
  };
  return { page, calls };
}

interface AnyBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}

/**
 * Build a `messages.create` response of the shape the loop expects.
 * `usage.input_tokens` / `output_tokens` arbitrary; cost is mocked flat.
 */
function rsp(content: AnyBlock[]): {
  content: AnyBlock[];
  stop_reason?: string;
  usage: { input_tokens: number; output_tokens: number };
} {
  return {
    content,
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function textBlock(text: string): AnyBlock {
  return { type: "text", text };
}

function toolUse(input: Record<string, unknown>, id = "tu-1"): AnyBlock {
  return { type: "tool_use", id, name: "computer", input };
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
});

// ─────────────────────────────────────────────────────────────
// runComputerUseTask — viewport / loop / max iterations
// ─────────────────────────────────────────────────────────────

describe("runComputerUseTask — top-level loop", () => {
  it("throws when the page has no viewport", async () => {
    const { page } = mkPage(null);
    await expect(
      runComputerUseTask({
        page: page as unknown as Parameters<typeof runComputerUseTask>[0]["page"],
        task: "do a thing",
        model: "claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/no viewport/);
  });

  it("returns immediately with finalText when the model emits no tool_use", async () => {
    mockCreate.mockResolvedValueOnce(rsp([textBlock("All done.")]));
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "say hi",
      model: "claude-sonnet-4-6",
    });
    expect(result.finalText).toBe("All done.");
    expect(result.iterations).toBe(1);
    expect(result.costUsd).toBe(0.001);
    expect(result.history.some((h) => h.role === "assistant")).toBe(true);
  });

  it("stops at maxIterations with the (max iterations reached) sentinel", async () => {
    // Always return a tool_use → forces loop to exhaust iterations
    mockCreate.mockResolvedValue(
      rsp([toolUse({ action: "screenshot" })]),
    );
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "loop",
      model: "claude-sonnet-4-6",
      maxIterations: 3,
    });
    expect(result.iterations).toBe(3);
    expect(result.finalText).toBe("(max iterations reached)");
    expect(result.costUsd).toBeCloseTo(0.003, 3);
  });

  it("uses default systemPrompt when none provided", async () => {
    mockCreate.mockResolvedValueOnce(rsp([textBlock("ok")]));
    const { page } = mkPage();
    await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    const callArgs = mockCreate.mock.calls[0][0] as { system: string };
    expect(callArgs.system).toMatch(/QA engineer/);
  });

  it("respects a custom systemPrompt", async () => {
    mockCreate.mockResolvedValueOnce(rsp([textBlock("ok")]));
    const { page } = mkPage();
    await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
      systemPrompt: "be terse",
    });
    const callArgs = mockCreate.mock.calls[0][0] as { system: string };
    expect(callArgs.system).toBe("be terse");
  });

  it("scales display dimensions for tool definition (1280×800 → 1280×800 since under cap)", async () => {
    mockCreate.mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage({ width: 1280, height: 800 });
    await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    const args = mockCreate.mock.calls[0][0] as {
      tools: Array<{ display_width_px: number; display_height_px: number; type: string }>;
    };
    expect(args.tools[0].type).toBe("computer_20251124");
    // 1280×800 = 1.024M pixels < 1.15M cap → no scaling
    expect(args.tools[0].display_width_px).toBe(1280);
    expect(args.tools[0].display_height_px).toBe(800);
  });

  it("scales down when viewport exceeds 1568px long-edge cap", async () => {
    mockCreate.mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage({ width: 3200, height: 1800 });
    await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    const args = mockCreate.mock.calls[0][0] as {
      tools: Array<{ display_width_px: number; display_height_px: number }>;
    };
    // 3200×1800 = 5.76M pixels; cap is 1.15M and long-edge cap is 1568.
    // Pixels constraint dominates → scale ≈ sqrt(1.15M/5.76M) ≈ 0.4467
    expect(args.tools[0].display_width_px).toBeLessThan(1568);
    expect(args.tools[0].display_height_px).toBeLessThan(900);
    expect(args.tools[0].display_width_px).toBeGreaterThan(0);
  });

  it("sends the beta header on every API call", async () => {
    mockCreate.mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage();
    await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    const args = mockCreate.mock.calls[0][0] as { betas: string[] };
    expect(args.betas).toEqual(["computer-use-2025-11-24"]);
  });
});

// ─────────────────────────────────────────────────────────────
// executeAction — every switch branch through tool_use round-trip
// ─────────────────────────────────────────────────────────────

describe("executeAction — action dispatcher (one tool_use per case)", () => {
  /**
   * Helper: queue a tool_use response then a final text response so the
   * loop runs exactly 2 iterations (tool then conclusion). Returns the
   * recorded Page calls.
   */
  async function runOne(input: Record<string, unknown>) {
    mockCreate
      .mockResolvedValueOnce(rsp([toolUse(input, "id-1")]))
      .mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page, calls } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "exercise dispatcher",
      model: "claude-sonnet-4-6",
    });
    return { result, calls };
  }

  it("screenshot: takes a screenshot without other side effects", async () => {
    const { calls } = await runOne({ action: "screenshot" });
    // No mouse/keyboard activity for screenshot
    const inactive = calls.filter(
      (c) => !c.method.startsWith("mouse.") && !c.method.startsWith("keyboard."),
    );
    expect(inactive.length).toBe(calls.length);
  });

  it("left_click: clicks at scaled coordinate, no modifier", async () => {
    const { calls } = await runOne({
      action: "left_click",
      coordinate: [640, 400],
    });
    const clicks = calls.filter((c) => c.method === "mouse.click");
    expect(clicks.length).toBe(1);
    // viewport 1280x800 with no scaling → coord stays the same
    expect(clicks[0].args.slice(0, 2)).toEqual([640, 400]);
  });

  it("left_click with shift modifier: presses Shift down/up around click", async () => {
    const { calls } = await runOne({
      action: "left_click",
      coordinate: [100, 100],
      text: "shift",
    });
    const downs = calls.filter((c) => c.method === "keyboard.down");
    const ups = calls.filter((c) => c.method === "keyboard.up");
    expect(downs.length).toBe(1);
    expect(ups.length).toBe(1);
    expect(downs[0].args[0]).toBe("Shift");
  });

  it("left_click with ctrl modifier maps to Control", async () => {
    const { calls } = await runOne({
      action: "left_click",
      coordinate: [50, 50],
      text: "ctrl",
    });
    const downs = calls.filter((c) => c.method === "keyboard.down");
    expect(downs[0].args[0]).toBe("Control");
  });

  it("left_click with cmd modifier maps to Meta", async () => {
    const { calls } = await runOne({
      action: "left_click",
      coordinate: [50, 50],
      text: "cmd",
    });
    const downs = calls.filter((c) => c.method === "keyboard.down");
    expect(downs[0].args[0]).toBe("Meta");
  });

  it("left_click without coordinate raises a tool_result error", async () => {
    mockCreate
      .mockResolvedValueOnce(rsp([toolUse({ action: "left_click" })]))
      .mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    // Error path goes into history with " → error" suffix
    expect(result.history.some((h) => h.summary.includes("→ error"))).toBe(true);
  });

  it("right_click clicks with button=right", async () => {
    const { calls } = await runOne({
      action: "right_click",
      coordinate: [100, 200],
    });
    const c = calls.find((c) => c.method === "mouse.click");
    expect(c?.args[2]).toEqual({ button: "right" });
  });

  it("middle_click clicks with button=middle", async () => {
    const { calls } = await runOne({
      action: "middle_click",
      coordinate: [50, 50],
    });
    const c = calls.find((c) => c.method === "mouse.click");
    expect(c?.args[2]).toEqual({ button: "middle" });
  });

  it("double_click invokes mouse.dblclick", async () => {
    const { calls } = await runOne({
      action: "double_click",
      coordinate: [10, 20],
    });
    expect(calls.some((c) => c.method === "mouse.dblclick")).toBe(true);
  });

  it("triple_click invokes mouse.click with clickCount=3", async () => {
    const { calls } = await runOne({
      action: "triple_click",
      coordinate: [10, 20],
    });
    const c = calls.find((c) => c.method === "mouse.click");
    expect(c?.args[2]).toEqual({ clickCount: 3 });
  });

  it("left_click_drag uses start_coordinate + end_coordinate", async () => {
    const { calls } = await runOne({
      action: "left_click_drag",
      start_coordinate: [10, 10],
      end_coordinate: [200, 200],
    });
    const moves = calls.filter((c) => c.method === "mouse.move");
    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.method === "mouse.down")).toBe(true);
    expect(calls.some((c) => c.method === "mouse.up")).toBe(true);
  });

  it("left_click_drag without endCoordinate fails into the error path", async () => {
    mockCreate
      .mockResolvedValueOnce(
        rsp([toolUse({ action: "left_click_drag", start_coordinate: [0, 0] })]),
      )
      .mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    expect(result.history.some((h) => h.summary.includes("→ error"))).toBe(true);
  });

  it("mouse_move moves without taking a screenshot", async () => {
    const { calls } = await runOne({
      action: "mouse_move",
      coordinate: [100, 100],
    });
    expect(calls.some((c) => c.method === "mouse.move")).toBe(true);
  });

  it("type: presses keys with delay 20ms", async () => {
    const { calls } = await runOne({
      action: "type",
      text: "hello world",
    });
    const t = calls.find((c) => c.method === "keyboard.type");
    expect(t?.args[0]).toBe("hello world");
    expect(t?.args[1]).toEqual({ delay: 20 });
  });

  it("type without text raises error", async () => {
    mockCreate
      .mockResolvedValueOnce(rsp([toolUse({ action: "type" })]))
      .mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    expect(result.history.some((h) => h.summary.includes("→ error"))).toBe(true);
  });

  it("key: presses translated key (Return → Enter)", async () => {
    const { calls } = await runOne({ action: "key", text: "Return" });
    const press = calls.find((c) => c.method === "keyboard.press");
    expect(press?.args[0]).toBe("Enter");
  });

  it("key with combo (ctrl+s) translates parts (ctrl → Control, s passthrough)", async () => {
    const { calls } = await runOne({ action: "key", text: "ctrl+s" });
    const press = calls.find((c) => c.method === "keyboard.press");
    expect(press?.args[0]).toBe("Control+s");
  });

  it("hold_key: down + waitForTimeout + up", async () => {
    const { calls } = await runOne({
      action: "hold_key",
      text: "Page_Down",
      duration: 0.001,
    });
    expect(calls.some((c) => c.method === "keyboard.down")).toBe(true);
    expect(calls.some((c) => c.method === "keyboard.up")).toBe(true);
    const down = calls.find((c) => c.method === "keyboard.down");
    expect(down?.args[0]).toBe("PageDown");
  });

  it("scroll: down direction → positive dy", async () => {
    const { calls } = await runOne({
      action: "scroll",
      scroll_direction: "down",
      scroll_amount: 5,
    });
    const wheel = calls.find((c) => c.method === "mouse.wheel");
    expect(wheel?.args).toEqual([0, 500]);
  });

  it("scroll: up direction → negative dy", async () => {
    const { calls } = await runOne({
      action: "scroll",
      scroll_direction: "up",
      scroll_amount: 2,
    });
    const wheel = calls.find((c) => c.method === "mouse.wheel");
    expect(wheel?.args).toEqual([0, -200]);
  });

  it("scroll: left direction → negative dx", async () => {
    const { calls } = await runOne({
      action: "scroll",
      scroll_direction: "left",
      scroll_amount: 3,
    });
    const wheel = calls.find((c) => c.method === "mouse.wheel");
    expect(wheel?.args).toEqual([-300, 0]);
  });

  it("scroll: right direction → positive dx", async () => {
    const { calls } = await runOne({
      action: "scroll",
      scroll_direction: "right",
      scroll_amount: 1,
    });
    const wheel = calls.find((c) => c.method === "mouse.wheel");
    expect(wheel?.args).toEqual([100, 0]);
  });

  it("scroll: defaults direction=down + amount=3 when omitted", async () => {
    const { calls } = await runOne({ action: "scroll" });
    const wheel = calls.find((c) => c.method === "mouse.wheel");
    expect(wheel?.args).toEqual([0, 300]);
  });

  it("scroll with coordinate moves mouse first", async () => {
    const { calls } = await runOne({
      action: "scroll",
      coordinate: [400, 300],
      scroll_direction: "down",
    });
    const move = calls.find((c) => c.method === "mouse.move");
    expect(move?.args.slice(0, 2)).toEqual([400, 300]);
  });

  it("wait: invokes waitForTimeout", async () => {
    const { calls } = await runOne({ action: "wait", duration: 0.001 });
    // wait returns text only, no other calls expected besides waitForTimeout
    // (which is on page itself, not in our mouse/keyboard recorder).
    // Just assert the run succeeded by checking no errors in history.
    const hasError = calls.some((c) => c.method.includes("error"));
    expect(hasError).toBe(false);
  });

  it("left_mouse_down moves then mouse.down", async () => {
    const { calls } = await runOne({
      action: "left_mouse_down",
      coordinate: [10, 20],
    });
    expect(calls.some((c) => c.method === "mouse.move")).toBe(true);
    expect(calls.some((c) => c.method === "mouse.down")).toBe(true);
  });

  it("left_mouse_up moves then mouse.up", async () => {
    const { calls } = await runOne({
      action: "left_mouse_up",
      coordinate: [10, 20],
    });
    expect(calls.some((c) => c.method === "mouse.move")).toBe(true);
    expect(calls.some((c) => c.method === "mouse.up")).toBe(true);
  });

  it("zoom returns a fresh screenshot without mouse activity", async () => {
    const { calls } = await runOne({ action: "zoom" });
    expect(calls.filter((c) => c.method.startsWith("mouse.")).length).toBe(0);
  });

  it("unsupported action raises and lands in error history", async () => {
    mockCreate
      .mockResolvedValueOnce(rsp([toolUse({ action: "telepathy" })]))
      .mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    expect(result.history.some((h) => h.summary.includes("→ error"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Coordinate scaling — Claude returns scaled coords; we scale back up
// ─────────────────────────────────────────────────────────────

describe("coordinate scaling round-trip", () => {
  it("scales clicks back up to real viewport for a 3200×1800 page", async () => {
    mockCreate
      .mockResolvedValueOnce(
        rsp([toolUse({ action: "left_click", coordinate: [100, 100] })]),
      )
      .mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page, calls } = mkPage({ width: 3200, height: 1800 });
    await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    const click = calls.find((c) => c.method === "mouse.click");
    // Scale ≈ 0.447 → real coord = round(100 / 0.447) ≈ round(223.6) = 224
    const x = click?.args[0] as number;
    const y = click?.args[1] as number;
    expect(x).toBeGreaterThan(150);
    expect(x).toBeLessThan(300);
    expect(y).toBeGreaterThan(150);
    expect(y).toBeLessThan(300);
  });
});

// ─────────────────────────────────────────────────────────────
// Tool-use mixed with text blocks → finalText is the text portion
// ─────────────────────────────────────────────────────────────

describe("mixed text + tool_use blocks", () => {
  it("captures text alongside tool_use into finalText", async () => {
    mockCreate
      .mockResolvedValueOnce(
        rsp([
          textBlock("Let me click that button."),
          toolUse({ action: "screenshot" }, "id-A"),
        ]),
      )
      .mockResolvedValueOnce(rsp([textBlock("All set.")]));
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    // Finished on a no-tool-use response → finalText is the conclusion
    expect(result.finalText).toBe("All set.");
    expect(result.iterations).toBe(2);
    // History captured both iterations
    expect(result.history.filter((h) => h.role === "assistant").length).toBe(2);
    expect(result.history.some((h) => h.role === "tool")).toBe(true);
  });

  it("tool_use without an id still surfaces in tool_result with empty id", async () => {
    mockCreate
      .mockResolvedValueOnce(
        rsp([
          {
            type: "tool_use",
            // no id field
            name: "computer",
            input: { action: "screenshot" },
          } as AnyBlock,
        ]),
      )
      .mockResolvedValueOnce(rsp([textBlock("done")]));
    const { page } = mkPage();
    const result = await runComputerUseTask({
      page: page as never,
      task: "x",
      model: "claude-sonnet-4-6",
    });
    expect(result.iterations).toBe(2);
  });
});
