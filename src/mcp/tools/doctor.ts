/**
 * `doctor` — diagnose (and optionally self-heal) the pixelcheck environment.
 *
 * Lets an MCP client (Claude Code, Cursor, Cline, ...) check Node / API key /
 * browser-binary readiness BEFORE calling a browser tool — and, with
 * `{ fix: true }`, download a missing Chrome Headless Shell directly. This
 * closes the loop where an agent registers the MCP server, calls `see`/`judge`,
 * and hits a raw "Executable doesn't exist" crash with no recourse from inside
 * the agent. Now the agent can call `doctor { fix: true }` and continue.
 *
 * No browser launch, no LLM call. Safe to call without any API keys (it simply
 * reports ANTHROPIC_API_KEY as missing).
 */

import { runDoctor, renderDoctorReport } from "../../commands/doctor.js";
import { textResult, type ToolResult } from "../result.js";
import type { ToolDefinition } from "../registry.js";

const inputSchema = {
  type: "object",
  properties: {
    fix: {
      type: "boolean",
      description:
        "Attempt to self-heal a missing browser binary by downloading it directly (bypasses Playwright's extractor).",
    },
    skip_network: {
      type: "boolean",
      description: "Skip the api.anthropic.com reachability check (offline / air-gapped).",
    },
  },
};

async function handler(args: Record<string, unknown>): Promise<ToolResult> {
  const fix = args.fix === true;
  const skipNetwork = args.skip_network === true;
  const progress: string[] = [];
  const report = await runDoctor({
    fix,
    skipNetwork,
    onFixProgress: (line) => progress.push(line),
  });
  const body = [
    ...(progress.length > 0 ? [...progress, ""] : []),
    ...renderDoctorReport(report),
    "",
    `exitCode: ${report.exitCode} (0 = ready, 1 = blocking failure)`,
  ].join("\n");
  return textResult(body);
}

export const doctorTool: ToolDefinition = {
  name: "doctor",
  description:
    "Diagnose the pixelcheck environment (Node, API key, browser binary, network). " +
    "Pass { fix: true } to download a missing browser binary. Call this first if a browser tool fails to launch.",
  kind: "meta",
  cacheable: false,
  costEstimateUsd: { typical: 0, min: 0, max: 0, unit: "per_call" },
  // Reads the browser cache + config. The reachability ping and (with fix)
  // the browser download ARE network, but `network_egress` in this taxonomy
  // specifically means "calls an LLM provider" (it must agree with a non-empty
  // apiKeys requirement) — which doctor does not do.
  sideEffects: ["fs_reads"],
  requires: { apiKeys: [], browser: false },
  inputSchema,
  handler,
};
