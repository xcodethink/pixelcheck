/**
 * Argument coercion + persona resolution shared by MCP tool handlers.
 *
 * Kept as a side-effect-free module so per-tool files can import these
 * without dragging in `server.ts`.
 */

import type { Persona } from "../core/types.js";

export function requireString(val: unknown, name: string): string {
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(`missing required string argument: ${name}`);
  }
  return val;
}

/**
 * Resolve a persona id to a Persona object, falling back to a sensible
 * default (first US desktop, else first available) when no id is given
 * or the requested id doesn't exist.
 */
export function resolvePersona(
  personas: Map<string, Persona>,
  id: string | undefined,
): Persona {
  if (id && personas.has(id)) return personas.get(id)!;
  for (const [, p] of personas) {
    if (p.country === "US" && p.device_class === "desktop") return p;
  }
  const first = personas.values().next();
  if (first.done) throw new Error("no personas available");
  return first.value;
}
