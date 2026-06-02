/**
 * `pixelcheck doctor` — diagnose the local environment before audit run.
 *
 * Why this exists (T23 closes RISK-REGISTER R45 + R47 + R61):
 * Pre-T23 a user with a missing ANTHROPIC_API_KEY / wrong Node version
 * / unreachable api.anthropic.com saw a stack trace at first audit
 * attempt. `doctor` runs all health checks UP FRONT so the user sees
 * a single structured "what's broken / what to do" report.
 *
 * Categories:
 *   - Runtime: Node / npm / OS / arch
 *   - Config: ANTHROPIC_API_KEY / config.yaml / scenarios/ / personas/
 *   - Network: HTTPS_PROXY / NODE_EXTRA_CA_CERTS / api.anthropic.com reachable
 *   - Disk: ~/.pixelcheck/ writable + free space
 *
 * Each check returns one of: ok / warn / fail / skip. Doctor exits 0 if
 * no `fail` checks (warnings allowed); 1 if any `fail`.
 *
 * Verbose mode (--verbose) adds detailed diagnostic context (full env
 * var values via secrets.ts redaction, full path resolution, etc).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { request } from "node:https";
import { URL } from "node:url";
import { pixelcheckHome } from "../core/home-dir.js";
import {
  resolveHeadlessShell,
  ensureHeadlessShell,
} from "../core/browser-install.js";

const esmRequire = createRequire(import.meta.url);

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  /** Verbose diagnostic detail (printed only with --verbose). */
  detail?: string;
  /** What to do if status is `fail` or `warn`. */
  remedy?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Aggregate exit code: 0 if no `fail`, 1 if any. */
  exitCode: 0 | 1;
}

export interface DoctorOptions {
  verbose?: boolean;
  /** Skip network-dependent checks (CI / offline / air-gapped). */
  skipNetwork?: boolean;
  /** Skip the Playwright Chromium binary check. CI runners on the unit
   * matrix don't pre-install chromium (integration.yml does). End users
   * see this check on every `pixelcheck doctor` invocation. */
  skipBrowser?: boolean;
  /** Where to look for project config / scenarios / personas. Defaults to cwd. */
  projectDir?: string;
  /**
   * Attempt to self-heal a missing headless-shell binary by downloading it
   * (bypassing Playwright's bundled extractor, which can hang on some hosts).
   * Wired to `pixelcheck doctor --fix`.
   */
  fix?: boolean;
  /** Sink for self-heal progress lines (defaults to no-op). */
  onFixProgress?: (line: string) => void;
}

// ─────────────────────────────────────────────────────────────
// Individual checks
// ─────────────────────────────────────────────────────────────

function checkNodeVersion(): DoctorCheck {
  const v = process.versions.node;
  const major = parseInt(v.split(".")[0]!, 10);
  if (major >= 18) {
    return {
      name: "Node.js version",
      status: "ok",
      message: `v${v} (>= 18 required)`,
    };
  }
  return {
    name: "Node.js version",
    status: "fail",
    message: `v${v} is unsupported`,
    remedy:
      "Upgrade to Node.js 18+ (LTS recommended). See docs/INSTALLATION.md.",
  };
}

function checkPlatform(): DoctorCheck {
  const supported = ["darwin", "linux", "win32"];
  const platform = process.platform;
  const arch = process.arch;
  if (supported.includes(platform)) {
    return {
      name: "Platform",
      status: "ok",
      message: `${platform} ${arch}`,
    };
  }
  return {
    name: "Platform",
    status: "warn",
    message: `${platform} ${arch} not in tested matrix`,
    remedy:
      "Tier-1 platforms: macOS / Linux / Windows. See docs/INSTALLATION.md.",
  };
}

function checkApiKey(): DoctorCheck {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      name: "ANTHROPIC_API_KEY",
      status: "fail",
      message: "not set",
      remedy:
        "Get a key at https://console.anthropic.com → Set " +
        "ANTHROPIC_API_KEY=sk-ant-... in your shell or .env file.",
    };
  }
  if (!key.startsWith("sk-ant-")) {
    return {
      name: "ANTHROPIC_API_KEY",
      status: "warn",
      message: "set, but format looks unusual (expected sk-ant-...)",
      detail: `Key starts with: ${key.slice(0, 8)}...`,
      remedy:
        "Verify your key at https://console.anthropic.com/settings/keys.",
    };
  }
  return {
    name: "ANTHROPIC_API_KEY",
    status: "ok",
    message: "set",
    detail: `${key.slice(0, 12)}... (${key.length} chars)`,
  };
}

function checkConfigYaml(projectDir: string): DoctorCheck {
  const configPath = path.join(projectDir, "config.yaml");
  if (fs.existsSync(configPath)) {
    return {
      name: "config.yaml",
      status: "ok",
      message: `found at ${configPath}`,
    };
  }
  return {
    name: "config.yaml",
    status: "warn",
    message: "not found",
    remedy: "Run `pixelcheck init` to scaffold a new project.",
  };
}

