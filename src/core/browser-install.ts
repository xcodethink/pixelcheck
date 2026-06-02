/**
 * Headless-shell browser resolution + self-heal install.
 *
 * Why this exists (closes the "doctor says OK but `see` fails" gap):
 * pixelcheck's primitives launch Chromium with `headless: true`, which on
 * modern Playwright (>= 1.49) runs the *chromium-headless-shell* binary —
 * a SEPARATE download from the full Chromium build. `pixelcheck doctor`
 * historically only checked the full-Chromium executable, so it reported
 * "[OK] Chromium binary" while `see`/`judge`/`act` still crashed with
 * "Executable doesn't exist at .../chromium_headless_shell-<rev>/...".
 *
 * Worse, the canonical remedy — `npx playwright install chromium-headless-shell`
 * — downloads the archive fine but Playwright's bundled extractor can hang
 * indefinitely while unpacking the ~150 MB executable on some macOS hosts
 * (observed 2026-06: download SUCCESS, then frozen at 0% CPU on "extracting
 * archive"). This module provides a self-heal that bypasses Playwright's
 * extractor: it fetches the Chrome-for-Testing zip directly and unpacks it
 * with the system `unzip`/`tar`.
 *
 * Nothing here is on the hot path of an audit — it is only invoked by
 * `pixelcheck doctor` (detection) and `pixelcheck doctor --fix` (heal).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { getLogger } from "./logger.js";

const log = getLogger("browser-install");
const esmRequire = createRequire(import.meta.url);

/** Subset of the Playwright `browsers.json` registry entry we depend on. */
interface BrowsersJsonEntry {
  name: string;
  revision: string;
  browserVersion?: string;
}

export interface HeadlessShellInfo {
  /** Playwright browser revision, e.g. "1217". */
  revision: string;
  /** Chrome-for-Testing marketing version, e.g. "147.0.7727.15". */
  browserVersion: string;
  /**
   * Chrome-for-Testing platform token used in both the install dir name and
   * the download URL (e.g. "mac-arm64", "mac-x64", "linux64", "win64").
   * `null` when the current platform/arch has no known CfT headless-shell
   * build — detection still works, but auto-heal is unavailable.
   */
  platform: string | null;
  /** Directory Playwright extracts the browser into. */
  installDir: string;
  /** Absolute path to the chrome-headless-shell executable Playwright launches. */
  executablePath: string;
  /** Whether the executable currently exists on disk. */
  present: boolean;
}

/**
 * Map the running platform/arch to a Chrome-for-Testing platform token.
 * Returns `null` for platform/arch combinations CfT does not publish a
 * headless-shell build for (e.g. linux-arm64), so callers can degrade to
 * "[WARN] run `npx playwright install`" instead of guessing a bad URL.
 */
export function cftPlatformToken(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return "mac-arm64";
    if (arch === "x64") return "mac-x64";
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return "linux64";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "win64";
    if (arch === "ia32") return "win32";
    return null;
  }
  return null;
}

/** Read the chromium-headless-shell entry from Playwright's browsers.json. */
function readHeadlessShellEntry(): BrowsersJsonEntry | null {
  try {
    // browsers.json is not exposed via package "exports"; resolve the package
    // entry and read the sibling file directly. Stable across PW versions.
    const pkgEntry = esmRequire.resolve("playwright-core");
    const browsersJsonPath = path.join(
      path.dirname(pkgEntry),
      "browsers.json",
    );
    const raw = fs.readFileSync(browsersJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { browsers?: BrowsersJsonEntry[] };
    const entry = parsed.browsers?.find(
      (b) => b.name === "chromium-headless-shell",
    );
    return entry ?? null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "browser-install: could not read playwright-core/browsers.json",
    );
    return null;
  }
}

/**
 * Locate the ms-playwright browser cache root. Prefer deriving it from the
 * full-Chromium executable path Playwright already resolves (honors any
 * custom PLAYWRIGHT_BROWSERS_PATH and node_modules layout); fall back to the
 * documented per-OS default.
 */
function browsersRoot(): string {
  try {
    const pw = esmRequire("playwright") as {
      chromium: { executablePath?: () => string };
    };
    const exe = pw.chromium.executablePath?.();
    if (exe) {
      const m = exe.match(/^(.*)[/\\]chromium-\d+[/\\]/);
      if (m && m[1]) return m[1];
    }
  } catch {
    // fall through to env / per-OS default
  }
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath && envPath !== "0") return envPath;
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches", "ms-playwright");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "ms-playwright",
    );
  }
  return path.join(home, ".cache", "ms-playwright");
}

