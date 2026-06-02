/**
 * postinstall — fetch the browser binary pixelcheck needs, once, at install
 * time, so `npm install -g pixelcheck` lands a runnable tool instead of one
 * that crashes on the first `explore`/`run` with "Executable doesn't exist".
 *
 * Design constraints (why this file is plain .mjs, not compiled TS):
 *   - It must run straight from the published tarball, which ships `dist/`
 *     and this script but not `src/`. It dynamic-imports the COMPILED
 *     `dist/core/browser-install.js`.
 *   - It must NEVER fail `npm install`. A browser download is best-effort:
 *     any error (offline, locked dir, dist not built yet in a dev checkout)
 *     is swallowed and the process still exits 0. `pixelcheck doctor --fix`
 *     and the launch-time self-heal remain as fallbacks.
 *
 * Opt-out (CI, air-gapped, custom provisioning):
 *   PIXELCHECK_SKIP_BROWSER_DOWNLOAD=1   — pixelcheck-specific
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1   — honour Playwright's own flag too
 * We also skip automatically when CI=true: CI images install browsers in a
 * dedicated cached step (and our own repo CI runs `playwright install`).
 */

const log = (line) => process.stdout.write(`[pixelcheck postinstall] ${line}\n`);

async function main() {
  if (
    process.env.PIXELCHECK_SKIP_BROWSER_DOWNLOAD === "1" ||
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1"
  ) {
    log("skipped (browser-download opt-out env set).");
    return;
  }
  if (process.env.CI === "true" || process.env.CI === "1") {
    log("skipped on CI — run `pixelcheck install` in a dedicated step.");
    return;
  }

  let mod;
  try {
    // Resolve the compiled module next to this script in the package root.
    mod = await import(new URL("../dist/core/browser-install.js", import.meta.url));
  } catch {
    // dist/ not built (fresh dev checkout — build runs after install) or
    // the layout changed. Not our job to fail the install; the launch-time
    // self-heal will cover it.
    log("dist not built yet — skipping browser bootstrap (dev install).");
    return;
  }

  try {
    const info = mod.resolveHeadlessShell?.();
    if (info?.present) {
      log("Chrome Headless Shell already installed.");
      return;
    }
    const result = await mod.ensureHeadlessShell({ onProgress: (l) => log(l) });
    if (result.status === "installed" || result.status === "already-present") {
      log("ready. Run `pixelcheck doctor` to verify your environment.");
    } else {
      log(
        `could not auto-install the browser (${result.status}). ` +
          "Run `pixelcheck install` or `pixelcheck doctor --fix` later.",
      );
    }
  } catch (err) {
    log(
      `browser bootstrap skipped: ${err?.message ?? err}. ` +
        "Run `pixelcheck install` later if needed.",
    );
  }
}

// Never reject — postinstall must not break `npm install`.
main().catch(() => {}).finally(() => process.exit(0));
