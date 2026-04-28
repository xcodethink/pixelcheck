/**
 * End-to-end concurrency proofs for the MCP server (M9-3 follow-up).
 *
 * Two angles:
 *
 *   1. In-process simulation of the MCP dispatcher path. We replay the same
 *      `withCostRun(async () => { ...handler... })` shape the real server
 *      uses, but drive it with 8 concurrent calls that each do multiple
 *      cost-guard `recordUsage` invocations interleaved via setImmediate.
 *      Per-scope final snapshot must equal only that scope's contributions.
 *
 *   2. Real spawned MCP server stdio. Sends 5 parallel `list_personas`
 *      calls down a single server's stdin; verifies all 5 responses come
 *      back successfully and the dispatcher doesn't fall over under
 *      concurrency. (list_personas does no LLM, so this is API-key-free.)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import {
  CostGuard,
  withCostRun,
  _setCostGuardForTests,
  _resetCostGuardForTests,
} from "../src/core/cost-guard.js";

const SONNET = "claude-sonnet-4-6";

function tmpLedger(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mcp-conc-")),
    "ledger.json",
  );
}

describe("MCP-shaped concurrency: 8 parallel dispatchers", () => {
  let ledgerPath: string;

  beforeEach(() => {
    ledgerPath = tmpLedger();
    // Replace the singleton with a fresh CostGuard pointed at a tmp ledger
    // and big-enough caps that we never trip them.
    _setCostGuardForTests(
      new CostGuard({
        ledgerPath,
        limits: {
          maxRunUsd: 1e9,
          maxRunTokens: 1e12,
          maxDailyUsd: 1e9,
          maxDailyTokens: 1e12,
        },
      }),
    );
  });

  afterEach(() => {
    _resetCostGuardForTests();
    try {
      fs.rmSync(path.dirname(ledgerPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("each scope sees exactly its own recordUsage contributions, never a sibling's", async () => {
    // Each "MCP tool call" records (callIdx + 1) usage entries of 1000 in / 1000 out.
    // After all calls finish, scope N's snapshot.run should reflect (N+1) calls' worth.
    const N = 8;

    // Lazily import getCostGuard to ensure the test seam is honored.
    const { getCostGuard } = await import("../src/core/cost-guard.js");

    async function simulateMcpDispatch(callIdx: number): Promise<{
      idx: number;
      runUsd: number;
      runTokens: number;
    }> {
      return withCostRun(async () => {
        const guard = getCostGuard();
        const calls = callIdx + 1;
        for (let i = 0; i < calls; i++) {
          guard.recordUsage(SONNET, 1000, 1000);
          // Hand control back so other scopes can interleave on the
          // shared ledger lock and the shared CostGuard singleton.
          await new Promise<void>((r) => setImmediate(r));
        }
        const snap = guard.snapshot().run;
        return {
          idx: callIdx,
          runUsd: snap.usd,
          runTokens: snap.inputTokens + snap.outputTokens,
        };
      });
    }

    const promises = Array.from({ length: N }, (_, i) => simulateMcpDispatch(i));
    const results = await Promise.all(promises);

    // Each call's per-scope counters must match exactly (callIdx + 1) record entries.
    // 1k in + 1k out at $3/$15 per 1M = $0.003 + $0.015 = $0.018 per call.
    const PER_CALL_USD = 0.018;
    const PER_CALL_TOKENS = 2000;

    for (const r of results) {
      const expectedUsd = (r.idx + 1) * PER_CALL_USD;
      const expectedTokens = (r.idx + 1) * PER_CALL_TOKENS;
      expect(r.runUsd).toBeCloseTo(expectedUsd, 6);
      expect(r.runTokens).toBe(expectedTokens);
    }

    // Day total = sum of all calls' contributions (1+2+...+N) * PER_CALL.
    const totalCalls = (N * (N + 1)) / 2;
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf-8")) as {
      days: Record<string, { input_tokens: number; output_tokens: number; usd: number }>;
    };
    const day = Object.values(ledger.days)[0];
    expect(day.input_tokens).toBe(totalCalls * 1000);
    expect(day.output_tokens).toBe(totalCalls * 1000);
    expect(day.usd).toBeCloseTo(totalCalls * PER_CALL_USD, 5);
  });
});

describe("Real MCP server stdio: 5 parallel list_personas calls", () => {
  it("dispatches all 5 successfully and returns valid responses", async () => {
    const serverPath = path.join(process.cwd(), "dist/mcp/server.js");
    expect(fs.existsSync(serverPath)).toBe(true);

    const tmpPersonasDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mcp-personas-"),
    );
    // Write 3 minimal persona YAML files so list_personas has real input.
    for (const id of ["us-test", "jp-test", "de-test"]) {
      fs.writeFileSync(
        path.join(tmpPersonasDir, `${id}.yaml`),
        [
          `id: ${id}`,
          `display_name: ${id}`,
          `country: US`,
          `language: en`,
          `locale: en-US`,
          `timezone: UTC`,
          `device_class: desktop`,
          `payment_tier: free`,
          `mental_model: test`,
          `critical_concerns: [test]`,
        ].join("\n"),
      );
    }

    const server = spawn(process.execPath, [serverPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        AUDIT_COST_GUARD_DISABLED: "1", // No real LLM here, but be safe.
      },
    });

    let stdoutBuf = "";
    const responses = new Map<number, unknown>();
    let resolveAllResponses: (() => void) | null = null;
    const allResponsesPromise = new Promise<void>((r) => {
      resolveAllResponses = r;
    });

    server.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      // MCP framing is line-delimited JSON-RPC.
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (typeof msg.id === "number") {
            responses.set(msg.id, msg);
            if (responses.size >= 6 && resolveAllResponses) {
              // 1 init response + 5 tool calls
              resolveAllResponses();
            }
          }
        } catch {
          // ignore non-JSON noise (logger may emit stderr; we only read stdout)
        }
      }
    });

    server.stderr.on("data", () => {
      // pino logs go to stderr; we don't need to assert on them here.
    });

    function send(line: object): void {
      server.stdin.write(JSON.stringify(line) + "\n");
    }

    // 1. Initialize handshake
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "concurrency-e2e", version: "1.0.0" },
      },
    });

    // 2. Fire 5 list_personas calls back-to-back without waiting.
    for (let i = 2; i <= 6; i++) {
      send({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: {
          name: "list_personas",
          arguments: { personas_dir: tmpPersonasDir },
        },
      });
    }

    // Wait up to 10s for all 6 responses.
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("timeout waiting for MCP responses")), 10_000),
    );
    try {
      await Promise.race([allResponsesPromise, timeout]);
    } finally {
      server.kill();
      try {
        fs.rmSync(tmpPersonasDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    // Init came back
    expect(responses.has(1)).toBe(true);
    const init = responses.get(1) as { result?: { protocolVersion: string } };
    expect(init.result?.protocolVersion).toBe("2024-11-05");

    // All 5 tool calls came back successfully (no error)
    for (let i = 2; i <= 6; i++) {
      expect(responses.has(i)).toBe(true);
      const r = responses.get(i) as {
        result?: {
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
      };
      expect(r.result).toBeDefined();
      expect(r.result?.isError).not.toBe(true);
      expect(r.result?.content?.[0]?.type).toBe("text");
      // list_personas returns the persona summary as a top-level JSON array.
      const text = r.result?.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text) as Array<{ id: string }>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3);
      const ids = parsed.map((p) => p.id).sort();
      expect(ids).toEqual(["de-test", "jp-test", "us-test"]);
    }
  }, 30_000);
});
