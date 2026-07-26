#!/usr/bin/env tsx
/**
 * Fail if CJK text appears anywhere it is not the product's own content.
 *
 * Why this exists: this repository is public and published to npm, but it grew
 * out of a working notebook. Documentation, ADRs and changelog entries were
 * written in Chinese and shipped that way — roughly 12,000 CJK characters
 * across 46 tracked files, including internal task IDs, risk-register
 * bookkeeping, a real name and references to private local paths. That was
 * cleaned up on 2026-07-26; this check keeps it clean, because relying on
 * remembering the rule is exactly what failed the first time.
 *
 * The rule is not "no CJK anywhere". This tool ships localisation as a
 * *feature*: report translations in five locales (ADR-023), the WCAG section
 * headings (ADR-024), and Chinese / Japanese personas. In those files the
 * non-English text IS the deliverable, so they are exempt — and their tests,
 * which assert the translations are correct, are exempt with them.
 *
 * Everything else — README, CHANGELOG, ADRs, guides, source comments, commit
 * scaffolding — must be English.
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
 * CJK ideographs (U+4E00–U+9FFF) plus Hiragana (U+3040–U+309F) and Katakana
 * (U+30A0–U+30FF). Deliberately not matching the fullwidth-punctuation block on
 * its own: a stray fullwidth comma is a typo, not a translation, and flagging
 * it would produce noise without protecting anything.
 *
 * Written as escapes rather than literal characters on purpose — with literals
 * this file matches itself, which is exactly what happened the first time it
 * ran in CI.
 */
const CJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/;

/**
 * Files where non-English text is the product content itself.
 *
 * Keep this list as short as the feature requires. Adding a file here says
 * "shipping non-English text from this path is the point", which is true of a
 * translation table and false of a design document.
 */
const EXEMPT_EXACT = new Set([
  // The translation tables themselves (ADR-023 report localisation).
  "src/core/i18n.ts",
  "src/core/reporter-spa-i18n.ts",
  // Locale-specific severity labels rendered into diff reports.
  "src/core/reporter-diff.ts",
  // Tests that assert the translations above are present and correct.
  "tests/i18n.test.ts",
  "tests/reporter-diff.test.ts",
  "tests/reporter-pdf.test.ts",
  "tests/reporter-spa.test.ts",
  "tests/reporter-spa-i18n.test.ts",
  "tests/reporter-trends.test.ts",
  // Fixture page whose accessibility violations include non-English content.
  "tests/fixtures/a11y-broken-page.html",
  // Author guides whose worked examples are, necessarily, non-English personas
  // and locale-specific wording.
  "docs/writing-personas.md",
  "docs/translation-review-template.md",
]);

/** Persona definitions for non-English locales. */
const EXEMPT_PREFIXES = ["personas/"];

export function isExempt(relPath: string): boolean {
  const norm = relPath.split(path.sep).join("/");
  return (
    EXEMPT_EXACT.has(norm) || EXEMPT_PREFIXES.some((p) => norm.startsWith(p))
  );
}

/** Every file git tracks, so untracked scratch files never fail the build. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

export function findCjkOffenders(): string[] {
  const offenders: string[] = [];
  for (const rel of trackedFiles()) {
    if (isExempt(rel)) continue;
    const full = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue; // unreadable — nothing to check
    }
    // Skip binaries. Decoding a PNG as UTF-8 happily produces byte sequences
    // that land in the CJK range, which would make this check fire on every
    // screenshot fixture in the repository. A NUL byte in the leading chunk is
    // the same heuristic git itself uses to classify a file as binary.
    if (buf.subarray(0, 8000).includes(0)) continue;

    const text = buf.toString("utf8");
    if (!CJK.test(text)) continue;

    text.split(/\r?\n/).forEach((line, i) => {
      if (CJK.test(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return offenders;
}

function main(): void {
  const offenders = findCjkOffenders();
  if (offenders.length > 0) {
    process.stderr.write(
      "ERROR: CJK text found outside the localisation surface.\n",
    );
    process.stderr.write(
      "       This repository is public. Docs, ADRs, the changelog, README and\n" +
        "       source comments must be English. If the text below is genuinely\n" +
        "       product content (a translation table, a persona, a test asserting\n" +
        "       one), add its path to EXEMPT_EXACT / EXEMPT_PREFIXES in\n" +
        "       scripts/check-english-only.ts and say why in the commit.\n\n",
    );
    process.stderr.write(offenders.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write("english-only check: ok\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
