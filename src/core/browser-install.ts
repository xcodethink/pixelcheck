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
 * Locate the ms-playwright browser cache root.
 *
 * An explicit `PLAYWRIGHT_BROWSERS_PATH` is the authoritative override per
 * Playwright's contract, so it wins outright (the `"0"` sentinel means
 * "browsers live in node_modules" — defer to executablePath() for that).
 * Checking it FIRST also keeps the resolution honest within a single
 * process: `pw.chromium.executablePath()` is resolved + cached by Playwright
 * at first use, so it would otherwise ignore a later env change (the source
 * of a doctor test-isolation flake). When the env var is unset we derive the
 * root from the full-Chromium executable path Playwright resolves (honors the
 * node_modules layout); failing that, the documented per-OS default.
 */
function browsersRoot(): string {
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath && envPath !== "0") return envPath;
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
    // fall through to per-OS default
  }
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

/**
 * Hosts the browser binary may be downloaded from. The CfT headless-shell URL
 * starts at `cdn.playwright.dev` and legitimately 307-redirects to the
 * Chrome-for-Testing Google Cloud Storage bucket; the Microsoft host is
 * Playwright's official mirror. Any redirect off this allowlist (e.g. a
 * compromised/poisoned CDN pointing at an attacker host) is refused so we never
 * unpack + execute a binary fetched from an untrusted origin.
 *
 * NOTE on integrity: the upstream CfT/Playwright CDNs do not publish per-file
 * cryptographic hashes that we could pin against, so we cannot do a true
 * checksum verification here. The guarantee is therefore "HTTPS + pinned
 * trusted origin + no third-party redirect + expected-size check" — the same
 * trust model Playwright's own installer relies on. (Audit 2026-06-02 A1/A2.)
 */
const TRUSTED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "cdn.playwright.dev",
  "storage.googleapis.com",
  "playwright.download.prss.microsoft.com",
]);

export function assertTrustedDownloadUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`refusing browser download: malformed URL ${rawUrl}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(
      `refusing browser download over insecure ${u.protocol} (${u.host}) — HTTPS required`,
    );
  }
  if (!TRUSTED_DOWNLOAD_HOSTS.has(u.hostname)) {
    throw new Error(
      `refusing browser download from untrusted host "${u.hostname}". ` +
        `Allowed: ${[...TRUSTED_DOWNLOAD_HOSTS].join(", ")}. ` +
        "If a redirect led here, the download origin may be compromised.",
    );
  }
  return u;
}

/**
 * Follow redirects and stream a URL to a destination file. Every hop (initial
 * URL + each redirect target) is validated against {@link assertTrustedDownloadUrl}
 * so the streamed-and-later-executed payload can only come from a pinned,
 * HTTPS, trusted origin. Verifies the byte count against Content-Length when the
 * server provides it.
 */
function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const visit = (current: string, redirectsLeft: number): void => {
      let validated: URL;
      try {
        validated = assertTrustedDownloadUrl(current);
      } catch (err) {
        reject(err);
        return;
      }
      https
        .get(validated, (res) => {
          const status = res.statusCode ?? 0;
          if (
            status >= 300 &&
            status < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            // Resolve relative redirects against the current (already-trusted)
            // URL; the next hop is re-validated at the top of visit().
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
          const expected = Number(res.headers["content-length"]) || 0;
          let written = 0;
          res.on("data", (chunk: Buffer) => {
            written += chunk.length;
          });
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on("finish", () =>
            out.close(() => {
              if (expected > 0 && written !== expected) {
                reject(
                  new Error(
                    `download size mismatch: expected ${expected} bytes, got ${written} (possible truncation/tampering)`,
                  ),
                );
                return;
              }
              resolve();
            }),
          );
          out.on("error", reject);
        })
        .on("error", reject);
    };
    visit(url, 5);
  });
}

/**
 * Extract a zip into a directory using the system archiver.
 *
 * Strategy by platform: Linux ships `unzip` but GNU `tar` cannot read zips, so
 * `unzip` is tried first; macOS and Windows 10+ ship bsdtar (`tar`) which DOES
 * read zips, used as the fallback when `unzip` is absent (Windows) or fails.
 * If neither is available we throw an actionable error rather than leaving a
 * half-extracted dir.
 *
 * Zip-slip: `unzip` skips `../` entries by default and bsdtar refuses absolute /
 * traversal paths; combined with the pinned trusted download origin
 * ({@link assertTrustedDownloadUrl}) the archive content is from Chrome-for-Testing,
 * not attacker-controlled, so path-traversal is not a reachable vector here.
 * (Audit 2026-06-02 A3/A4.)
 */
function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: "unzip", args: ["-o", "-q", zipPath, "-d", destDir] },
    { cmd: "tar", args: ["-xf", zipPath, "-C", destDir] },
  ];
  const errors: string[] = [];
  for (const { cmd, args } of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return;
    } catch (err) {
      errors.push(`${cmd}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `could not extract ${zipPath}: no working archiver found (${errors.join("; ")}). ` +
      "Install `unzip` (Linux) or ensure `tar`/bsdtar is on PATH.",
  );
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
        { cause: err },
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
