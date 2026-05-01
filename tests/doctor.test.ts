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
  // Override AUDIT_HOME so we don't touch the user's real
  // ~/.ai-browser-auditor/ during tests.
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
    expect(c.remedy).toContain("ai-audit init");
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
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
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
    const r = await runDoctor({ projectDir: tmpRoot, skipNetwork: true });
    const lines = renderDoctorReport(r);
    expect(lines[lines.length - 1]).toContain("All checks passed");
  });
});
