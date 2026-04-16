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
export { AgentEventBus, attachConsoleLogger, type AgentEvent, type AgentEventType } from "./agent/events.js";
export { extractDomSummary, formatDomSummary, type DomSummary } from "./agent/dom-summary.js";
export {
  writeJsonReport,
  writeHtmlReport,
  writeMarkdownSummary,
} from "./core/reporter.js";
export { writeSpaReport } from "./core/reporter-spa.js";
export { waitForPageStable, type StabilityReport } from "./core/page-stability.js";
export { generateMutations, type MutationResult } from "./core/instruction-mutator.js";
export {
  saveAuditToHistory,
  loadHistory,
  diffRuns,
  type HistoryEntry,
  type RunDiff,
} from "./core/history.js";
