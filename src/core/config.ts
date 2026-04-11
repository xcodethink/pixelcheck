import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { ProjectConfigSchema, type ProjectConfig } from "./types.js";

export function loadProjectConfig(filePath: string): ProjectConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Project config not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid project config:\n${result.error.errors
        .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
        .join("\n")}`,
    );
  }
  return result.data;
}

/**
 * Validate that critical environment variables are set before run starts.
 */
export function validateEnv(required: string[]): void {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join("\n")}`,
    );
  }

  // Safety: refuse Stripe live keys
  const stripeKey = process.env.STRIPE_TEST_PUBLISHABLE_KEY;
  if (stripeKey && stripeKey.startsWith("pk_live_")) {
    throw new Error(
      "[FATAL] STRIPE_TEST_PUBLISHABLE_KEY appears to be a LIVE key. Refusing to run audit with live Stripe credentials.",
    );
  }
}
