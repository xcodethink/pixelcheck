#!/usr/bin/env tsx
/**
 * `npm run bench:check` / `npm run bench:update` entry point (M6-7).
 *
 * Usage:
 *   tsx scripts/check-perf.ts                   — compare current vs baseline, exit 1 on regression
 *   tsx scripts/check-perf.ts --update-baseline — overwrite baseline with current
 *   tsx scripts/check-perf.ts --tolerance 0.20  — set regression tolerance (default 0.30)
 *
 * Prerequisite: `npm run bench` must have written
 * docs/perf-current.json (the bench JSON output). The script is a thin
 * wrapper around src/perf/compare.ts so the comparison logic stays
 * unit-testable.
 *
 * Exit codes:
 *   0 — all benchmarks within tolerance (or --update-baseline run cleanly)
 *   1 — at least one benchmark regressed beyond tolerance
 *   2 — input file missing or malformed (operator setup error)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildBaseline,
  compareBaseline,
  flattenBenchReport,
  formatComparison,
  hasRegression,
  type PerfBaseline,
  type VitestBenchReport,
} from "../src/perf/compare.js";

interface CliArgs {
  updateBaseline: boolean;
  tolerancePct: number;
  baselinePath: string;
  currentPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    updateBaseline: false,
    tolerancePct: 0.50,
    baselinePath: path.resolve("docs/perf-baseline.json"),
    currentPath: path.resolve("docs/perf-current.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update-baseline") args.updateBaseline = true;
    else if (a === "--tolerance" && argv[i + 1]) {
      const t = Number(argv[i + 1]);
      if (Number.isFinite(t) && t > 0) args.tolerancePct = t;
      i++;
    } else if (a === "--baseline" && argv[i + 1]) {
      args.baselinePath = path.resolve(argv[i + 1]!);
      i++;
    } else if (a === "--current" && argv[i + 1]) {
      args.currentPath = path.resolve(argv[i + 1]!);
      i++;
    }
  }
  return args;
}

function readJson<T>(filePath: string): T {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`[check-perf] file not found: ${filePath}\n`);
    process.stderr.write(
      "[check-perf] hint: run 'npm run bench' first to produce docs/perf-current.json\n",
    );
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function writeBaselineFile(baseline: PerfBaseline, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(baseline, null, 2) + "\n");
}

// `process.stdout.write` instead of `console.log` so the project's
// no-console lint stays clean. This is a tooling script, not src code,
// but the convention is consistent.
function out(line: string): void {
  process.stdout.write(line + "\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = readJson<VitestBenchReport>(args.currentPath);
  const current = flattenBenchReport(report);

  if (Object.keys(current).length === 0) {
    process.stderr.write(
      "[check-perf] no benchmarks found in current report\n",
    );
    process.exit(2);
  }

  if (args.updateBaseline) {
    const newBaseline = buildBaseline(
      current,
      `${os.platform()} ${os.arch()} (Node ${process.version})`,
    );
    writeBaselineFile(newBaseline, args.baselinePath);
    out(
      `[check-perf] baseline updated: ${args.baselinePath} (${Object.keys(current).length} benchmarks)`,
    );
    process.exit(0);
  }

  // Regression mode: must have an existing baseline to compare against
  if (!fs.existsSync(args.baselinePath)) {
    process.stderr.write(
      `[check-perf] baseline not found: ${args.baselinePath}\n`,
    );
    process.stderr.write(
      "[check-perf] hint: run 'npm run bench:update' first to record the initial baseline\n",
    );
    process.exit(2);
  }
  const baseline = readJson<PerfBaseline>(args.baselinePath);

  const comparisons = compareBaseline(current, baseline, {
    tolerancePct: args.tolerancePct,
  });

  out(
    `[check-perf] ${comparisons.length} benchmarks · tolerance ${(args.tolerancePct * 100).toFixed(0)}%`,
  );
  for (const c of comparisons) {
    out(`  ${formatComparison(c)}`);
  }
  out("");

  const regressed = comparisons.filter((c) => c.status === "regression");
  if (regressed.length > 0 || hasRegression(comparisons)) {
    out(`[check-perf] FAIL — ${regressed.length} benchmark(s) regressed beyond ${(args.tolerancePct * 100).toFixed(0)}%`);
    out(
      "[check-perf] hint: investigate the regression, or if intentional, run 'npm run bench:update' to bake the new numbers in",
    );
    process.exit(1);
  }
  out("[check-perf] OK — no regressions");
  process.exit(0);
}

main();
