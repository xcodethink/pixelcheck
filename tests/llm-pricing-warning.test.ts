import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  estimateCost,
  _resetUnpricedWarningsForTests,
} from "../src/core/llm.js";
import { getLogger } from "../src/core/logger.js";

/**
 * The pricing table lists three model ids. The API offers more, and a user is
 * free to point `models.critic` at any of them. When they do, `estimateCost`
 * falls back to the most expensive known rate.
 *
 * That direction is correct for a budget guard and is not changed here — a
 * cheap fallback would quietly weaken every cap. What was missing is that the
 * over-estimate was silent, so a run stopping early on budget looked like a
 * real cost rather than a missing table entry.
 *
 * Found by measurement: the same five calibration fixtures reported $0.09 on a
 * priced model and $0.47 on an unpriced one. The gap was entirely the
 * fallback. A cost comparison between models is unusable until the newer one
 * is priced, and nothing said so.
 */

describe("estimateCost — unpriced models", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetUnpricedWarningsForTests();
    warn = vi.spyOn(getLogger("llm"), "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    _resetUnpricedWarningsForTests();
  });

  it("stays silent for a model that is in the table", () => {
    estimateCost("claude-sonnet-4-6", 1000, 1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a model has no published price", () => {
    estimateCost("claude-sonnet-5", 1000, 1000);

    expect(warn).toHaveBeenCalledTimes(1);
    const [ctx, message] = warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(ctx.model).toBe("claude-sonnet-5");
    expect(message).toMatch(/over-count|highest known rate/i);
  });

  it("warns once per model, not once per call", () => {
    // estimateCost runs on every LLM response; a per-call warning would bury
    // the run's own output.
    for (let i = 0; i < 25; i++) estimateCost("claude-opus-5", 100, 100);
    expect(warn).toHaveBeenCalledTimes(1);

    estimateCost("claude-fable-5", 100, 100);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("still charges the highest known rate, so caps are never weakened", () => {
    // The whole point of the fallback. An unknown model must not be cheaper
    // than the most expensive one we know about, or a typo would buy headroom.
    const unknown = estimateCost("some-future-model", 1_000_000, 1_000_000);
    const priciest = estimateCost("claude-opus-4-6", 1_000_000, 1_000_000);
    const cheapest = estimateCost(
      "claude-haiku-4-5-20251001",
      1_000_000,
      1_000_000,
    );

    expect(unknown).toBe(priciest);
    expect(unknown).toBeGreaterThan(cheapest);
  });
});
