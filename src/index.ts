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
