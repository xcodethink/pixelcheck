/**
 * Tests for the persona generator.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import {
  generatePersona,
  writePersonaYaml,
  availableCountries,
} from "../src/persona-gen/generate.js";
import { pickDevice, COUNTRY_PROFILES } from "../src/persona-gen/market-data.js";
import { PersonaSchema } from "../src/core/types.js";

describe("pickDevice", () => {
  it("picks the modal device for the country when no override", () => {
    const us = COUNTRY_PROFILES.US!;
    const result = pickDevice(us);
    expect(result.device_class).toBe("mobile");
    expect(result.mobile_os).toBeDefined();
  });

  it("respects an explicit override", () => {
    const us = COUNTRY_PROFILES.US!;
    expect(pickDevice(us, "desktop").device_class).toBe("desktop");
    expect(pickDevice(us, "desktop").ua_class).toBe("windows");
  });

  it("picks iPhone UA for iOS-dominant mobile markets", () => {
    const jp = COUNTRY_PROFILES.JP!;
    const d = pickDevice(jp, "mobile");
    expect(d.ua_class).toBe("iphone");
    expect(d.mobile_os).toBe("ios");
  });

  it("picks Android UA for Android-dominant mobile markets", () => {
    const india = COUNTRY_PROFILES.IN!;
    const d = pickDevice(india, "mobile");
    expect(d.ua_class).toBe("android");
    expect(d.mobile_os).toBe("android");
  });
});

describe("generatePersona", () => {
  it("produces a valid Persona for a known country", () => {
    const { persona } = generatePersona({ country: "BR" });
    expect(persona.country).toBe("BR");
    expect(persona.locale).toBe("pt-BR");
    expect(PersonaSchema.safeParse(persona).success).toBe(true);
  });

  it("is deterministic (same inputs → same output)", () => {
    const a = generatePersona({ country: "IN", device: "mobile" });
    const b = generatePersona({ country: "IN", device: "mobile" });
    expect(a.yaml).toBe(b.yaml);
  });

  it("uses a sensible default id", () => {
    const { persona } = generatePersona({ country: "US", device: "desktop" });
    expect(persona.id).toBe("us-desktop-pro");
  });

  it("honors id override", () => {
    const { persona } = generatePersona({ country: "US", id: "my-custom-id" });
    expect(persona.id).toBe("my-custom-id");
  });

  it("includes low-bandwidth concern for slow markets", () => {
    const { persona } = generatePersona({ country: "NG", device: "mobile" });
    expect(persona.critical_concerns.join(" ")).toMatch(/low-bandwidth/);
  });

  it("includes RTL concern for ar-SA", () => {
    const { persona } = generatePersona({ country: "SA", device: "mobile" });
    expect(persona.critical_concerns.join(" ")).toMatch(/RTL/);
  });

  it("includes GDPR concern for EU countries", () => {
    const de = generatePersona({ country: "DE" });
    expect(de.persona.critical_concerns.join(" ")).toMatch(/GDPR/);
    const fr = generatePersona({ country: "FR" });
    expect(fr.persona.critical_concerns.join(" ")).toMatch(/GDPR/);
  });

  it("throws on unknown country", () => {
    expect(() => generatePersona({ country: "XX" })).toThrow(/unknown country/i);
  });

  it("maps viewports by device class", () => {
    expect(generatePersona({ country: "US", device: "mobile" }).persona.viewport).toEqual({
      width: 393,
      height: 852,
    });
    expect(generatePersona({ country: "US", device: "tablet" }).persona.viewport).toEqual({
      width: 1024,
      height: 1366,
    });
    expect(generatePersona({ country: "US", device: "desktop" }).persona.viewport).toEqual({
      width: 1440,
      height: 900,
    });
  });

  it("yaml is parseable and round-trips through the schema", () => {
    const { yaml } = generatePersona({ country: "MX", device: "mobile" });
    const roundtrip = parseYaml(yaml);
    const re = PersonaSchema.safeParse(roundtrip);
    expect(re.success).toBe(true);
  });
});

describe("writePersonaYaml", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pgen-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("writes file with expected filename", () => {
    const p = writePersonaYaml({ country: "TH", device: "mobile" }, tmp);
    expect(p.endsWith("/th-mobile-free.yaml")).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("includes a provenance header", () => {
    const p = writePersonaYaml({ country: "JP" }, tmp);
    const content = fs.readFileSync(p, "utf8");
    expect(content).toMatch(/^# Generated from market-data/);
    expect(content).toMatch(/Regenerate: pixelcheck persona generate --country=JP/);
  });
});

describe("availableCountries", () => {
  it("returns a non-empty list with well-formed entries", () => {
    const list = availableCountries();
    expect(list.length).toBeGreaterThan(10);
    for (const c of list) {
      expect(c.code).toHaveLength(2);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });
});
