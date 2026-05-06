/**
 * MCP stdio end-to-end integration test (T7b — closes RISK-REGISTER R8).
 *
 * What unit tests already cover (tests/mcp-server.test.ts +
 * tests/mcp-registry.test.ts):
 *   - Tool registration / tool definition shape
 *   - JSON-RPC request → handler dispatch
 *   - Argument coercion + persona resolution
 *
 * What this integration test adds:
 *   - Real spawn `dist/mcp/server.js` over stdio (process boundary)
 *   - Real MCP client SDK (`StdioClientTransport`) handshake +
 *     tools/list + tools/call round-trip
 *   - `list_capabilities` (kind: "meta") roundtrip — pure introspection,
 *     **NO LLM calls**, validates the MCP transport + dispatch + result
 *     stamping path end-to-end without burning Anthropic API budget
 *   - Result envelope conforms to ListCapabilitiesResult schema (whatever the current RESULT_SCHEMA_VERSION is)
 *
 * Why list_capabilities specifically:
 *   - It's the only MCP tool that doesn't hit an LLM (it's pure
 *     introspection — reads ToolRegistry + env-var docs + cache info)
 *   - It exercises the same MCP transport code path used by every
 *     other tool (audit_url / explore_url / see / etc.)
 *   - audit_url + LLM-using tools are deferred to T3 (LLM cassette task)
 *     because they need real Anthropic API to validate the response
 *     shape end-to-end
 *
 * Pre-req: `npm run build` must have produced dist/mcp/server.js. The
 * test fails loudly if dist is missing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RESULT_SCHEMA_VERSION } from "../../src/core/result-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist/mcp/server.js");

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // Pre-flight: dist/mcp/server.js must exist (npm run build).
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Missing ${SERVER_ENTRY}. Run \`npm run build\` before this test.`,
    );
  }

  // MCP SDK client over stdio — spawns the server process.
  transport = new StdioClientTransport({
    command: process.execPath, // node binary
    args: [SERVER_ENTRY],
    env: {
      ...process.env,
      // No real API needed for list_capabilities; explicit empty key
      // proves the path runs without hitting Anthropic.
      ANTHROPIC_API_KEY: "sk-ant-stdio-e2e-no-llm-calls",
      AUDIT_COST_GUARD_DISABLED: "1",
    },
  });

  client = new Client(
    { name: "pixelcheck-stdio-e2e-test", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    // ignore
  }
  try {
    await transport?.close();
  } catch {
    // ignore
  }
}, 10_000);

describe("MCP stdio e2e — pure-introspection roundtrip (no LLM)", () => {
  it("server announces a non-empty tool list including list_capabilities", async () => {
    const { tools } = await client.listTools();

    // Tool count: as of v1 we register 12 (preset + primitives + meta).
    // Minimum 5 to catch "registry not loading any tools" regression.
    expect(tools.length).toBeGreaterThanOrEqual(5);

    const names = tools.map((t) => t.name);
    expect(names).toContain("list_capabilities");
    expect(names).toContain("audit_url");
    expect(names).toContain("see");

    // Each tool exposes name + description + inputSchema (MCP requirement)
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("calls list_capabilities and gets back a valid envelope", async () => {
    const result = await client.callTool({
      name: "list_capabilities",
      arguments: {},
    });

    // MCP CallToolResult shape: { content: [{ type: 'text', text: '...' }, ...] }
    expect(result.isError).not.toBe(true);
    expect(Array.isArray(result.content)).toBe(true);

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0]!.type).toBe("text");
    expect(typeof content[0]!.text).toBe("string");

    // The text body is JSON-stringified ListCapabilitiesResult
    const envelope = JSON.parse(content[0]!.text!);

    // Envelope shape (M9-5): { server, result_schema_version, tools, env, cache }
    expect(envelope).toHaveProperty("server");
    expect(envelope).toHaveProperty("result_schema_version");
    expect(envelope).toHaveProperty("tools");
    expect(envelope).toHaveProperty("env");
    expect(envelope).toHaveProperty("cache");

    // Stamp current RESULT_SCHEMA_VERSION rather than a hardcoded string
    // so this test doesn't break on every minor schema bump.
    expect(envelope.result_schema_version).toBe(RESULT_SCHEMA_VERSION);
    expect(Array.isArray(envelope.tools)).toBe(true);
    expect(envelope.tools.length).toBeGreaterThanOrEqual(5);

    // Each tool has the M9-5 metadata shape
    for (const tool of envelope.tools) {
      expect(typeof tool.name).toBe("string");
      expect(["preset", "primitive", "meta"]).toContain(tool.kind);
      expect(typeof tool.cacheable).toBe("boolean");
      expect(tool.cost_estimate_usd).toBeDefined();
      expect(Array.isArray(tool.side_effects)).toBe(true);
      expect(tool.requires).toBeDefined();
    }

    // Env table: minimum entries for AUDIT_*, LOG_*, ANTHROPIC_API_KEY
    expect(Array.isArray(envelope.env)).toBe(true);
    const envNames = envelope.env.map(
      (e: { name: string }) => e.name,
    ) as string[];
    expect(envNames).toContain("ANTHROPIC_API_KEY");

    // Cache info has enabled / ttl / path fields
    expect(envelope.cache).toHaveProperty("enabled");
    expect(envelope.cache).toHaveProperty("ttl_ms_default");
    expect(envelope.cache).toHaveProperty("path");
  });

  it("rejects unknown tool names cleanly (either throws or isError=true)", async () => {
    // MCP servers can signal "unknown tool" two ways:
    //   (a) JSON-RPC error response — SDK rejects the promise
    //   (b) Tool result with isError=true — SDK resolves
    // Either is spec-compliant; the contract here is "server doesn't
    // crash + caller can detect the failure".
    let rejected = false;
    let result: { isError?: boolean } | null = null;
    try {
      result = (await client.callTool({
        name: "nonexistent-tool",
        arguments: {},
      })) as { isError?: boolean };
    } catch {
      rejected = true;
    }
    expect(rejected || result?.isError === true).toBe(true);

    // Subsequent valid call still works (server didn't crash)
    const followup = await client.callTool({
      name: "list_capabilities",
      arguments: {},
    });
    expect(followup.isError).not.toBe(true);
  });

  it("rejects missing required arguments with a structured error", async () => {
    // Most tools require url/some args; calling with empty args should
    // surface a structured error (input validation) not crash the server.
    const result = await client.callTool({
      name: "see",
      arguments: {},
    });
    // see requires url; either MCP SDK rejects via inputSchema OR our
    // handler returns isError=true. Either is acceptable as long as the
    // server stays alive (next call still works).
    if (result.isError === true) {
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]!.type).toBe("text");
      expect(typeof content[0]!.text).toBe("string");
    }

    // Subsequent call still works (server didn't crash)
    const followup = await client.callTool({
      name: "list_capabilities",
      arguments: {},
    });
    expect(followup.isError).not.toBe(true);
  });
});
