/**
 * Shared MCP `ToolResult` shape and helpers for emitting one.
 *
 * Kept separate from `server.ts` so per-tool modules under `src/mcp/tools/`
 * can construct results without taking a transitive dependency on the
 * full server lifecycle.
 *
 * The `stampedTextResult` path is the canonical exit for any tool whose
 * payload has a stable result schema (M9-2): it stamps `schema_version`
 * and runs the payload through `validateResult` (warn-not-throw).
 */

import type { z } from "zod";
import { attachSchemaVersion, validateResult } from "../core/result-schema.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Build a ToolResult whose JSON body carries `schema_version` and has been
 * passed through `validateResult` (M9-2 C3).
 *
 * - Objects: schema_version is stamped at the top via `attachSchemaVersion`.
 * - Arrays / scalars: returned unchanged (no envelope wrapping).
 *
 * Validation runs in safeParse mode; mismatches log a warn line via
 * the result-schema logger and the original payload still flows through.
 * v1.0.0 is observe-only; never block the caller on schema drift.
 */
export function stampedTextResult<T>(
  resultName: string,
  schema: z.ZodType<T>,
  value: T,
): ToolResult {
  const stamped = attachSchemaVersion(value);
  validateResult(resultName, schema, stamped);
  return textResult(JSON.stringify(stamped, null, 2));
}
