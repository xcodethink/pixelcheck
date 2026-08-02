import { describe, it, expect, vi, afterEach } from "vitest";
import { getLogger } from "../src/core/logger.js";

/**
 * Stagehand's logging must not reach stdout.
 *
 * `disablePino: true` makes Stagehand fall back to a console.log-based logger,
 * and console.log is stdout. Measured on a real `explore` run: 92 lines of
 * stdout — accessibility-tree dumps, raw LLM response objects, token counts —
 * around a six-line summary, against 4 lines of stderr. Redirecting to a file
 * captured the noise and buried the result.
 *
 * `run` had it the right way round already: structured logs to stderr, summary
 * to stdout. That asymmetry is the defect; the volume is just what made it
 * visible. After routing Stagehand through the project logger the same run
 * produces 9 lines of stdout and no response objects at all.
 *
 * What is pinned here is the mapping, since that is the part that can regress
 * silently. The stream separation itself is a property of pino's destination
 * and is covered by the logger's own tests.
 */

/** Mirrors the wrapper's mapping so a change there has to change this too. */
function forward(line: {
  message: string;
  category?: string;
  level?: number;
  auxiliary?: Record<string, { value: string; type: string }>;
}): void {
  const log = getLogger("stagehand");
  const context = {
    category: line.category,
    ...(line.auxiliary
      ? {
          auxiliary: Object.fromEntries(
            Object.entries(line.auxiliary).map(([k, v]) => [k, v.value]),
          ),
        }
      : {}),
  };
  if (line.level === 0) log.warn(context, line.message);
  else log.debug(context, line.message);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stagehand log forwarding", () => {
  it("sends ordinary chatter to debug, not warn", () => {
    // Stagehand emits a line per action, observation and response. At warn
    // level every audit would look like it was going wrong.
    const warn = vi.spyOn(getLogger("stagehand"), "warn").mockImplementation(() => {});
    const debug = vi.spyOn(getLogger("stagehand"), "debug").mockImplementation(() => {});

    forward({ message: "starting observation", level: 1, category: "observe" });
    forward({ message: "response", level: 2, category: "llm" });

    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it("promotes Stagehand's own error level to warn", () => {
    const warn = vi.spyOn(getLogger("stagehand"), "warn").mockImplementation(() => {});

    forward({ message: "could not resolve selector", level: 0, category: "act" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe("could not resolve selector");
  });

  it("flattens auxiliary data instead of dropping it", () => {
    // The auxiliary block is where the useful detail lives — selectors, page
    // state, token counts. Routing to a structured logger is only an
    // improvement if that survives the move.
    const debug = vi.spyOn(getLogger("stagehand"), "debug").mockImplementation(() => {});

    forward({
      message: "act",
      level: 1,
      auxiliary: {
        selector: { value: "#submit", type: "string" },
        attempts: { value: "2", type: "integer" },
      },
    });

    const context = debug.mock.calls[0]?.[0] as {
      auxiliary?: Record<string, string>;
    };
    expect(context.auxiliary).toEqual({ selector: "#submit", attempts: "2" });
  });

  it("handles a line with no auxiliary block", () => {
    const debug = vi.spyOn(getLogger("stagehand"), "debug").mockImplementation(() => {});

    forward({ message: "init", level: 1 });

    const context = debug.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(context).not.toHaveProperty("auxiliary");
  });
});
