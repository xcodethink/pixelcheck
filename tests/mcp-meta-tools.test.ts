import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock the doctor command so the MCP wrapper is tested in isolation (no real
// Node/browser/network probing).
vi.mock("../src/commands/doctor.js", () => ({
  runDoctor: vi.fn(),
  renderDoctorReport: vi.fn(),
}));

import { doctorTool } from "../src/mcp/tools/doctor.js";
import { getLastReportTool } from "../src/mcp/tools/get-last-report.js";
import { runDoctor, renderDoctorReport } from "../src/commands/doctor.js";

const mockRunDoctor = vi.mocked(runDoctor);
const mockRender = vi.mocked(renderDoctorReport);

describe("MCP meta tool: get_last_report (G3 / B3 path sandbox)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("rejects a reports_root outside the project / home (absolute escape)", async () => {
    const outside = path.join(path.parse(process.cwd()).root, "etc");
    await expect(getLastReportTool.handler({ reports_root: outside })).rejects.toThrow(
      /outside the allowed locations/,
    );
  });

  it("rejects a relative path that traverses above the project root", async () => {
    await expect(
      getLastReportTool.handler({ reports_root: "./reports/../../../../.." }),
    ).rejects.toThrow(/outside the allowed locations/);
  });

  it("accepts a reports dir inside the project and reports an empty history", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".g3-reports-"));
    created.push(dir);
    const res = await getLastReportTool.handler({ reports_root: dir });
    expect(res.content[0]!.text).toBe("no audits found in history");
    expect(res.isError).toBeUndefined();
  });

  it("declares itself a zero-cost, no-browser, fs-reads meta tool", () => {
    expect(getLastReportTool.kind).toBe("meta");
    expect(getLastReportTool.requires.browser).toBe(false);
    expect(getLastReportTool.costEstimateUsd.max).toBe(0);
    expect(getLastReportTool.sideEffects).toContain("fs_reads");
  });
});

describe("MCP meta tool: doctor (G3)", () => {
  beforeEach(() => {
    mockRunDoctor.mockReset();
    mockRender.mockReset();
    mockRender.mockReturnValue(["[OK] Node", "[OK] API key"]);
  });

  it("passes fix/skip_network flags through to runDoctor", async () => {
    mockRunDoctor.mockResolvedValue({ checks: [], exitCode: 0 });
    await doctorTool.handler({ fix: true, skip_network: true });
    expect(mockRunDoctor).toHaveBeenCalledTimes(1);
    const opts = mockRunDoctor.mock.calls[0]![0]!;
    expect(opts.fix).toBe(true);
    expect(opts.skipNetwork).toBe(true);
    expect(typeof opts.onFixProgress).toBe("function");
  });

  it("defaults fix/skip_network to false when omitted", async () => {
    mockRunDoctor.mockResolvedValue({ checks: [], exitCode: 0 });
    await doctorTool.handler({});
    const opts = mockRunDoctor.mock.calls[0]![0]!;
    expect(opts.fix).toBe(false);
    expect(opts.skipNetwork).toBe(false);
  });

  it("renders the report body and appends the exitCode line", async () => {
    mockRunDoctor.mockResolvedValue({ checks: [], exitCode: 0 });
    const res = await doctorTool.handler({});
    expect(res.content[0]!.text).toContain("[OK] Node");
    expect(res.content[0]!.text).toContain("exitCode: 0 (0 = ready, 1 = blocking failure)");
  });

  it("surfaces fix progress lines emitted via onFixProgress, ahead of the report", async () => {
    mockRunDoctor.mockImplementation(async (opts) => {
      opts?.onFixProgress?.("downloading browser...");
      opts?.onFixProgress?.("done");
      return { checks: [], exitCode: 1 };
    });
    const body = (await doctorTool.handler({ fix: true })).content[0]!.text;
    expect(body).toContain("downloading browser...");
    expect(body).toContain("done");
    expect(body).toContain("exitCode: 1");
    // progress precedes the rendered report
    expect(body.indexOf("downloading browser...")).toBeLessThan(body.indexOf("[OK] Node"));
  });
});
