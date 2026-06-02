/**
 * Custom step handler: install a Chrome extension into the running browser.
 *
 * This is a SHIPPED EXAMPLE of a custom handler. It is written as plain ESM
 * JavaScript with JSDoc types — NOT TypeScript — for two reasons:
 *   1. Custom handlers are loaded at runtime via `await import(handlerPath)`.
 *      An installed pixelcheck runs on the user's plain Node, which cannot
 *      import a `.ts` file without a TS loader. A `.js` example just works.
 *   2. The published tarball ships the compiled dist tree, not the typed
 *      source tree. A handler that imported pixelcheck's internal source
 *      modules would dangle for every installed user. The step/context shapes
 *      are duck-typed at runtime, so this example documents them with JSDoc
 *      instead of importing the types.
 *
 * The handler contract (for editor hints; nothing is imported at runtime):
 *   - `step`  — the scenario step: `{ type: "custom", handler, inputs?, ... }`
 *   - `ctx`   — the step context, including a mutable `ctx.store` bag the
 *               runner threads across steps.
 *   - returns — a `Partial<StepResult>`, e.g. `{ status, output }`.
 *
 * IMPORTANT: This requires the auditor to be launched with `userDataDir` set
 * (i.e. `persistent_storage: true` on the scenario), because Chromium only
 * supports `--load-extension` in persistent contexts.
 *
 * Inputs:
 *   extension_path: relative path to the unpacked extension's manifest dir
 *
 * @param {{ type: "custom", inputs?: Record<string, unknown> }} step
 * @param {{ store: Record<string, unknown> }} ctx
 * @returns {Promise<{ status: string, output?: Record<string, unknown> }>}
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function installExtension(step, ctx) {
  const extPath = /** @type {string | undefined} */ (step.inputs?.extension_path);
  if (!extPath) {
    throw new Error("install-extension requires inputs.extension_path");
  }

  // Resolve relative to project root (this file lives at
  // <root>/scenarios/handlers/, so two levels up is the project root).
  const projectRoot = path.resolve(__dirname, "..", "..");
  const fullPath = path.resolve(projectRoot, extPath);

  if (!fs.existsSync(path.join(fullPath, "manifest.json"))) {
    throw new Error(
      `Extension manifest not found at ${path.join(fullPath, "manifest.json")}. Build the extension first.`,
    );
  }

  // Note: actual extension loading must happen at browser launch time via
  // chromium.launchPersistentContext({ args: ['--load-extension=PATH'] }).
  // This handler verifies the path and stores it for the runner to consume
  // when re-launching with persistent context. The runner reads
  // ctx.store.pending_extension_path on subsequent visits.
  //
  // For now we record the intent and let the operator pre-build the extension.
  ctx.store.pending_extension_path = fullPath;

  return {
    status: "pass",
    output: {
      extension_path: fullPath,
      note: "Extension path validated; reload browser with --load-extension to activate.",
    },
  };
}
