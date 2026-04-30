/**
 * Tests for src/core/scenario.ts — YAML loader, template substitution,
 * autonomous-mode helper, and execution-matrix builder. Pure I/O surface,
 * no browser/LLM. Uses tmpdir scratch space so tests don't touch the
 * worktree's real scenarios/.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadScenarios,
  loadScenarioFile,
  substituteTemplate,
  isAutonomous,
  buildExecutionMatrix,
} from "../src/core/scenario.js";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-test-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

const minimalScripted = `
id: smoke
name: Smoke
priority: P0
goal: Verify homepage loads
applies_to:
  personas: [u1]
steps:
  - id: visit
    type: visit
    url: https://example.com
`;

const minimalAutonomous = `
id: explore
name: Explore
priority: P1
goal: Find pricing page
applies_to:
  personas: [u1]
mode: autonomous
start_url: https://example.com
success_criteria:
  - id: c1
    description: Found pricing
`;

function writeYaml(file: string, body: string): string {
  const fullPath = path.join(scratch, file);
  fs.writeFileSync(fullPath, body, "utf-8");
  return fullPath;
}

describe("loadScenarioFile", () => {
  it("loads a scripted scenario", () => {
    const f = writeYaml("smoke.yaml", minimalScripted);
    const sc = loadScenarioFile(f);
    expect(sc.id).toBe("smoke");
    expect(sc.mode).toBe("scripted"); // schema default
    expect(sc.steps).toHaveLength(1);
    expect(sc.steps?.[0].type).toBe("visit");
  });

  it("loads an autonomous scenario", () => {
    const f = writeYaml("explore.yaml", minimalAutonomous);
    const sc = loadScenarioFile(f);
    expect(sc.mode).toBe("autonomous");
    expect(sc.start_url).toBe("https://example.com");
    expect(sc.success_criteria).toHaveLength(1);
  });

  it("rejects scenario missing required fields", () => {
    const f = writeYaml("bad.yaml", "id: bad\n");
    expect(() => loadScenarioFile(f)).toThrow(/Invalid scenario bad\.yaml/);
  });

  it("rejects scripted scenario with no steps[]", () => {
    const body = `
id: nosteps
name: No Steps
priority: P0
goal: x
applies_to:
  personas: [u1]
`;
    const f = writeYaml("nosteps.yaml", body);
    expect(() => loadScenarioFile(f)).toThrow(
      /Autonomous mode requires success_criteria.*scripted mode requires steps/,
    );
  });

  it("rejects autonomous scenario missing success_criteria", () => {
    const body = `
id: bad-auto
name: Bad
priority: P1
goal: x
applies_to:
  personas: [u1]
mode: autonomous
start_url: https://x.example
`;
    const f = writeYaml("bad-auto.yaml", body);
    expect(() => loadScenarioFile(f)).toThrow(/Autonomous mode requires/);
  });

  it("error message lists each invalid path", () => {
    const f = writeYaml("multi.yaml", "id: x\nname: y\n");
    let err: Error | null = null;
    try {
      loadScenarioFile(f);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/priority/);
    expect(err!.message).toMatch(/applies_to/);
  });
});

describe("loadScenarios", () => {
  it("loads every YAML file in a directory, sorted", () => {
    writeYaml("01-a.yaml", minimalScripted.replace("id: smoke", "id: a"));
    writeYaml("02-b.yaml", minimalScripted.replace("id: smoke", "id: b"));
    const map = loadScenarios(scratch);
    expect(map.size).toBe(2);
    expect([...map.keys()]).toEqual(["a", "b"]);
  });

  it("accepts both .yaml and .yml extensions", () => {
    writeYaml("a.yaml", minimalScripted.replace("id: smoke", "id: a"));
    writeYaml("b.yml", minimalScripted.replace("id: smoke", "id: b"));
    expect(loadScenarios(scratch).size).toBe(2);
  });

  it("ignores non-YAML files", () => {
    writeYaml("a.yaml", minimalScripted.replace("id: smoke", "id: a"));
    fs.writeFileSync(path.join(scratch, "notes.md"), "ignored");
    fs.writeFileSync(path.join(scratch, ".DS_Store"), "ignored");
    expect(loadScenarios(scratch).size).toBe(1);
  });

  it("throws on duplicate scenario id", () => {
    writeYaml("01.yaml", minimalScripted);
    writeYaml("02.yaml", minimalScripted); // same id "smoke"
    expect(() => loadScenarios(scratch)).toThrow(/Duplicate scenario id "smoke"/);
  });

  it("throws if directory does not exist", () => {
    expect(() => loadScenarios(path.join(scratch, "nope"))).toThrow(
      /Scenarios directory not found/,
    );
  });

  it("returns an empty map for an empty directory", () => {
    expect(loadScenarios(scratch).size).toBe(0);
  });
});

describe("substituteTemplate", () => {
  it("substitutes persona fields by dotted path", () => {
    const out = substituteTemplate("Hello ${persona.display_name}", {
      persona: { display_name: "Alex" },
    });
    expect(out).toBe("Hello Alex");
  });

  it("walks nested persona objects", () => {
    const out = substituteTemplate("${persona.profile.country}", {
      persona: { profile: { country: "JP" } },
    });
    expect(out).toBe("JP");
  });

  it("leaves placeholder when persona path is missing", () => {
    const out = substituteTemplate("Hi ${persona.missing}", { persona: {} });
    expect(out).toBe("Hi ${persona.missing}");
  });

  it("leaves placeholder when traversal hits a non-object", () => {
    const out = substituteTemplate("${persona.name.first}", {
      persona: { name: "Alex" },
    });
    expect(out).toBe("${persona.name.first}");
  });

  it("substitutes env vars via context", () => {
    const out = substituteTemplate("URL=${env.BASE_URL}", {
      env: { BASE_URL: "https://x.example" },
    });
    expect(out).toBe("URL=https://x.example");
  });

  it("leaves env placeholder when var is missing", () => {
    const out = substituteTemplate("${env.MISSING_VAR}", { env: {} });
    expect(out).toBe("${env.MISSING_VAR}");
  });

  it("substitutes Stripe test card refs by full name", () => {
    const out = substituteTemplate("${stripe.card_number}", {
      stripe: { "stripe.card_number": "4242 4242 4242 4242" },
    });
    expect(out).toBe("4242 4242 4242 4242");
  });

  it("substitutes store values stashed by previous steps", () => {
    const out = substituteTemplate("To: ${store.temp_inbox_address}", {
      store: { temp_inbox_address: "abc@example.com" },
    });
    expect(out).toBe("To: abc@example.com");
  });

  it("leaves store placeholder when key missing", () => {
    const out = substituteTemplate("${store.gone}", { store: {} });
    expect(out).toBe("${store.gone}");
  });

  it("leaves entire placeholder if root namespace is unknown", () => {
    const out = substituteTemplate("${other.x}", {});
    expect(out).toBe("${other.x}");
  });

  it("returns input unchanged when no placeholders", () => {
    expect(substituteTemplate("plain", {})).toBe("plain");
  });

  it("substitutes multiple placeholders in one pass", () => {
    const out = substituteTemplate(
      "${persona.id}@${env.DOMAIN}",
      { persona: { id: "u1" }, env: { DOMAIN: "x.example" } },
    );
    expect(out).toBe("u1@x.example");
  });
});

describe("isAutonomous", () => {
  it("returns true for autonomous mode", () => {
    const f = writeYaml("a.yaml", minimalAutonomous);
    expect(isAutonomous(loadScenarioFile(f))).toBe(true);
  });

  it("returns false for scripted mode", () => {
    const f = writeYaml("s.yaml", minimalScripted);
    expect(isAutonomous(loadScenarioFile(f))).toBe(false);
  });
});

describe("buildExecutionMatrix", () => {
  it("returns empty when no scenarios", () => {
    expect(buildExecutionMatrix([], new Set(["u1"]))).toEqual([]);
  });

  it("emits one (scenario, persona) per persona in applies_to", () => {
    const f1 = writeYaml(
      "s1.yaml",
      minimalScripted.replace("personas: [u1]", "personas: [u1, u2]"),
    );
    const sc = loadScenarioFile(f1);
    const matrix = buildExecutionMatrix([sc], new Set(["u1", "u2"]));
    expect(matrix).toHaveLength(2);
    expect(matrix.map((m) => m.personaId).sort()).toEqual(["u1", "u2"]);
  });

  it("filters out personas not in the available set", () => {
    const f1 = writeYaml(
      "s1.yaml",
      minimalScripted.replace("personas: [u1]", "personas: [u1, u2]"),
    );
    const sc = loadScenarioFile(f1);
    const matrix = buildExecutionMatrix([sc], new Set(["u1"]));
    expect(matrix).toHaveLength(1);
    expect(matrix[0].personaId).toBe("u1");
  });

  it("skips scenarios where no persona matches", () => {
    const f1 = writeYaml("s1.yaml", minimalScripted);
    const sc = loadScenarioFile(f1);
    expect(buildExecutionMatrix([sc], new Set(["other"]))).toEqual([]);
  });

  it("preserves per-scenario × per-persona ordering", () => {
    const fA = writeYaml(
      "a.yaml",
      minimalScripted
        .replace("id: smoke", "id: A")
        .replace("personas: [u1]", "personas: [u1, u2]"),
    );
    const fB = writeYaml(
      "b.yaml",
      minimalScripted
        .replace("id: smoke", "id: B")
        .replace("personas: [u1]", "personas: [u2]"),
    );
    const a = loadScenarioFile(fA);
    const b = loadScenarioFile(fB);
    const matrix = buildExecutionMatrix([a, b], new Set(["u1", "u2"]));
    expect(matrix.map((m) => `${m.scenario.id}:${m.personaId}`)).toEqual([
      "A:u1",
      "A:u2",
      "B:u2",
    ]);
  });
});
