#!/usr/bin/env node
/**
 * Make the compiled bin entry points executable.
 *
 * Why this is needed: `tsc` emits plain 0644 files, and the shebang in
 * `src/cli.ts` is worthless without the executable bit. npm sets that bit
 * itself when it installs or links a package, so consumers installing from the
 * registry are unaffected — `npx pixelcheck` works either way.
 *
 * The gap is local development. `npm link` sets the bit once, at link time.
 * After that, any `npm run clean && npm run build` replaces the files and the
 * linked `pixelcheck` command starts failing with "permission denied" until
 * someone re-links or notices. That is a confusing failure for something that
 * has nothing to do with the change being made.
 *
 * Reading the bin map rather than hard-coding paths means a new bin entry is
 * covered automatically instead of silently missing this step.
 *
 * chmod is a no-op on Windows; Node does not throw, so this needs no platform
 * branch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

const targets = Object.values(pkg.bin ?? {});
if (targets.length === 0) {
  process.stdout.write("chmod-bins: no bin entries declared\n");
  process.exit(0);
}

const missing = [];
for (const rel of targets) {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) {
    missing.push(rel);
    continue;
  }
  fs.chmodSync(full, 0o755);
}

if (missing.length > 0) {
  // A declared bin that the build did not produce is a packaging bug: npm would
  // create a broken symlink on install. Fail rather than quietly skip it.
  process.stderr.write(
    `ERROR: package.json declares bin entries that the build did not produce:\n` +
      missing.map((m) => `  ${m}\n`).join(""),
  );
  process.exit(1);
}

process.stdout.write(`chmod-bins: ${targets.length} bin entrie(s) made executable\n`);
