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
 *   - risk-register entry references
 *   - internal task identifiers (T-NEW-N)
 *   - iteration labels ("Wave N")
 *   - "ship-blocker" as internal triage vocabulary
 *   - references to internal status documents
 *
 * What is NOT banned, deliberately:
 *   - ADR numbers — public decision records, meant to be cited
 *   - CVE / GHSA identifiers, version numbers, coverage figures
 *   - "worktree" — a real git feature that ADR-004 is about
 *   - docs/releases/ — a historical record; editing it after the fact to look
 *     tidier would defeat the point of having it
 *
 * Exits 0 (clean) / 1 (offenders found).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

/** Each pattern is paired with what a reader should write instead. */
const BANNED: Array<{ label: string; pattern: RegExp; instead: string }> = [
  {
    label: "risk-register reference",
    pattern: /RISK[- ]REGISTER|risk-register/i,
    instead: "describe the risk itself, or link an issue",
  },
  {
    label: "internal task id",
    pattern: /\bT-NEW-\d+/,
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
 * Release records are a historical log. They may legitimately quote what the
 * state was at the time, and rewriting them later would make them untrustworthy.
 */
const EXEMPT_PREFIXES = ["docs/releases/"];

/** This file necessarily contains the patterns it bans. */
const EXEMPT_EXACT = new Set(["scripts/check-no-internal-refs.ts"]);

export function isExempt(relPath: string): boolean {
  const norm = relPath.split(path.sep).join("/");
  return (
    EXEMPT_EXACT.has(norm) || EXEMPT_PREFIXES.some((p) => norm.startsWith(p))
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
