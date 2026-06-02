import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { PersonaSchema, type Persona } from "./types.js";

/**
 * Locate the personas/ directory bundled with the npm package. Resolved
 * relative to this compiled module (dist/core/persona.js → <pkg>/personas).
 * Returns null if not found.
 */
export function resolveBundledPersonasDir(): string | null {
  try {
    const candidate = fileURLToPath(new URL("../../personas", import.meta.url));
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // import.meta.url may not be a file URL under some bundlers
  }
  return null;
}

/**
 * Resolve a personas directory: prefer an existing user-supplied path, else
 * fall back to the bundled personas/. Without this, MCP tools resolved a
 * CWD-relative "./personas" that almost never exists for a global/MCP install,
 * so the persona feature silently no-op'd for every MCP user — the same class
 * of bug fixed for the CLI in v1.0.1 but never wired into MCP. (Audit 2026-06-02 F1.)
 */
export function resolvePersonasDir(userPath?: string): string {
  if (userPath) {
    const resolved = path.resolve(userPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  const bundled = resolveBundledPersonasDir();
  if (bundled) return bundled;
  return path.resolve(userPath ?? "personas");
}

/**
 * Load all persona YAML files from a directory.
 */
export function loadPersonas(dir: string): Map<string, Persona> {
  if (!fs.existsSync(dir)) {
    throw new Error(`Personas directory not found: ${dir}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  const map = new Map<string, Persona>();
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const persona = loadPersonaFile(fullPath);
    if (map.has(persona.id)) {
      throw new Error(
        `Duplicate persona id "${persona.id}" in ${file} and ${
          map.get(persona.id)?.id
        }`,
      );
    }
    map.set(persona.id, persona);
  }
  return map;
}

export function loadPersonaFile(filePath: string): Persona {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  const result = PersonaSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid persona ${path.basename(filePath)}:\n${result.error.errors
        .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
        .join("\n")}`,
    );
  }
  return result.data;
}

/**
 * Resolve env vars referenced inside persona test_credentials, and derive
 * convenience fields like `url_locale` (the short ISO 639-1 form of `locale`,
 * commonly used in URL paths like /ja, /zh, /de).
 *
 * Soft resolution: if an env var is missing, leaves the placeholder in place.
 * Steps that actually use the credential will fail at substitution time.
 * This lets infra-smoke scenarios run without setting unused test credentials.
 */
export function resolvePersonaSecrets(persona: Persona): Persona {
  // Derive short locale (e.g. ja-JP → ja)
  const urlLocale = persona.locale.split("-")[0] ?? persona.locale;

  // Cast to extended shape so template substitution can read it
  const enriched = {
    ...persona,
    url_locale: urlLocale,
  } as Persona & { url_locale: string };

  const creds = persona.test_credentials;
  if (!creds) return enriched;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(creds)) {
    resolved[key] = resolveEnvPlaceholders(value);
  }
  return { ...enriched, test_credentials: resolved };
}

export function resolveEnvPlaceholders(input: string): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      return match;
    }
    return value;
  });
}
