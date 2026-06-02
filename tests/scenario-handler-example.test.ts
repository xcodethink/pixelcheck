import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HANDLER_JS = path.join(REPO_ROOT, "scenarios/handlers/install-extension.js");

type CustomHandler = (
  step: { type: "custom"; inputs?: Record<string, unknown> },
  ctx: { store: Record<string, unknown> },
) => Promise<{ status: string; output?: Record<string, unknown> }>;

async function loadHandler(): Promise<CustomHandler> {
  // Load exactly the way the runner does: a bare dynamic import of the
  // handler path. If the example shipped raw .ts or imported "../../src/...",
  // this import would throw in an installed package — that's the F5 bug.
  const mod = (await import(pathToFileURL(HANDLER_JS).href)) as { default: CustomHandler };
  return mod.default;
}

describe("shipped custom-handler example (F5)", () => {
  it("ships as runnable .js, not raw .ts", () => {
    expect(fs.existsSync(HANDLER_JS)).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "scenarios/handlers/install-extension.ts"))).toBe(
      false,
    );
  });

  it("does NOT import from the unpublished src/ tree", () => {
    const text = fs.readFileSync(HANDLER_JS, "utf8");
    expect(text).not.toMatch(/from\s+["'][^"']*\/src\//);
    expect(text).not.toMatch(/import\(["'][^"']*\/src\//);
  });

  it("loads via a bare dynamic import and default-exports a function", async () => {
    const handler = await loadHandler();
    expect(typeof handler).toBe("function");
  });

  it("throws a clear error when extension_path is missing", async () => {
    const handler = await loadHandler();
    await expect(handler({ type: "custom", inputs: {} }, { store: {} })).rejects.toThrow(
      /requires inputs\.extension_path/,
    );
  });

  it("validates the manifest and records pending_extension_path", async () => {
    const handler = await loadHandler();
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-"));
    try {
      fs.writeFileSync(path.join(extDir, "manifest.json"), '{"manifest_version":3}\n');
      const store: Record<string, unknown> = {};
      const result = await handler(
        { type: "custom", inputs: { extension_path: extDir } },
        { store },
      );
      expect(result.status).toBe("pass");
      expect(store.pending_extension_path).toBe(extDir);
    } finally {
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  });

  it("throws when the manifest is absent", async () => {
    const handler = await loadHandler();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-empty-"));
    try {
      await expect(
        handler({ type: "custom", inputs: { extension_path: emptyDir } }, { store: {} }),
      ).rejects.toThrow(/manifest not found/i);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