function checkScenariosDir(projectDir: string): DoctorCheck {
  const scenariosDir = path.join(projectDir, "scenarios");
  if (!fs.existsSync(scenariosDir)) {
    return {
      name: "scenarios/ directory",
      status: "warn",
      message: "not found",
      remedy:
        "Create scenarios/ with at least one *.yaml. Run `pixelcheck init` to scaffold.",
    };
  }
  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".yaml"));
  if (files.length === 0) {
    return {
      name: "scenarios/ directory",
      status: "warn",
      message: "exists but contains no *.yaml files",
      remedy: "Add at least one scenario .yaml file.",
    };
  }
  return {
    name: "scenarios/ directory",
    status: "ok",
    message: `${files.length} scenario file(s)`,
  };
}

function checkPersonasDir(projectDir: string): DoctorCheck {
  const personasDir = path.join(projectDir, "personas");
  if (!fs.existsSync(personasDir)) {
    return {
      name: "personas/ directory",
      status: "skip",
      message: "not found (built-in personas will be used)",
    };
  }
  const files = fs.readdirSync(personasDir).filter((f) => f.endsWith(".yaml"));
  return {
    name: "personas/ directory",
    status: files.length > 0 ? "ok" : "skip",
    message:
      files.length > 0
        ? `${files.length} custom persona file(s)`
        : "exists but empty (built-in personas will be used)",
  };
}

function checkProxyConfig(): DoctorCheck {
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  const ca = process.env.NODE_EXTRA_CA_CERTS;

  const parts: string[] = [];
  if (httpsProxy) parts.push(`HTTPS_PROXY=${httpsProxy}`);
  if (noProxy) parts.push(`NO_PROXY=${noProxy}`);
  if (ca) parts.push(`NODE_EXTRA_CA_CERTS=${ca}`);

  if (parts.length === 0) {
    return {
      name: "Network proxy",
      status: "skip",
      message: "no proxy env vars set (direct connection)",
    };
  }
  return {
    name: "Network proxy",
    status: "ok",
    message: parts.join(" · "),
  };
}

async function checkAnthropicReachable(): Promise<DoctorCheck> {
  const url = "https://api.anthropic.com/v1/messages";
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = request(
      {
        method: "HEAD",
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        timeout: 5000,
      },
      (res) => {
        // Any HTTP response (even 401 / 405 from HEAD on /messages) means
        // we reached the server.
        resolve({
          name: "api.anthropic.com reachable",
          status: "ok",
          message: `HTTP ${res.statusCode}`,
          detail: `Server response: ${res.statusCode} ${res.statusMessage ?? ""}`,
        });
        res.resume();
      },
    );
    req.on("error", (err) => {
      resolve({
        name: "api.anthropic.com reachable",
        status: "fail",
        message: `unreachable: ${err.message}`,
        remedy:
          "Check your firewall / proxy config. See docs/INSTALLATION.md " +
          "for HTTPS_PROXY / NODE_EXTRA_CA_CERTS setup.",
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({
        name: "api.anthropic.com reachable",
        status: "fail",
        message: "timed out after 5s",
        remedy: "Check network / firewall rules.",
      });
    });
    req.end();
  });
}

function checkDataDirWritable(): DoctorCheck {
  const dir = pixelcheckHome();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".doctor-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return {
      name: "Data directory writable",
      status: "ok",
      message: dir,
    };
  } catch (err) {
    return {
      name: "Data directory writable",
      status: "fail",
      message: `${dir}: ${err instanceof Error ? err.message : String(err)}`,
      remedy:
        "Set PIXELCHECK_HOME to a writable path, or fix permissions on " + dir,
    };
  }
}

/**
 * Free disk space at the data directory root. A typical 5-unit audit run
 * writes ~25-50 MB of artifacts (screenshots + DOM dumps + LLM responses).
 * Warn at < 500 MB free, fail at < 100 MB.
 */
