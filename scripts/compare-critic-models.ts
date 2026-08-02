#!/usr/bin/env tsx
/**
 * Compare what two or more critic models actually score, dimension by
 * dimension.
 *
 * Why this exists. `scoreReport` answers "did every dimension land inside its
 * labelled band", and the bands average 4.4 points wide on a 0-10 scale — 44%
 * of the range, with the widest accepting 0-6. Anything inside collapses to
 * distance 0, so a model scoring 1 and a model scoring 6 on the same dimension
 * both come back as agreement 1.000, max distance 0.000, fully aligned.
 *
 * That is what "the fixtures are saturated" turned out to mean. The pages are
 * not too easy: the raw scores were being measured and then thrown away by the
 * summary. `SampleAgreement` has carried `critic_score` all along.
 *
 * The consequence was that "would changing the default model make the scoring
 * worse" had no instrument behind it, and the default models have sat a
 * generation behind partly for that reason.
 *
 * Repeated per model, because one sample per cell is not a measurement. The
 * prompt-injection work in this repository learned the same thing the hard way:
 * a single trial reports a coin flip and calls it a rate. It matters more here,
 * because the quantity of interest is a *difference* between two models — and a
 * difference only means something once it exceeds the spread each model
 * produces on its own. Both numbers are printed, and cells where the difference
 * clears the noise are marked.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=… npm run compare:critics
 *   ANTHROPIC_API_KEY=… npm run compare:critics -- --trials 5 claude-sonnet-4-6 claude-sonnet-5
 *
 * This spends money: one vision call per fixture per model per trial.
 */

import * as path from "node:path";
import { runCalibration } from "../src/calibration/runner.js";
import type { CalibrationReport } from "../src/calibration/types.js";

const DEFAULT_MODELS = ["claude-sonnet-4-6", "claude-sonnet-5"];
const DEFAULT_TRIALS = 3;

interface Cell {
  /** One entry per trial. */
  scores: number[];
  min: number;
  max: number;
}

/** sample id + dimension -> scores across trials, for one model. */
type ScoreTable = Map<string, Cell>;

function accumulate(into: ScoreTable, report: CalibrationReport): void {
  for (const sample of report.samples) {
    for (const d of sample.per_dimension) {
      const key = `${sample.sample_id} ${d.dimension}`;
      const cell = into.get(key) ?? {
        scores: [],
        min: d.expected_min,
        max: d.expected_max,
      };
      if (d.critic_score !== null) cell.scores.push(d.critic_score);
      into.set(key, cell);
    }
  }
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Max minus min across one model's own trials — its run-to-run noise. */
function spread(xs: number[]): number {
  return xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs);
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write("ANTHROPIC_API_KEY is not set.\n");
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const trialsAt = argv.indexOf("--trials");
  const trials =
    trialsAt >= 0 && Number.isFinite(Number(argv[trialsAt + 1]))
      ? Math.max(1, Math.floor(Number(argv[trialsAt + 1])))
      : DEFAULT_TRIALS;
  const named = argv.filter((a, i) => !a.startsWith("--") && i !== trialsAt + 1);
  const targets = named.length > 0 ? named : DEFAULT_MODELS;

  const fixturesDir = path.resolve("./tests/fixtures/critic-calibration");
  const perModel: Array<{
    model: string;
    table: ScoreTable;
    reports: CalibrationReport[];
  }> = [];

  for (const model of targets) {
    const table: ScoreTable = new Map();
    const reports: CalibrationReport[] = [];
    for (let trial = 0; trial < trials; trial++) {
      process.stdout.write(`running ${model} — trial ${trial + 1}/${trials}\n`);
      const report = await runCalibration({
        fixturesDir,
        model,
        tag: "compare",
        outputDir: path.resolve(
          `./reports/calibration/cmp_${model.replace(/[^a-z0-9]/gi, "_")}_${trial}`,
        ),
      });
      accumulate(table, report);
      reports.push(report);
    }
    perModel.push({ model, table, reports });
  }

  const keys = [...perModel[0]!.table.keys()].sort();
  const nameWidth = 42;

  process.stdout.write(
    `\n${"sample / dimension".padEnd(nameWidth)}${"band".padEnd(7)}` +
      perModel.map((m) => m.model.slice(-13).padStart(16)).join("") +
      "    between\n",
  );
  process.stdout.write(
    `${"".padEnd(nameWidth)}${"".padEnd(7)}` +
      perModel.map(() => "mean (±own)".padStart(16)).join("") +
      "\n",
  );
  process.stdout.write(
    "-".repeat(nameWidth + 7 + 16 * perModel.length + 12) + "\n",
  );

  let betweenTotal = 0;
  let ownTotal = 0;
  let counted = 0;
  let separable = 0;

  for (const key of keys) {
    const [sample, dimension] = key.split(" ");
    const cells = perModel.map((m) => m.table.get(key));
    const first = cells[0];
    if (!first) continue;

    const means = cells.map((c) => (c ? mean(c.scores) : null));
    const present = means.filter((m): m is number => m !== null);
    const between =
      present.length > 1 ? Math.max(...present) - Math.min(...present) : 0;
    // The largest run-to-run spread any single model showed on this cell.
    const own = Math.max(...cells.map((c) => (c ? spread(c.scores) : 0)));

    if (present.length > 1) {
      betweenTotal += between;
      ownTotal += own;
      counted++;
      if (between > own) separable++;
    }

    process.stdout.write(
      `${`${sample} / ${dimension}`.slice(0, nameWidth - 1).padEnd(nameWidth)}` +
        `${`${first.min}-${first.max}`.padEnd(7)}` +
        cells
          .map((c) => {
            const m = c ? mean(c.scores) : null;
            const s = c ? spread(c.scores) : 0;
            return `${m === null ? "—" : m.toFixed(1)} (±${s.toFixed(1)})`.padStart(
              16,
            );
          })
          .join("") +
        `${between > 0 ? `    ${between.toFixed(1)}${between > own ? " *" : ""}` : ""}\n`,
    );
  }

  process.stdout.write(
    `\ntrials per model: ${trials}\n` +
      `mean between-model difference: ${counted === 0 ? "n/a" : (betweenTotal / counted).toFixed(2)}\n` +
      `mean within-model spread:      ${counted === 0 ? "n/a" : (ownTotal / counted).toFixed(2)}\n` +
      `difference exceeds own noise:  ${separable}/${counted} dimensions (marked *)\n`,
  );

  process.stdout.write("\nWhat the pass/fail view reports for the same runs:\n");
  for (const { model, reports } of perModel) {
    const agree = reports.map((r) => r.mean_agreement);
    const dist = reports.map((r) => r.mean_max_distance);
    process.stdout.write(
      `  ${model.padEnd(24)} agreement ${(mean(agree) ?? 0).toFixed(3)} (±${spread(agree).toFixed(3)})` +
        `   max distance ${(mean(dist) ?? 0).toFixed(3)} (±${spread(dist).toFixed(3)})\n`,
    );
  }

  process.stdout.write(
    "\nCost is deliberately not compared: a model missing from the PRICING table\n" +
      "is estimated at the highest known rate, so the figures are not like for like.\n",
  );
}

await main();
