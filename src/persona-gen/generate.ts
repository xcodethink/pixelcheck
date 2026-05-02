/**
 * Persona Generator — produces a valid Persona YAML for any country +
 * device combination using the curated market-data tables.
 *
 * The output is deterministic (given the same inputs) so regenerating the
 * same persona produces byte-identical output — safe to commit into a
 * project's personas/ directory and re-regenerate on market-data refresh.
 *
 * Design goal: generated personas have enough concrete detail to differ
 * from a default template (locale, timezone, viewport, mental model note)
 * without inventing any facts the generator can't justify from market data.
 */

import * as fs from "node:fs";
import { stringify } from "yaml";
import { PersonaSchema, type Persona } from "../core/types.js";
import {
  COUNTRY_PROFILES,
  pickDevice,
  type DeviceClass,
  type PaymentTier,
} from "./market-data.js";

export interface GenerateOpts {
  country: string;
  /** Override the modal device for the country */
  device?: DeviceClass;
  /** Override payment tier */
  payment_tier?: PaymentTier;
  /** Override persona id; default derived from country/device */
  id?: string;
}

export interface GeneratedPersona {
  persona: Persona;
  yaml: string;
  note: string;
}

export function generatePersona(opts: GenerateOpts): GeneratedPersona {
  const profile = COUNTRY_PROFILES[opts.country.toUpperCase()];
  if (!profile) {
    throw new Error(
      `unknown country "${opts.country}". Available: ${Object.keys(COUNTRY_PROFILES).join(", ")}`,
    );
  }
  const device = pickDevice(profile, opts.device);
  const tier = opts.payment_tier ?? profile.typical_payment_tier;

  const id = opts.id ?? defaultId(profile.country, device.device_class, tier);
  const displayName = humanLabel(profile, device.device_class, tier);

  const viewport = viewportFor(device.device_class);

  const persona: Persona = {
    id,
    display_name: displayName,
    country: profile.country,
    language: profile.language.split("-")[0]!,
    locale: profile.language,
    timezone: profile.timezone,
    device_class: device.device_class,
    ua_class: device.ua_class as Persona["ua_class"],
    viewport,
    payment_tier: tier,
    mental_model: buildMentalModel(profile, device.device_class, tier),
    critical_concerns: buildConcerns(profile, device.device_class),
  };

  // Validate via Zod before emitting — catches any drift in Persona shape.
  const parsed = PersonaSchema.parse(persona);

  const yaml = stringify(parsed, { lineWidth: 100 });
  return {
    persona: parsed,
    yaml,
    note: `Generated from market-data Q1 2026 for ${profile.display_name} / ${device.device_class} / ${tier}.`,
  };
}

export function writePersonaYaml(opts: GenerateOpts, targetDir: string): string {
  const { persona, yaml, note } = generatePersona(opts);
  fs.mkdirSync(targetDir, { recursive: true });
  const path = `${targetDir}/${persona.id}.yaml`;
  const header = `# ${note}\n# Regenerate: pixelcheck persona generate --country=${opts.country} --device=${opts.device ?? persona.device_class}\n`;
  fs.writeFileSync(path, header + yaml, "utf8");
  return path;
}

// ─────────────────────────────────────────────────────────────
// Derivation helpers
// ─────────────────────────────────────────────────────────────

function defaultId(country: string, device: DeviceClass, tier: PaymentTier): string {
  return `${country.toLowerCase()}-${device}-${tier}`;
}

function humanLabel(
  p: typeof COUNTRY_PROFILES["US"],
  device: DeviceClass,
  tier: PaymentTier,
): string {
  const adjective =
    tier === "free" ? "budget" : tier === "pro" ? "typical" : tier === "max" ? "premium" : "power";
  return `${p.display_name} — ${adjective} ${device} user`;
}

/** Reasonable default viewports per device class. */
function viewportFor(device: DeviceClass): { width: number; height: number } {
  if (device === "mobile") return { width: 393, height: 852 };
  if (device === "tablet") return { width: 1024, height: 1366 };
  return { width: 1440, height: 900 };
}

function buildMentalModel(
  p: typeof COUNTRY_PROFILES["US"],
  device: DeviceClass,
  tier: PaymentTier,
): string {
  const parts: string[] = [];
  parts.push(
    `Native speaker of ${p.language}; resides in ${p.display_name} (${p.timezone}).`,
  );
  parts.push(p.note);
  if (device === "mobile") {
    parts.push(
      "Always on mobile; expects thumb-reachable UI, fast loads, and compact layouts.",
    );
  } else if (device === "desktop") {
    parts.push("Primarily desktop browsing; comfortable with multi-column layouts and hover affordances.");
  } else {
    parts.push("Tablet use; horizontal layouts, larger touch targets than phone.");
  }
  if (tier === "free") {
    parts.push("Price-sensitive; avoids paid upgrades unless clearly justified.");
  } else if (tier === "pro") {
    parts.push("Willing to pay for clear value; expects polish commensurate with price.");
  } else if (tier === "max" || tier === "power") {
    parts.push("High-intent power user; low tolerance for friction.");
  }
  if (p.p50_latency_ms > 100) {
    parts.push(`Network is often slow (p50 latency ${p.p50_latency_ms}ms); times out easily.`);
  }
  return parts.join(" ");
}

function buildConcerns(
  p: typeof COUNTRY_PROFILES["US"],
  device: DeviceClass,
): string[] {
  const concerns: string[] = [];
  if (device === "mobile") concerns.push("thumb reachability");
  if (p.language !== "en-US") concerns.push(`localization (${p.language})`);
  if (p.language === "ar-SA") concerns.push("RTL layout correctness");
  if (p.p50_latency_ms > 80) concerns.push("low-bandwidth tolerance");
  if (p.country === "DE" || p.country === "FR") concerns.push("GDPR / cookie consent clarity");
  if (p.country === "CN") concerns.push("works without blocked Western services");
  if (p.country === "IN" || p.country === "ID" || p.country === "NG") {
    concerns.push("low-end Android performance");
  }
  return concerns;
}

// ─────────────────────────────────────────────────────────────
// Public utility — list supported countries
// ─────────────────────────────────────────────────────────────

export function availableCountries(): Array<{ code: string; name: string }> {
  return Object.values(COUNTRY_PROFILES).map((p) => ({ code: p.country, name: p.display_name }));
}
