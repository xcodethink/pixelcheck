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
export {
  writePdfReport,
  renderPdfHtml,
  type PdfReportOptions,
} from "./core/reporter-pdf.js";
export {
  writeTrendsDashboard,
  renderTrendsHtml,
  computeSummary,
  type TrendsDashboardOptions,
  type TrendsSummary,
} from "./core/reporter-trends.js";
export {
  writeDiffReport,
  renderDiffMarkdown,
  renderDiffHtml,
  renderDiffJson,
  renderDiffText,
  type DiffReportFormat,
  type DiffReportOptions,
} from "./core/reporter-diff.js";
export {
  t,
  normaliseLocale,
  formatRunsCount,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  type Locale,
  type TranslationKey,
} from "./core/i18n.js";
export {
  WCAG_CATALOG,
  findWcagCriterion,
  parseAxeTags,
  summarizeWcag,
  wcagSarifRuleId,
  wcagHelpUrl,
  isWcagIssue,
  type WcagLevel,
  type WcagPrinciple,
  type WcagSuccessCriterion,
  type WcagAttribution,
  type WcagSummary,
} from "./core/wcag.js";
export {
  writeJunitXmlReport,
  writeSarifReport,
  writeJsonLinesReport,
  writeGithubAnnotationsReport,
  detectCiEnvironment,
  type SarifToolDriver,
} from "./core/ci-reporters.js";
export { waitForPageStable, type StabilityReport } from "./core/page-stability.js";
export { generateMutations, type MutationResult } from "./core/instruction-mutator.js";
export {
  saveAuditToHistory,
  loadHistory,
  diffRuns,
  type HistoryEntry,
  type RunDiff,
} from "./core/history.js";
export {
  ProgressReporter,
  isTTY,
  type ProgressSummary,
  type ProgressEvent,
} from "./core/progress.js";
export {
  createProvider,
  AnthropicProvider,
  OllamaProvider,
  FallbackLLMProvider,
  OllamaConnectionError,
  OllamaApiError,
  AllProvidersFailedError,
  type LLMProvider,
  type LLMProviderName,
  type LLMProviderConfig,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type VisionOptions,
  type VisionProviderResponse,
} from "./core/llm-provider.js";
export {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  canResume,
  type Checkpoint,
} from "./core/checkpoint.js";
export {
  withRetry,
  computeBackoff,
  DEFAULT_RETRY_STRATEGY,
  type RetryStrategy,
  type WithRetryOptions,
} from "./core/retry.js";

// ── Core primitives ─────────────────────────────────────────────────
export { see, type SeeOptions, type SeeResult } from "./core/primitives/see.js";
export { act, type ActOptions, type ActResult, type ActStep, type ActStepResult } from "./core/primitives/act.js";
export { extract, type ExtractOptions, type ExtractResult } from "./core/primitives/extract.js";
export { judge, type JudgeOptions, type JudgeResult } from "./core/primitives/judge.js";
export { compare, type CompareOptions, type CompareResult, type CompareSideInput } from "./core/primitives/compare.js";
export { diagnose, type DiagnoseOptions, type DiagnoseResult } from "./core/primitives/diagnose.js";
