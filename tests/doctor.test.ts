/**
 * Unit tests for src/commands/doctor.ts.
 *
 * Covers: each individual DoctorCheck (status / message / remedy shape)
 * + aggregate report (exitCode, ordering) + renderDoctorReport (lines,
 * verbose mode, summary tail).
 *
 * Network check uses a project-internal mock (we don't want to hit
 * real api.anthropic.com from tests).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renderDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "../src/commands/doctor.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  delete process.env.NODE_EXTRA_CA_CERTS;
  // Override AUDIT_HOME (legacy alias for PIXELCHECK_HOME, still
  // backward-compat-resolved) so we don't touch the user's real
  // ~/.pixelcheck/ during tests.
  process.env.AUDIT_HOME = path.join(tmpRoot, "audit-home");
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
  delete process.env.AUDIT_HOME;
});

function findCheck(report: DoctorReport, name: string): DoctorCheck {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`Check not found: ${name}`);
  return c;
}

describe("runDoctor — individual checks", () => {
  it("Node.js version reports ok on the running interpreter (>= 18)", async () => {
    const r = await runDoctor({
      projectDir: tmpRoot,
      skipNetwork: true,
    });
    const c = findCheck(r, "Node.js version");
    expect(c.status).toBe("ok");
    expect(c.message).toMatch(/v\d+\.\d+/);
  });

  it("Platform reports ok on tier-1 OS", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "Platform");
    expect(["ok", "warn"]).toContain(c.status);
    expect(c.message).toContain(process.platform);
  });

  it("ANTHROPIC_API_KEY: fails when unset", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "ANTHROPIC_API_KEY");
    expect(c.status).toBe("fail");
    expect(c.remedy).toContain("console.anthropic.com");
  });

  it("ANTHROPIC_API_KEY: ok when set with sk-ant- prefix", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-test-1234567890abcdef";
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "ANTHROPIC_API_KEY");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("sk-ant-fake");
  });

  it("ANTHROPIC_API_KEY: warns when set with unusual prefix", async () => {
    process.env.ANTHROPIC_API_KEY = "ANT-fake-1234";
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "ANTHROPIC_API_KEY");
    expect(c.status).toBe("warn");
    expect(c.message).toContain("unusual");
  });

  it("config.yaml: warns when missing", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "config.yaml");
    expect(c.status).toBe("warn");
    expect(c.remedy).toContain("pixelcheck init");
  });

  it("config.yaml: ok when present", async () => {
    fs.writeFileSync(path.join(tmpRoot, "config.yaml"), "project_name: x");
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "config.yaml");
    expect(c.status).toBe("ok");
  });

  it("scenarios/ directory: warns when missing", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "scenarios/ directory");
    expect(c.status).toBe("warn");
  });

  it("scenarios/ directory: warns when empty", async () => {
    fs.mkdirSync(path.join(tmpRoot, "scenarios"));
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "scenarios/ directory");
    expect(c.status).toBe("warn");
    expect(c.message).toContain("no *.yaml");
  });

  it("scenarios/ directory: ok when contains yaml files", async () => {
    fs.mkdirSync(path.join(tmpRoot, "scenarios"));
    fs.writeFileSync(path.join(tmpRoot, "scenarios", "smoke.yaml"), "id: x");
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "scenarios/ directory");
    expect(c.status).toBe("ok");
    expect(c.message).toContain("1 scenario");
  });

  it("personas/ directory: skip when missing (built-in fallback)", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "personas/ directory");
    expect(c.status).toBe("skip");
    expect(c.message).toContain("built-in");
  });

  it("personas/ directory: ok when contains custom yaml", async () => {
    fs.mkdirSync(path.join(tmpRoot, "personas"));
    fs.writeFileSync(path.join(tmpRoot, "personas", "us-mobile.yaml"), "id: x");
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "personas/ directory");
    expect(c.status).toBe("ok");
  });

  it("Network proxy: skip when no env vars set", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "Network proxy");
    expect(c.status).toBe("skip");
    expect(c.message).toContain("direct connection");
  });

  it("Network proxy: ok when HTTPS_PROXY set", async () => {
    process.env.HTTPS_PROXY = "http://proxy.corp:8080";
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "Network proxy");
    expect(c.status).toBe("ok");
    expect(c.message).toContain("HTTPS_PROXY");
  });

  it("Data directory writable: ok when AUDIT_HOME is writable", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "Data directory writable");
    expect(c.status).toBe("ok");
    expect(c.message).toContain(tmpRoot);
  });

  it("api.anthropic.com reachable: skipped when --skip-network", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const c = findCheck(r, "api.anthropic.com reachable");
    expect(c.status).toBe("skip");
    expect(c.message).toContain("--skip-network");
  });

  it("Headless-shell binary: skipped when --skip-browser", async () => {
    const r = await runDoctor({
      projectDir: tmpRoot,
      skipNetwork: true,
      skipBrowser: true,
    });
    const c = findCheck(r, "Headless-shell binary");
    expect(c.status).toBe("skip");
    expect(c.message).toContain("--skip-browser");
  });

  it("Headless-shell binary: distinct check from full Chromium binary", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    // Both checks must be present and separate — the historical bug was that
    // only the full-Chromium check existed.
    const chromium = findCheck(r, "Chromium binary");
    const headless = findCheck(r, "Headless-shell binary");
    expect(chromium.name).not.toBe(headless.name);
    // Headless-shell is `fail` when missing (it breaks every audit), `ok`
    // when present. Full Chromium is `ok`/`skip` (only headed runs need it).
    expect(["ok", "fail"]).toContain(headless.status);
    // When missing, the remedy must point at the self-heal path.
    if (headless.status === "fail") {
      expect(headless.remedy).toMatch(/install|doctor --fix/);
    }
  });

  it("Headless-shell missing → FAIL + honest summary (clean-room repro)", async () => {
    // Point Playwright at an empty browser cache to simulate a fresh machine
    // where the headless-shell was never downloaded. This is the exact
    // first-run state that previously reported "[OK]"/"[WARN]" + an
    // "audits will work" summary while the first launch then crashed.
    const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), "pw-empty-"));
    const prev = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = emptyCache;
    try {
      const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
      const headless = findCheck(r, "Headless-shell binary");
      expect(headless.status).toBe("fail");
      expect(headless.remedy).toMatch(/install|doctor --fix/);

      // Full Chromium absence must NOT be a blocking signal (headless audits
      // don't need it).
      const chromium = findCheck(r, "Chromium binary");
      expect(chromium.status).toBe("skip");

      // The aggregate must be blocking, and the rendered summary must NOT
      // claim audits will work — the core lie this fix removes.
      expect(r.exitCode).toBe(1);
      const summary = renderDoctorReport(r).join("\n");
      expect(summary).not.toMatch(/audits will work/i);
      expect(summary).toMatch(/blocking failure/i);
    } finally {
      if (prev === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = prev;
      fs.rmSync(emptyCache, { recursive: true, force: true });
    }
  });
});

describe("runDoctor — aggregate exitCode", () => {
  it("exitCode 1 when ANTHROPIC_API_KEY missing (fail)", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    expect(r.exitCode).toBe(1);
  });

  it("exitCode 0 when no fails (warnings allowed)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-1234";
    fs.writeFileSync(path.join(tmpRoot, "config.yaml"), "project_name: x");
    fs.mkdirSync(path.join(tmpRoot, "scenarios"));
    fs.writeFileSync(path.join(tmpRoot, "scenarios", "smoke.yaml"), "id: x");
    const r = await runDoctor({
      projectDir: tmpRoot,
      skipNetwork: true,
      skipBrowser: true,
    });
    expect(r.exitCode).toBe(0);
  });
});

describe("renderDoctorReport", () => {
  it("includes [OK] / [WARN] / [FAIL] glyph + name + message per check", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const lines = renderDoctorReport(r);
    const apiLine = lines.find((l) => l.includes("ANTHROPIC_API_KEY"));
    expect(apiLine).toBeTruthy();
    expect(apiLine!).toContain("[FAIL]");
    expect(apiLine!).toContain("not set");
  });

  it("includes the remedy on the next line for fail / warn checks", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const lines = renderDoctorReport(r);
    const idx = lines.findIndex((l) => l.includes("ANTHROPIC_API_KEY"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lines[idx + 1]).toContain("→");
    expect(lines[idx + 1]).toContain("console.anthropic.com");
  });

  it("includes detail line when --verbose AND check has detail", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-test-12345";
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const lines = renderDoctorReport(r, { verbose: true });
    const apiIdx = lines.findIndex((l) => l.includes("ANTHROPIC_API_KEY"));
    expect(lines[apiIdx + 1]).toContain("sk-ant-fake");
  });

  it("does NOT include detail line without --verbose", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-test-12345";
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const lines = renderDoctorReport(r); // no verbose
    expect(lines.find((l) => l.includes("sk-ant-fake"))).toBeUndefined();
  });

  it("ends with summary: '0 blocking failure(s)' when fails exist", async () => {
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const lines = renderDoctorReport(r);
    const tail = lines[lines.length - 1]!;
    expect(tail).toMatch(/blocking failure/);
  });

  it("ends with 'All checks passed' when nothing fails / warns", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-1234";
    fs.writeFileSync(path.join(tmpRoot, "config.yaml"), "project_name: x");
    fs.mkdirSync(path.join(tmpRoot, "scenarios"));
    fs.writeFileSync(path.join(tmpRoot, "scenarios", "smoke.yaml"), "id: x");
    const r = await runDoctor({
      projectDir: tmpRoot,
      skipNetwork: true,
      skipBrowser: true,
    });
    const lines = renderDoctorReport(r);
    expect(lines[lines.length - 1]).toContain("All checks passed");
  });
});

// ─────────────────────────────────────────────────────────────
// Edge cases — env values that surprise the heuristic
// ─────────────────────────────────────────────────────────────

describe("runDoctor — edge cases", () => {
  it("ANTHROPIC_API_KEY: warns when set to whitespace / garbage prefix", async () => {
    process.env.ANTHROPIC_API_KEY = "garbage-not-a-real-prefix";
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const apiKey = r.checks.find((c) => c.name === "ANTHROPIC_API_KEY")!;
    expect(apiKey.status).toBe("warn");
    expect(apiKey.message).toMatch(/format looks unusual/);
    expect(apiKey.remedy).toMatch(/console\.anthropic\.com/);
  });

  it("ANTHROPIC_API_KEY: includes only first 12 chars in detail (privacy)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-DONT-LEAK-IN-DETAIL";
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const apiKey = r.checks.find((c) => c.name === "ANTHROPIC_API_KEY")!;
    expect(apiKey.status).toBe("ok");
    expect(apiKey.detail).toMatch(/sk-ant-secre/);
    // Sensitive tail should NOT appear
    expect(apiKey.detail ?? "").not.toContain("DONT-LEAK");
  });

  it("Network proxy: lists HTTPS_PROXY when set", async () => {
    process.env.HTTPS_PROXY = "http://proxy.corp:8080";
    try {
      const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
      const proxy = r.checks.find((c) => c.name === "Network proxy")!;
      expect(proxy.status).toBe("ok");
      expect(proxy.message).toContain("HTTPS_PROXY=http://proxy.corp:8080");
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it("Network proxy: combines HTTPS_PROXY + NO_PROXY + NODE_EXTRA_CA_CERTS", async () => {
    process.env.HTTPS_PROXY = "http://proxy:3128";
    process.env.NO_PROXY = "localhost,127.0.0.1";
    process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/corp-ca.pem";
    try {
      const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
      const proxy = r.checks.find((c) => c.name === "Network proxy")!;
      expect(proxy.status).toBe("ok");
      expect(proxy.message).toContain("HTTPS_PROXY=");
      expect(proxy.message).toContain("NO_PROXY=");
      expect(proxy.message).toContain("NODE_EXTRA_CA_CERTS=");
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  it("Network proxy: lowercase https_proxy alias is also recognised", async () => {
    process.env.https_proxy = "http://lowercase-proxy:8080";
    try {
      const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
      const proxy = r.checks.find((c) => c.name === "Network proxy")!;
      expect(proxy.status).toBe("ok");
      expect(proxy.message).toContain("lowercase-proxy");
    } finally {
      delete process.env.https_proxy;
    }
  });

  it("scenarios/ directory: ok when contains many yaml files", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    fs.mkdirSync(path.join(tmpRoot, "scenarios"));
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(
        path.join(tmpRoot, "scenarios", `s${i}.yaml`),
        `id: s${i}`,
      );
    }
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const scenarios = r.checks.find((c) => c.name === "scenarios/ directory")!;
    expect(scenarios.status).toBe("ok");
    expect(scenarios.message).toMatch(/7 scenario file/);
  });

  it("personas/ directory: skip when present-but-empty", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    fs.mkdirSync(path.join(tmpRoot, "personas"));
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const personas = r.checks.find((c) => c.name === "personas/ directory")!;
    expect(personas.status).toBe("skip");
    expect(personas.message).toMatch(/built-in personas/);
  });

  it("scenarios/ directory: ignores non-yaml files", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    fs.mkdirSync(path.join(tmpRoot, "scenarios"));
    fs.writeFileSync(path.join(tmpRoot, "scenarios", "README.md"), "x");
    fs.writeFileSync(path.join(tmpRoot, "scenarios", "smoke.json"), "{}");
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const scenarios = r.checks.find((c) => c.name === "scenarios/ directory")!;
    expect(scenarios.status).toBe("warn");
    expect(scenarios.message).toMatch(/no \*\.yaml/);
  });

  it("AUDIT_HOME: respects override (data directory writable check uses it)", async () => {
    const auditHome = path.join(tmpRoot, "custom-audit-home");
    process.env.AUDIT_HOME = auditHome;
    try {
      const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
      const dataDir = r.checks.find((c) => c.name === "Data directory writable")!;
      expect(dataDir.status).toBe("ok");
      expect(dataDir.message).toContain(auditHome);
    } finally {
      delete process.env.AUDIT_HOME;
    }
  });

  it("Data directory writable: fails gracefully when AUDIT_HOME is unwritable", async () => {
    // Create a read-only file at the AUDIT_HOME path so mkdir fails
    const blocker = path.join(tmpRoot, "blocker-file");
    fs.writeFileSync(blocker, "x");
    process.env.AUDIT_HOME = blocker; // file in place of dir → mkdir fails
    try {
      const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
      const dataDir = r.checks.find((c) => c.name === "Data directory writable")!;
      expect(dataDir.status).toBe("fail");
      expect(dataDir.remedy).toMatch(/AUDIT_HOME|writable path|permissions/);
    } finally {
      delete process.env.AUDIT_HOME;
      fs.unlinkSync(blocker);
    }
  });

  it("renderDoctorReport summary shows fail count when failures present", async () => {
    delete process.env.ANTHROPIC_API_KEY; // forces 1 fail
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const lines = renderDoctorReport(r);
    const tail = lines.slice(-3).join("\n");
    expect(tail).toMatch(/blocking failure/);
  });

  it("renderDoctorReport ends with 'All checks passed' on a clean project", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-1234";
    fs.writeFileSync(path.join(tmpRoot, "config.yaml"), "project_name: x");
    fs.mkdirSync(path.join(tmpRoot, "scenarios"));
    fs.writeFileSync(path.join(tmpRoot, "scenarios", "smoke.yaml"), "id: x");
    fs.mkdirSync(path.join(tmpRoot, "personas"));
    fs.writeFileSync(path.join(tmpRoot, "personas", "p.yaml"), "id: p");
    const r = await runDoctor({
      projectDir: tmpRoot,
      skipNetwork: true,
      skipBrowser: true,
    });
    const lines = renderDoctorReport(r);
    expect(lines[lines.length - 1]).toContain("All checks passed");
  });
});
