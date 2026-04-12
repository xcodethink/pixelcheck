// Library entry — re-export the public surface for programmatic use.
export * from "./core/types.js";
export { loadProjectConfig } from "./core/config.js";
export { loadPersonas, resolvePersonaSecrets } from "./core/persona.js";
export {
  loadScenarios,
  buildExecutionMatrix,
  substituteTemplate,
} from "./core/scenario.js";
export { runAudit } from "./core/runner.js";
export {
  writeJsonReport,
  writeHtmlReport,
  writeMarkdownSummary,
} from "./core/reporter.js";
export { waitForPageStable, type StabilityReport } from "./core/page-stability.js";
export { generateMutations, type MutationResult } from "./core/instruction-mutator.js";
export {
  saveAuditToHistory,
  loadHistory,
  diffRuns,
  type HistoryEntry,
  type RunDiff,
} from "./core/history.js";
