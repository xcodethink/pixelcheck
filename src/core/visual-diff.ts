import * as fs from "node:fs";
import * as path from "node:path";

export interface DiffResult {
  /** Whether a baseline existed and the diff was computed */
  computed: boolean;
  /** Total pixels that differ */
  diffPixels?: number;
  /** Path to the diff PNG (red highlights) */
  diffImagePath?: string;
  /** Match score (0..1, 1=identical) */
  match?: number;
  /** Whether this counts as a regression (diffPixels > threshold) */
  regression: boolean;
  /** Reason if not computed */
  reason?: string;
}

export interface VisualDiffOptions {
  /** Path to the current screenshot */
  current: string;
  /** Path where the baseline lives or should be created */
  baseline: string;
  /** Diff image output path */
  diffOutput: string;
  /** Threshold for declaring regression. Default 100 pixels. */
  thresholdPixels?: number;
}

/**
 * Compute a visual diff between a current screenshot and a baseline.
 *
 * Behaviour:
 *  - If baseline does not exist: copy current → baseline, mark as not regression.
 *  - If baseline exists: run odiff and compare.
 *  - If odiff is not installed: gracefully degrade (return computed=false).
 */
export async function diffAgainstBaseline(
  opts: VisualDiffOptions,
): Promise<DiffResult> {
  const { current, baseline, diffOutput } = opts;
  const threshold = opts.thresholdPixels ?? 100;

  // Bootstrap baseline if missing
  if (!fs.existsSync(baseline)) {
    fs.mkdirSync(path.dirname(baseline), { recursive: true });
    fs.copyFileSync(current, baseline);
    return {
      computed: false,
      regression: false,
      reason: "Baseline created (first run)",
    };
  }

  let odiff: { compare?: typeof import("odiff-bin").compare } | null = null;
  try {
    odiff = (await import("odiff-bin").catch(() => null)) as
      | { compare?: typeof import("odiff-bin").compare }
      | null;
  } catch {
    odiff = null;
  }

  if (!odiff || !odiff.compare) {
    return {
      computed: false,
      regression: false,
      reason: "odiff-bin not installed",
    };
  }

  fs.mkdirSync(path.dirname(diffOutput), { recursive: true });

  try {
    const result = await odiff.compare(baseline, current, diffOutput, {
      antialiasing: true,
      threshold: 0.1,
      outputDiffMask: false,
    });

    if (result.match === true) {
      return {
        computed: true,
        diffPixels: 0,
        match: 1,
        regression: false,
      };
    }

    const reason = "reason" in result ? result.reason : undefined;
    if (reason === "pixel-diff") {
      const diffCount = (result as { diffCount: number }).diffCount;
      const diffPercentage = (result as { diffPercentage: number }).diffPercentage;
      return {
        computed: true,
        diffPixels: diffCount,
        diffImagePath: diffOutput,
        match: 1 - diffPercentage / 100,
        regression: diffCount > threshold,
      };
    }

    // Layout diff or other → treat as regression
    return {
      computed: true,
      diffImagePath: diffOutput,
      regression: true,
      reason,
    };
  } catch (err) {
    return {
      computed: false,
      regression: false,
      reason: `odiff failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
