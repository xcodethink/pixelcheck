#!/usr/bin/env tsx
/**
 * Fail if internal project-tracking identifiers appear in the repository.
 *
 * Why this exists: this repository is public and published to npm, and it grew
 * out of a working notebook. Task identifiers, risk-register entry numbers and
 * iteration labels had leaked into source comments, workflow headers, test
 * headers, the changelog and the ADRs — 77 places in all. Some of them shipped:
 * `tsconfig.json` does not set `removeComments`, so source comments compile
 * straight into `dist/`, and the published tarball for 1.4.1 carried nine of
 * them.
 *
 * They are worthless to a reader outside the project — nobody can look up what
 * "R45" was — and they expose how the work was planned rather than what the
 * code does. A comment's value is the explanation, not the ticket number.
 *
 * What is banned:
 *   - risk-register entry references, and bare risk ids
 *   - internal task identifiers
 *   - milestone / iteration labels
 *   - "ship-blocker" as internal triage vocabulary
 *   - references to internal status documents
 *
 * On the shape of those identifiers, because the first version of this file got
 * it wrong: it banned only the hyphenated forms, which is what CONTRIBUTING.md
 * used to give as the example. The identifiers actually in use looked nothing
 * like that, so the gate reported clean while the real ones went straight past
 * it and into a published tarball. Patterns here match the forms the repository
 * uses, and CONTRIBUTING.md no longer tells anyone to write them.
 *
 * What is NOT banned, deliberately:
 *   - ADR numbers — public decision records, meant to be cited
 *   - CVE / GHSA identifiers, version numbers, coverage figures
 *   - "worktree" — a real git feature that ADR-004 is about
 *   - ISO timestamps, whose date/time separator would otherwise read as a task
 *     id (the `2026-07-29T04:43:43Z` in every release record)
 *
 * Exempt paths are historical records. Editing them after the fact to look
 * tidier is what makes a log untrustworthy, and the point of keeping one is
 * that it says what was true at the time:
 *   - docs/releases/ and CHANGELOG.md — the published release log
 *   - docs/decisions/ — architecture decision records, which are written once
 *     and superseded rather than revised, and legitimately describe the
 *     context a decision was taken in
 *
 * Exits 0 (clean) / 1 (offenders found).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

/**
 * Each pattern is paired with what a reader should write instead.
 *
 * Exported so the patterns can be exercised directly. Testing them through
 * `findInternalRefs()` cannot work: that scans every tracked file, so its
 * result says whether the repository is clean, not whether a given string
 * matches — which is how the first version's blind spot survived review.
 */
export const BANNED: Array<{ label: string; pattern: RegExp; instead: string }> = [
  {
    // `(Audit 2026-06-02 E2.)`, `(Audit G2)`, `(Audit 2026-06-02 E6/D3-M3.)`.
    //
    // This is the form that mattered, and the one that four rounds of adding
    // prefixes never caught: the identifiers hang off an attribution phrase,
    // and the phrase is what makes them findable. Measured across the
    // repository it matched 43 occurrences and nothing else, 34 of them in
    // src/, which compiles into dist and ships. Every hit was genuine.
    //
    // Matching the token shape instead was tried and rejected on the numbers.
    // `[A-Z]` followed by one or two digits matches 57 distinct tokens here
    // and the great majority are legitimate: P0/P1/P2 issue priorities,
    // H1/H2 heading levels, L1-L4 architecture layers, A4 paper, B64 base64,
    // X11, and device identifiers inside personas. A gate that is wrong nine
    // times in ten gets switched off, or drowned in exemptions until it is.
    label: "audit attribution",
    pattern: /\(Audit(?:\s+\d{4}-\d{2}-\d{2})?\s+[A-Z][\w./-]*[^)]*\)/,
    instead: "say what the change does; provenance belongs in the commit",
  },

  {
    label: "risk-register reference",
    pattern: /RISK[- ]REGISTER|risk-register/i,
    instead: "describe the risk itself, or link an issue",
  },
  {
    // `R36`, `R-NEW-11`. The lookbehind keeps this off anything where the
    // letter is part of a longer token, so identifiers like `ADR-036` and
    // words ending in R are untouched.
    label: "risk id",
    pattern: /(?<![\w-])R(?:-NEW-\d+|\d{1,3})(?![\w:.-])/,
    instead: "describe the risk itself, or link an issue",
  },
  {
    // `T22`, `T0.6`, `T-NEW`, `T-NEW-4`.
    //
    // ISO timestamps are kept out by the LEADING exclusion: in
    // `2026-07-29T04:43:43Z` the `T` follows a digit. The trailing exclusion
    // used to list `:` as well, as a second line of defence against the same
    // case — and that made `T22:` invisible, which is the form a task id takes
    // at the start of a comment. One was found in `src/core/recorder.ts`,
    // where it compiled into `dist` and shipped.
    //
    // Belt and braces is not free when the braces also hold the gate open.
    //
    // What replaces it distinguishes the two by what follows: a task id is
    // followed by prose (`T22: replace …`), a clock time by more digits
    // (`T12:00:00Z`). That also covers a timestamp assembled by interpolation,
    // where the `T` follows `}` rather than a digit and the leading exclusion
    // does not help.
    label: "internal task id",
    pattern: /(?<![\w-])T(?:-NEW(?:-\d+)?|\d{1,3}(?:\.\d+)?)(?![\w.-])(?!:\d)/,
    instead: "describe the change, or link an issue / ADR",
  },
  {
    // `M9-4`, `M9-3.2` — the milestone numbering the work was planned under.
    label: "milestone label",
    pattern: /(?<![\w-])M\d{1,2}-\d{1,2}(?:\.\d+)?(?![\w])/,
    instead: "name the capability, not the milestone it landed in",
  },
  {
    // `G3`, `G4`, `B2`, `B3` — the two workstream prefixes this repository
    // actually used, alongside the `T` ones. They were missed for the same
    // reason the header describes: the gate was written against the shapes
    // someone expected rather than the shapes in the files. Nine test names
    // carried them past it, in a public repository.
    //
    // One digit, not two: the ids in use are all single-digit, and `\d{1,2}`
    // additionally matched the literal `B64` in a vision test, where it means
    // base64. Widening a gate until it flags real content, then editing the
    // content to quieten it, is the wrong way round.
    //
    // The trailing exclusion keeps `B2B` and colours like `#B3D9FF` out, and
    // the leading one keeps this off any longer token ending in G or B.
    label: "internal workstream id",
    pattern: /(?<![\w-])[GB]\d(?![\w:.-])/,
    instead: "describe the change, or link an issue / ADR",
  },
  {
    label: "iteration label",
    pattern: /\bWave \d+/,
    instead: "name what shipped, not which batch it was in",
  },
  {
    label: "internal triage vocabulary",
    pattern: /ship-blocker/i,
    instead: '"release blocker"',
  },
  {
    label: "internal status document",
    pattern: /\bSTATUS\.md\b/,
    instead: "link a public document, or drop the reference",
  },
];

