/**
 * Custom step handler: install a Chrome extension into the running browser.
 *
 * IMPORTANT: This requires the auditor to be launched with `userDataDir` set
 * (i.e. `persistent_storage: true` on the scenario), because Chromium only
 * supports `--load-extension` in persistent contexts.
 *
 * Inputs:
 *   extension_path: relative path to the unpacked extension's manifest dir
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Step, StepResult } from "../../src/core/types.js";
import type { StepContext } from "../../src/handlers/index.js";

export default async function installExtension(
  step: Extract<Step, { type: "custom" }>,
  ctx: StepContext,
): Promise<Partial<StepResult>> {
  const extPath = step.inputs?.extension_path as string | undefined;
  if (!extPath) {
    throw new Error("install-extension requires inputs.extension_path");
  }

  // Resolve relative to project root
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
    output: { extension_path: fullPath, note: "Extension path validated; reload browser with --load-extension to activate." },
  };
}
