#!/usr/bin/env tsx
/**
 * Fail if internal source files reintroduce console.{log,error,warn,info,debug}.
 *
 * Ported from the old `scripts/check-no-console.sh` (F7): that version hardcoded
 * `bash` + `grep -rEn`, so `npm test` (and `prepublishOnly` -> `npm test`) broke
 * on no-bash environments — Windows without Git-Bash, minimal publish CI, etc.
 * This pure-Node port runs anywhere Node runs (which is guaranteed: the whole
 * toolchain is Node).
 *
 * Allowed exceptions (must use console for user-facing rendering):
 *   - src/cli.ts        — CLI is the user-facing rendering layer (chalk + console.log are intentional UX)
 *   - src/commands/*.ts — interactive subcommands (doctor / init wizard), same role as cli.ts
 *
 * A "call" is `console.<method>(` — the open paren is what distinguishes a real
 * call from a string literal or a comment mentioning console.*.
 *
 * All other source files must use the structured logger from src/core/logger.ts.
 *
 * Exits 0 (clean) / 1 (offenders found).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

const CONSOLE_CALL = /console\.(log|error|warn|info|debug)\(/;

/** True for files that are allowed to call console.* directly. */
export function isExempt(relPath: string): boolean {
  const norm = relPath.split(path.sep).join("/");
  return norm === "src/cli.ts" || norm.startsWith("src/commands/");
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkTs(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Pure scan core — no process exit, no console. Returns offender lines as
 * `relpath:lineno: <trimmed source>`. `srcDir` defaults to <repo>/src.
 */
export function findConsoleOffenders(srcDir: string = path.join(REPO_ROOT, "src")): string[] {
  const offenders: string[] = [];
  for (const file of walkTs(srcDir)) {
    const rel = path.relative(REPO_ROOT, file);
    if (isExempt(rel)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (CONSOLE_CALL.test(line)) {
        offenders.push(`${rel.split(path.sep).join("/")}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

function main(): void {
  const offenders = findConsoleOffenders();
  if (offenders.length > 0) {
    process.stderr.write(
      "ERROR: console.* calls found outside src/cli.ts and src/commands/.\n",
    );
    process.stderr.write("       Use getLogger() from src/core/logger.ts instead.\n\n");
    process.stderr.write(offenders.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write("no-console check: ok\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
