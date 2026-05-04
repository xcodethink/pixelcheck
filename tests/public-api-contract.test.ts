/**
 * M1-5 — Public API contract tests.
 *
 * These tests guard the *external* contract surface of the library:
 *   1. Every schema in `docs/schemas/*.schema.json` is valid Draft-7
 *      and compiles cleanly under Ajv (the validator external SDK
 *      consumers will actually use, NOT Zod).
 *   2. `docs/schemas/index.json` references every shipped schema and
 *      contains no orphan rows.
 *   3. `RESULT_SCHEMA_VERSION` (the single source of truth) agrees
 *      with the version stamped on every published JSON Schema and
 *      with `index.json`'s `x-result-schema-version` field.
 *   4. Adding/removing a published schema trips a deliberate review
 *      checkpoint via the count assertion (currently 30 at v1.2.0).
 *
 * Sample-driven Ajv validation (publish-shape vs real-producer-output)
 * lives in tests/public-api-samples.test.ts (a separate file so this
 * file stays focused on registry/structural integrity).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type AnySchemaObject } from "ajv";
import addFormats from "ajv-formats";
import { RESULT_SCHEMA_VERSION } from "../src/core/result-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, "../docs/schemas");
const INDEX_PATH = path.join(SCHEMAS_DIR, "index.json");

interface IndexEntry {
  slug: string;
  title: string;
  description: string;
  file: string;
}
interface SchemaIndex {
  $schema: string;
  title: string;
  "x-result-schema-version": string;
  description: string;
  schemas: IndexEntry[];
}

function loadIndex(): SchemaIndex {
  return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) as SchemaIndex;
}

function listSchemaFiles(): string[] {
  return fs
    .readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith(".schema.json"))
    .sort();
}

function loadSchema(file: string): AnySchemaObject {
  return JSON.parse(
    fs.readFileSync(path.join(SCHEMAS_DIR, file), "utf8"),
  ) as AnySchemaObject;
}

// One Ajv instance shared across describe blocks. addFormats wires the
// standard string formats (date-time, email, uri, etc) so schemas using
// `format: "uri"` etc compile without warnings.
function makeAjv(): Ajv {
  const ajv = new Ajv({
    strict: false, // tolerate `x-result-schema-version` etc as unknown keywords
    allErrors: true,
  });
  addFormats(ajv);
  return ajv;
}

// ─────────────────────────────────────────────────────────────
// Schema registry — index.json is the manifest
// ─────────────────────────────────────────────────────────────

describe("docs/schemas/index.json — registry integrity", () => {
  it("is valid JSON and matches the SchemaIndex shape", () => {
    const idx = loadIndex();
    expect(idx.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(typeof idx.title).toBe("string");
    expect(idx["x-result-schema-version"]).toBe(RESULT_SCHEMA_VERSION);
    expect(Array.isArray(idx.schemas)).toBe(true);
    expect(idx.schemas.length).toBeGreaterThan(0);
  });

  it("references every shipped *.schema.json file (no orphans)", () => {
    const idx = loadIndex();
    const referenced = new Set(idx.schemas.map((e) => e.file));
    const onDisk = new Set(listSchemaFiles());
    const orphans = [...onDisk].filter((f) => !referenced.has(f));
    expect(orphans).toEqual([]);
  });

  it("has no dangling entries (every file referenced exists on disk)", () => {
    const idx = loadIndex();
    const onDisk = new Set(listSchemaFiles());
    const dangling = idx.schemas.filter((e) => !onDisk.has(e.file));
    expect(dangling).toEqual([]);
  });

  it("has unique slugs and unique file references", () => {
    const idx = loadIndex();
    const slugs = idx.schemas.map((e) => e.slug);
    const files = idx.schemas.map((e) => e.file);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(files).size).toBe(files.length);
  });

  it("ships exactly 31 schemas at v1.3.0 (review checkpoint — bump this when a new schema lands)", () => {
    // This is intentional friction: adding/removing a schema MUST also
    // update this assertion + the SemVer bump per ADR-007.
    const idx = loadIndex();
    expect(idx.schemas).toHaveLength(31);
    expect(listSchemaFiles()).toHaveLength(31);
  });

  it("each entry has non-empty slug, title, description, and file", () => {
    const idx = loadIndex();
    for (const entry of idx.schemas) {
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.file).toMatch(/\.schema\.json$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Per-schema Draft-7 validity (Ajv compiles every shipped schema)
// ─────────────────────────────────────────────────────────────

describe("docs/schemas/*.schema.json — Draft-7 validity (Ajv compile)", () => {
  const files = listSchemaFiles();

  for (const file of files) {
    it(`compiles cleanly: ${file}`, () => {
      const ajv = makeAjv();
      const schema = loadSchema(file);
      // compile() throws if the schema isn't a valid Draft-7 schema.
      // strict: false is set on the Ajv instance to tolerate our custom
      // `x-result-schema-version` extension keyword (`x-` prefix is the
      // recommended escape hatch for non-standard metadata).
      expect(() => ajv.compile(schema)).not.toThrow();
    });
  }

  it("each schema declares Draft-7 via $schema", () => {
    for (const file of files) {
      const schema = loadSchema(file);
      expect(schema.$schema).toBe(
        "http://json-schema.org/draft-07/schema#",
      );
    }
  });

  it("each schema declares a non-empty $id pointing at the docs/schemas path", () => {
    for (const file of files) {
      const schema = loadSchema(file);
      expect(typeof schema.$id).toBe("string");
      expect(schema.$id).toMatch(/docs\/schemas\//);
      expect(schema.$id).toMatch(file);
    }
  });

  it("each schema has a non-empty title", () => {
    for (const file of files) {
      const schema = loadSchema(file);
      expect(typeof schema.title).toBe("string");
      expect((schema.title as string).length).toBeGreaterThan(0);
    }
  });

  it("each schema declares the current x-result-schema-version (matches the constant)", () => {
    for (const file of files) {
      const schema = loadSchema(file);
      expect(schema["x-result-schema-version"]).toBe(RESULT_SCHEMA_VERSION);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Cross-document version coherence
// ─────────────────────────────────────────────────────────────

describe("RESULT_SCHEMA_VERSION — cross-document coherence", () => {
  it("matches index.json's x-result-schema-version", () => {
    expect(loadIndex()["x-result-schema-version"]).toBe(
      RESULT_SCHEMA_VERSION,
    );
  });

  it("is a valid SemVer 'X.Y.Z' string", () => {
    expect(RESULT_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the version cited in docs/contracts/RESULT_SCHEMA.md (line 29 export)", () => {
    const md = fs.readFileSync(
      path.resolve(__dirname, "../docs/contracts/RESULT_SCHEMA.md"),
      "utf8",
    );
    // Doc cites the SemVer status badge at the top + the constant export.
    // A single regex looks for `RESULT_SCHEMA_VERSION = "X.Y.Z"` — that's
    // the canonical citation.
    const m = md.match(/RESULT_SCHEMA_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(RESULT_SCHEMA_VERSION);
  });

  it("every published schema's x-result-schema-version agrees with the constant", () => {
    const mismatches: Array<{ file: string; v: string }> = [];
    for (const file of listSchemaFiles()) {
      const schema = loadSchema(file);
      const v = schema["x-result-schema-version"] as string;
      if (v !== RESULT_SCHEMA_VERSION) mismatches.push({ file, v });
    }
    expect(mismatches).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// `npm run schemas` idempotence — regenerating must produce zero diff
// ─────────────────────────────────────────────────────────────

describe("schema regeneration idempotence", () => {
  it("each on-disk schema file matches a fresh JSON.parse + JSON.stringify of itself", () => {
    // Reads each file, re-serialises with the same formatting the
    // exporter uses (2-space indent), and asserts byte equality. Catches
    // accidental hand-edits, missing trailing newlines, or formatter
    // drift between contributors.
    for (const file of listSchemaFiles()) {
      const filePath = path.join(SCHEMAS_DIR, file);
      const raw = fs.readFileSync(filePath, "utf8");
      const reparsed = JSON.stringify(JSON.parse(raw), null, 2) + "\n";
      expect(raw).toBe(reparsed);
    }
  });
});