function checkDiskSpace(): DoctorCheck {
  const dir = pixelcheckHome();
  // Ensure dir exists so statfs works. Defensive: not all platforms ship
  // a sync `statfs` API; node 18+ has fs.statfsSync but we wrap in
  // try/catch and degrade to "skip" so the check never fails the run
  // for an OS quirk.
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Surfaced separately by checkDataDirWritable — not our concern here.
  }
  try {
    // statfsSync added in Node 18.15 — feature-detect in case of older runtime
    const statfsSync = (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint; bsize: number } }).statfsSync;
    if (typeof statfsSync !== "function") {
      return {
        name: "Disk space",
        status: "skip",
        message: "fs.statfsSync unavailable on this Node build",
      };
    }
    const stat = statfsSync(dir);
    const freeBytes = Number(stat.bavail) * stat.bsize;
    const freeMb = Math.round(freeBytes / (1024 * 1024));
    if (freeMb < 100) {
      return {
        name: "Disk space",
        status: "fail",
        message: `${freeMb} MB free at ${dir} — below 100 MB minimum`,
        remedy:
          "Free disk space: clean reports/ + cache via `pixelcheck prune`, " +
          "or move PIXELCHECK_HOME to a larger volume.",
      };
    }
    if (freeMb < 500) {
      return {
        name: "Disk space",
        status: "warn",
        message: `${freeMb} MB free at ${dir} — below 500 MB recommended`,
        remedy:
          "A 5-unit audit can write ~25-50 MB. Consider freeing space.",
        detail: `Path: ${dir}`,
      };
    }
    return {
      name: "Disk space",
      status: "ok",
      message: freeMb >= 1024
        ? `${(freeMb / 1024).toFixed(1)} GB free at ${dir}`
        : `${freeMb} MB free at ${dir}`,
    };
  } catch (err) {
    return {
      name: "Disk space",
      status: "skip",
      message: `cannot stat ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verify Playwright's Chromium binary is downloaded. Without this, the
 * first browser launch errors out with a long stack trace; the user has
 * to run `npx playwright install chromium` to fix it. Catching it in
 * doctor turns a 30-second debugging session into a 1-line remedy.
 */
function checkChromiumBinary(): DoctorCheck {
  // Playwright's chromium download path follows a stable pattern:
  //   ~/Library/Caches/ms-playwright/chromium-* on macOS
  //   ~/.cache/ms-playwright/chromium-* on Linux
  //   %USERPROFILE%/AppData/Local/ms-playwright/chromium-* on Windows
  // (or PLAYWRIGHT_BROWSERS_PATH if set)
  // The cleanest check is to import playwright and look up its registered
  // executable path — this works regardless of platform / cache location.
  // Defensive: if playwright isn't installable for some reason we don't
  // want doctor to crash; fall back to "skip".
  try {
    type PlaywrightModule = { chromium: { executablePath?: () => string } };
    const playwright = esmRequire("playwright") as PlaywrightModule;
    const exe = playwright.chromium.executablePath?.();
    if (!exe) {
      return {
        name: "Chromium binary",
        status: "warn",
        message: "Playwright did not return an executable path",
        remedy:
        "Only needed for `--headed` runs — headless audits use the " +
        "headless-shell. Install with `pixelcheck install --headed`.",
      };
    }
    if (!fs.existsSync(exe)) {
      // SKIP, not warn: full Chromium is only needed for `--headed` runs.
      // Every default (headless) audit uses the headless-shell, checked
      // separately below. Surfacing this as a warning made a correctly
      // headless-ready environment look not-fully-green and (pre-fix)
      // pointed users at a bare `npx playwright install chromium` that pulls
      // a DIFFERENT revision than we launch. `skip` keeps the report honest:
      // nothing is broken for the common path.
      return {
        name: "Chromium binary",
        status: "skip",
        message:
          "full Chromium not installed (only needed for `--headed` runs; " +
          "`pixelcheck install --headed` adds it)",
        detail: `Would launch from: ${exe}`,
      };
    }
    return {
      name: "Chromium binary",
      status: "ok",
      message: "Playwright Chromium found",
      detail: `Path: ${exe}`,
    };
  } catch (err) {
    return {
      name: "Chromium binary",
      status: "skip",
      message: `playwright module not loadable: ${err instanceof Error ? err.message : String(err)}`,
      remedy:
        "If a later `pixelcheck run` fails to launch a browser, run " +
        "`pixelcheck install` or `pixelcheck doctor --fix`.",
    };
  }
}

/**
 * Verify Playwright's *headless-shell* binary is downloaded. This is a
 * SEPARATE artifact from the full Chromium build checked above:
 * `chromium.launch({ headless: true })` — which every pixelcheck primitive
 * uses — runs `chromium_headless_shell-<rev>/.../chrome-headless-shell`, not
 * the full Chromium. Before this check, doctor could report "[OK] Chromium
 * binary" while `see`/`judge`/`act` still crashed at launch.
 *
 * The standard remedy (`npx playwright install chromium-headless-shell`) can
 * hang on some macOS hosts while extracting, so the remedy also points at
 * `pixelcheck doctor --fix`, which downloads + unpacks directly.
 */
function checkHeadlessShellBinary(): DoctorCheck {
  let info: ReturnType<typeof resolveHeadlessShell>;
  try {
    info = resolveHeadlessShell();
  } catch (err) {
    return {
      name: "Headless-shell binary",
      status: "skip",
      message: `could not resolve headless-shell path: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!info) {
    return {
      name: "Headless-shell binary",
      status: "skip",
      message: "playwright-core browsers.json not readable",
      remedy:
        "If `see`/`judge` later fail to launch, run " +
        "`pixelcheck doctor --fix` or `npx playwright install chromium-headless-shell`.",
    };
  }
  if (info.present) {
    return {
      name: "Headless-shell binary",
      status: "ok",
      message: `Chrome Headless Shell ${info.browserVersion || `v${info.revision}`} found`,
      detail: `Path: ${info.executablePath}`,
    };
  }
  // FAIL, not warn: every pixelcheck primitive launches
  // `chromium.launch({ headless: true })`, so a missing headless-shell means
  // `run` / `explore` / all MCP browser tools crash. Reporting this as a
  // non-blocking warning (with an "audits will work" summary) was the single
  // most misleading first-run signal — it told users everything was fine
  // right before the first launch threw. The remedy is one command.
  return {
    name: "Headless-shell binary",
    status: "fail",
    message: `missing: ${info.executablePath}`,
    detail: `Playwright headless-shell v${info.revision} (${info.browserVersion || "unknown version"})`,
    remedy:
      "Run `pixelcheck install` (or `pixelcheck doctor --fix`) to download it " +
      "directly — bypasses Playwright's extractor, which can hang on macOS.",
  };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Run all doctor checks. Returns a structured report including aggregate
 * exit code. Does NOT print — caller controls output via {@link renderDoctorReport}.
 */
export async function runDoctor(
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const projectDir = opts.projectDir ?? process.cwd();
  const checks: DoctorCheck[] = [];

  // Synchronous checks
  checks.push(checkNodeVersion());
  checks.push(checkPlatform());
  checks.push(checkApiKey());
  checks.push(checkConfigYaml(projectDir));
  checks.push(checkScenariosDir(projectDir));
  checks.push(checkPersonasDir(projectDir));
  checks.push(checkProxyConfig());
  checks.push(checkDataDirWritable());
  checks.push(checkDiskSpace());
  if (!opts.skipBrowser) {
    checks.push(checkChromiumBinary());
    let headlessCheck = checkHeadlessShellBinary();
    // Self-heal: if --fix is set and the headless-shell binary is missing
    // (now a `fail`), download it directly (bypassing Playwright's extractor)
    // and re-check.
    if (opts.fix && headlessCheck.status === "fail") {
      const progress = opts.onFixProgress ?? (() => {});
      progress("Headless-shell missing — attempting self-heal...");
      const heal = await ensureHeadlessShell({ onProgress: progress });
      if (heal.status === "installed" || heal.status === "already-present") {
        headlessCheck = checkHeadlessShellBinary();
      } else {
        headlessCheck = {
          ...headlessCheck,
          message: `${headlessCheck.message} — self-heal ${heal.status}`,
          remedy: heal.message,
        };
      }
    }
    checks.push(headlessCheck);
  } else {
    checks.push({
      name: "Chromium binary",
      status: "skip",
      message: "skipped (--skip-browser)",
    });
    checks.push({
      name: "Headless-shell binary",
      status: "skip",
      message: "skipped (--skip-browser)",
    });
  }

  // Network check (skipped offline / when explicitly disabled)
  if (!opts.skipNetwork) {
    checks.push(await checkAnthropicReachable());
  } else {
    checks.push({
      name: "api.anthropic.com reachable",
      status: "skip",
      message: "skipped (--skip-network)",
    });
  }

  const exitCode: 0 | 1 = checks.some((c) => c.status === "fail") ? 1 : 0;
  return { checks, exitCode };
}

const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: "[OK]   ",
  warn: "[WARN] ",
  fail: "[FAIL] ",
  skip: "[SKIP] ",
};

/**
 * Render a DoctorReport as human-readable lines for terminal output.
 * Returns an array of strings (one per line) so the caller can log them
 * however they like (chalk colors / structured logging / etc).
 */
export function renderDoctorReport(
  report: DoctorReport,
  opts: { verbose?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${STATUS_GLYPH[c.status]}${c.name}: ${c.message}`);
    if (opts.verbose && c.detail) {
      lines.push(`         ${c.detail}`);
    }
    if (c.status === "fail" || c.status === "warn") {
      if (c.remedy) {
        lines.push(`         → ${c.remedy}`);
      }
    }
  }

  const failCount = report.checks.filter((c) => c.status === "fail").length;
  const warnCount = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  if (failCount === 0 && warnCount === 0) {
    lines.push("All checks passed. You're ready to run `pixelcheck run`.");
  } else if (failCount === 0) {
    lines.push(
      `${warnCount} warning(s) — review the remedies above. ` +
        "Headless audits are ready to run.",
    );
  } else {
    lines.push(
      `${failCount} blocking failure(s); fix the [FAIL] items above before ` +
        "running an audit. For a missing browser, run `pixelcheck install`.",
    );
  }
  return lines;
}