/**
 * Resolve everything we know about the headless-shell binary the current
 * Playwright expects: revision, version, on-disk path, and whether it exists.
 * Returns `null` only when browsers.json cannot be read at all.
 */
export function resolveHeadlessShell(): HeadlessShellInfo | null {
  const entry = readHeadlessShellEntry();
  if (!entry) return null;
  const revision = entry.revision;
  const browserVersion = entry.browserVersion ?? "";
  const platform = cftPlatformToken();
  const root = browsersRoot();
  const installDir = path.join(root, `chromium_headless_shell-${revision}`);
  // The subdir name mirrors the CfT platform token; the full-Chromium dir
  // uses the same token (chrome-<token>), so when platform is unknown we
  // still produce a best-effort path for the existence check.
  const token = platform ?? `${process.platform}-${process.arch}`;
  const exeName =
    process.platform === "win32"
      ? "chrome-headless-shell.exe"
      : "chrome-headless-shell";
  const executablePath = path.join(
    installDir,
    `chrome-headless-shell-${token}`,
    exeName,
  );
  return {
    revision,
    browserVersion,
    platform,
    installDir,
    executablePath,
    present: fs.existsSync(executablePath),
  };
}

/** Follow redirects and stream a URL to a destination file. */
function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const visit = (current: string, redirectsLeft: number): void => {
      https
        .get(current, (res) => {
          const status = res.statusCode ?? 0;
          if (
            status >= 300 &&
            status < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            const next = new URL(res.headers.location, current).toString();
            visit(next, redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(
              new Error(`download failed: HTTP ${status} for ${current}`),
            );
            return;
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on("finish", () => out.close(() => resolve()));
          out.on("error", reject);
        })
        .on("error", reject);
    };
    visit(url, 5);
  });
}

/** Extract a zip into a directory using the system unzip, falling back to tar. */
function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], {
      stdio: "ignore",
    });
    return;
  } catch {
    // bsdtar (macOS / Windows 10+) can unpack zips; GNU tar cannot, but on
    // those hosts `unzip` above will have succeeded.
    execFileSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "ignore" });
  }
}

export interface HealResult {
  status: "already-present" | "installed" | "unsupported" | "error";
  message: string;
  executablePath?: string;
}

/**
 * Self-heal a missing headless-shell binary by downloading the
 * Chrome-for-Testing zip and unpacking it with the system archiver —
 * bypassing Playwright's bundled extractor (which can hang on some macOS
 * hosts). No-op when the binary already exists.
 *
 * `onProgress` receives human-readable status lines for the CLI to print.
 */