/**
 * Historical records. They may legitimately quote what the state was at the
 * time, and rewriting them later would make them untrustworthy. ADRs belong
 * here for the same reason a release record does: an ADR is superseded by a
 * later ADR, never edited to say something it did not say.
 */
const EXEMPT_PREFIXES = ["docs/releases/", "docs/decisions/"];

/**
 * This gate's own test, which has to contain the identifiers it detects — a
 * gate with no test is how the G and B shapes went unnoticed through two
 * rounds of fixing this file.
 *
 * Exempt by exact path, never by prefix: a prefix would quietly cover any
 * future file dropped beside it, and `internal-refs-gate.test.ts` asserts this
 * list stays the length it is.
 *
 * Worth knowing when adding to that test: the scan is `git ls-files`, so a new
 * file is invisible to this check until it is staged. `npm test` can pass on a
 * working tree that CI then rejects — which is exactly what happened here.
 */
export const EXEMPT_SELF_TEST = ["tests/internal-refs-gate.test.ts"];

/** This file necessarily contains the patterns it bans. */
const EXEMPT_EXACT = new Set([
  "scripts/check-no-internal-refs.ts",
  "CHANGELOG.md",
]);

export function isExempt(relPath: string): boolean {
  const norm = relPath.split(path.sep).join("/");
  return (
    EXEMPT_EXACT.has(norm) ||
    EXEMPT_SELF_TEST.includes(norm) ||
    EXEMPT_PREFIXES.some((p) => norm.startsWith(p))
  );
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

export function findInternalRefs(): string[] {
  const offenders: string[] = [];
  for (const rel of trackedFiles()) {
    if (isExempt(rel)) continue;
    const full = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    // Skip binaries, same NUL-byte heuristic git uses.
    if (buf.subarray(0, 8000).includes(0)) continue;

    const lines = buf.toString("utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { label, pattern } of BANNED) {
        if (pattern.test(line)) {
          offenders.push(`${rel}:${i + 1}: [${label}] ${line.trim().slice(0, 110)}`);
          break;
        }
      }
    });
  }
  return offenders;
}

function main(): void {
  const offenders = findInternalRefs();
  if (offenders.length > 0) {
    process.stderr.write("ERROR: internal project-tracking identifiers found.\n");
    process.stderr.write(
      "       This repository is public and its source comments compile into\n" +
        "       the published package. Ticket numbers mean nothing to a reader\n" +
        "       outside the project; keep the explanation and drop the number.\n\n",
    );
    for (const { label, instead } of BANNED) {
      process.stderr.write(`       ${label} -> ${instead}\n`);
    }
    process.stderr.write("\n");
    process.stderr.write(offenders.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write("no-internal-refs check: ok\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
