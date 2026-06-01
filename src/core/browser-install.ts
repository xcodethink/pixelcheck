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