export async function ensureHeadlessShell(opts: {
  onProgress?: (line: string) => void;
} = {}): Promise<HealResult> {
  const progress = opts.onProgress ?? (() => {});
  const info = resolveHeadlessShell();
  if (!info) {
    return {
      status: "error",
      message:
        "Could not read Playwright's browsers.json — run `npx playwright install chromium-headless-shell` manually.",
    };
  }
  if (info.present) {
    return {
      status: "already-present",
      message: `headless-shell already installed at ${info.executablePath}`,
      executablePath: info.executablePath,
    };
  }
  if (!info.platform || !info.browserVersion) {
    return {
      status: "unsupported",
      message:
        `No known Chrome-for-Testing headless-shell build for ${process.platform}/${process.arch}. ` +
        "Run `npx playwright install chromium-headless-shell` instead.",
    };
  }

  const url =
    `https://cdn.playwright.dev/builds/cft/${info.browserVersion}/` +
    `${info.platform}/chrome-headless-shell-${info.platform}.zip`;
  const tmpZip = path.join(
    os.tmpdir(),
    `pixelcheck-headless-shell-${info.revision}-${process.pid}.zip`,
  );

  try {
    progress(
      `Downloading Chrome Headless Shell ${info.browserVersion} (v${info.revision}) ...`,
    );
    log.info({ url, dest: tmpZip }, "browser-install: downloading headless-shell");
    await downloadToFile(url, tmpZip);

    progress("Extracting (bypassing Playwright's extractor) ...");
    extractZip(tmpZip, info.installDir);

    if (process.platform !== "win32") {
      try {
        fs.chmodSync(info.executablePath, 0o755);
      } catch {
        // best-effort; unzip usually preserves the mode
      }
    }

    if (!fs.existsSync(info.executablePath)) {
      return {
        status: "error",
        message: `extraction finished but ${info.executablePath} is still missing`,
      };
    }
    progress(`Installed: ${info.executablePath}`);
    return {
      status: "installed",
      message: `headless-shell ${info.browserVersion} installed at ${info.executablePath}`,
      executablePath: info.executablePath,
    };
  } catch (err) {
    return {
      status: "error",
      message: `self-heal failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Fallback: `npx playwright install chromium-headless-shell`.",
    };
  } finally {
    try {
      fs.rmSync(tmpZip, { force: true });
    } catch {
      // ignore temp-file cleanup failures
    }
  }
}

/**
 * Does this launch error mean the browser executable is absent (vs. a real
 * runtime fault we should not paper over)?
 *
 * Playwright's message is stable across versions:
 *   "browserType.launch: Executable doesn't exist at <path>"
 * followed by the "Please run the following command to download new
 * browsers: npx playwright install" banner. We also match the
 * headless-shell path fragment so a future message reword still trips it.
 */
export function isMissingBrowserBinaryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Executable doesn't exist/i.test(msg) ||
    /chrome-headless-shell/i.test(msg) ||
    /playwright install/i.test(msg)
  );
}

/**
 * Test seam: lets unit tests inject a fake heal so the retry path can be
 * exercised without real network egress. Production code never sets this.
 */
let _healOverrideForTests: typeof ensureHeadlessShell | null = null;
export function _setEnsureHeadlessShellForTests(
  fn: typeof ensureHeadlessShell | null,
): void {
  _healOverrideForTests = fn;
}

/**
 * Launch a browser with one-shot self-heal.
 *
 * If the first attempt throws a "browser executable missing" error, download
 * the headless-shell directly (bypassing Playwright's extractor, which can
 * hang on some macOS hosts) and retry exactly once. Any OTHER error — or a
 * second failure — propagates unchanged so genuine faults are never masked.
 *
 * This closes the worst first-run papercut: `pixelcheck explore` / `run` and
 * every MCP primitive launch `chromium.launch({ headless: true })`, which on
 * a fresh machine crashes because the headless-shell was never downloaded.
 * Wrapping the launch makes those paths self-correct without the user first
 * having to discover `pixelcheck doctor --fix`.
 *
 * Headed launches (full Chromium) are NOT auto-healed here — that binary is
 * only needed for `--headed` runs; the retry will surface Playwright's own
 * "install chromium" message, and `pixelcheck install --headed` installs it.
 */
export async function launchWithBrowserAutoInstall<T>(
  launch: () => Promise<T>,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<T> {
  try {
    return await launch();
  } catch (err) {
    if (!isMissingBrowserBinaryError(err)) throw err;
    const progress =
      opts.onProgress ??
      ((line: string) => log.info({}, `browser-install: ${line}`));
    progress(
      "Browser binary missing — auto-installing Chrome Headless Shell (one-time) ...",
    );
    const heal = await (_healOverrideForTests ?? ensureHeadlessShell)({
      onProgress: progress,
    });
    if (heal.status !== "installed" && heal.status !== "already-present") {
      // Self-heal could not help (unsupported platform / download failure /
      // or the missing binary was full Chromium for a headed run). Re-throw
      // with both the heal outcome and the original launch error so the user
      // sees an actionable message instead of a bare Playwright stack.
      throw new Error(
        `Browser auto-install ${heal.status}: ${heal.message}\n` +
          `Original launch error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return await launch();
  }
}

/**
 * Install the FULL Chromium build (not headless-shell) via the bundled
 * playwright-core CLI, guaranteeing the revision matches the playwright the
 * package actually launches. Only needed for `--headed` runs; headless audits
 * use the headless-shell that {@link ensureHeadlessShell} provides.
 *
 * We route through the BUNDLED `playwright-core/cli.js` (resolved from this
 * package's node_modules) rather than a bare `npx playwright install`: npx
 * resolves whatever playwright version is latest on the registry, which can
 * pin a DIFFERENT chromium revision than the one we launch — the exact
 * version-skew trap that leaves a user "installed but still broken".
 */
export function installFullChromium(
  opts: { onProgress?: (line: string) => void } = {},
): HealResult {
  const progress = opts.onProgress ?? (() => {});
  try {
    const cliPath = path.join(
      path.dirname(esmRequire.resolve("playwright-core")),
      "cli.js",
    );
    if (!fs.existsSync(cliPath)) {
      return {
        status: "error",
        message:
          `playwright-core cli.js not found at ${cliPath} — ` +
          "run `npx playwright install chromium` manually.",
      };
    }
    progress(
      "Installing full Chromium via bundled Playwright (for --headed runs) ...",
    );
    execFileSync(process.execPath, [cliPath, "install", "chromium"], {
      stdio: "inherit",
    });
    return { status: "installed", message: "full Chromium installed" };
  } catch (err) {
    return {
      status: "error",
      message: `full Chromium install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
