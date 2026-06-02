/**
 * CI-friendly output formats — alternate serialisations of an AuditRun
 * for direct consumption by CI/CD pipelines and code-review surfaces.
 *
 * The primary `audit.json` (reporter.ts) is the source of truth. These
 * formats are lossy projections optimised for specific tooling:
 *
 *   - JUnit XML (junit.xml) — Jenkins / GitLab CI / Azure DevOps /
 *     CircleCI legacy reporters. One <testcase> per (scenario × persona);
 *     status="fail" emits <failure>, "pass_with_issues" emits <error>.
 *   - SARIF 2.1.0 (audit.sarif) — GitHub Security tab + Code Scanning
 *     (Advanced Security) + GitLab SAST. One result per issue, with
 *     severity-mapped `level`, ruleId derived from dimension, and
 *     properties carrying score/cost so downstream tools can filter.
 *   - JSONL (audit.jsonl) — one record per line for streaming consumers
 *     (jq, log aggregators, real-time dashboards). First line is a
 *     `kind: "summary"` header, subsequent lines are
 *     `kind: "scenario_result"` per audit unit.
 *   - GitHub Annotations (.github-annotations) — workflow-command lines
 *     (`::error file=...,line=...::message`) that GitHub Actions parses
 *     to attach inline annotations to PR diffs. Written to a file by
 *     default; CLI -mode prints to stderr when running inside Actions.
 *
 * All four are derived from the same AuditRun shape, so adding a new
 * format is mechanical. Redaction is applied via redactDeep so secrets
 * never leak through alternate serialisations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditRun, Issue, ScenarioRunResult } from "./types.js";
import { redactDeep, buildRedactPatterns } from "./secrets.js";
import { findWcagCriterion, wcagHelpUrl, wcagSarifRuleId } from "./wcag.js";
import { getPackageVersion } from "./version.js";

// ─────────────────────────────────────────────────────────────
// Severity mapping table
// ─────────────────────────────────────────────────────────────

/**
 * Map an Issue severity to the closest equivalent level in each
 * downstream format. SARIF and GHA both have 3-4 levels; JUnit has
 * pass/fail/error.
 */
export const SEVERITY_LEVELS = {
  critical: { sarif: "error", gha: "error" },
  high: { sarif: "error", gha: "error" },
  medium: { sarif: "warning", gha: "warning" },
  low: { sarif: "note", gha: "notice" },
} as const;

function applyRedaction(audit: AuditRun): AuditRun {
  // Always redact + always seed from buildRedactPatterns so known env secrets
  // (API key, SCAMLENS_ADMIN_COOKIE, STRIPE_TEST_*) are stripped from SARIF /
  // JUnit / JSONL / GHA output even when the runner attached no patterns —
  // matching the reporter.ts C2 fix. (Audit 2026-06-02 C2.)
  return redactDeep(audit, buildRedactPatterns(audit.redact_patterns ?? []));
}

// ─────────────────────────────────────────────────────────────
// XML escaping helper (used by JUnit writer)
// ─────────────────────────────────────────────────────────────

/**
 * Escape a string for safe inclusion in XML attribute or text content.
 * Covers the five XML special characters per the XML 1.0 spec section 2.4.
 */
export function escapeXml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
    }
    return c;
  });
}

// ─────────────────────────────────────────────────────────────
// JUnit XML — one <testcase> per (scenario × persona)
// ─────────────────────────────────────────────────────────────

/**
 * Write a JUnit XML report. Compatible with Jenkins / GitLab CI / Azure
 * DevOps / CircleCI legacy reporters.
 *
 * Layout: a root `<testsuites>` aggregating all scenarios, with one
 * `<testsuite>` per distinct scenario name and one `<testcase>` per
 * (scenario × persona) audit unit inside it. `pass_with_issues` is
 * surfaced as a `<failure>` with `type="warning"` so the pipeline can
 * choose to fail or warn based on its own policy. `fail` becomes
 * `<failure>` with `type="error"`.
 */
export function writeJunitXmlReport(
  inputAudit: AuditRun,
  runDir: string,
): string {
  const filePath = path.join(runDir, "junit.xml");
  const audit = applyRedaction(inputAudit);
  const xml = renderJunitXml(audit);
  fs.writeFileSync(filePath, xml);
  return filePath;
}

export function renderJunitXml(audit: AuditRun): string {
  // Group results by scenario_id so each <testsuite> has all personas
  // for one scenario.
  const bySc = new Map<string, ScenarioRunResult[]>();
  for (const r of audit.results) {
    if (!bySc.has(r.scenario_id)) bySc.set(r.scenario_id, []);
    bySc.get(r.scenario_id)!.push(r);
  }

  const totalTests = audit.results.length;
  const totalFails = audit.summary.fail;
  const totalWarns = audit.summary.pass_with_issues;
  const totalTimeSec = (audit.duration_ms / 1000).toFixed(3);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="${escapeXml(audit.project_name)}" tests="${totalTests}" failures="${totalFails + totalWarns}" errors="0" time="${totalTimeSec}">`,
  );

  for (const [scId, results] of bySc) {
    const scName = results[0]?.scenario_name ?? scId;
    const suiteFails = results.filter((r) => r.status === "fail").length;
    const suiteWarns = results.filter(
      (r) => r.status === "pass_with_issues",
    ).length;
    const suiteTime = (
      results.reduce((acc, r) => acc + r.duration_ms, 0) / 1000
    ).toFixed(3);

    lines.push(
      `  <testsuite name="${escapeXml(scName)}" tests="${results.length}" failures="${suiteFails + suiteWarns}" errors="0" time="${suiteTime}" timestamp="${escapeXml(audit.started_at)}">`,
    );

    for (const r of results) {
      const caseTime = (r.duration_ms / 1000).toFixed(3);
      const caseName = r.persona_display_name;
      const className = scName;

      lines.push(
        `    <testcase classname="${escapeXml(className)}" name="${escapeXml(caseName)}" time="${caseTime}">`,
      );

      if (r.status === "fail" || r.status === "pass_with_issues") {
        const failType = r.status === "fail" ? "error" : "warning";
        const failMsg = summarizeIssuesForFailure(r);
        lines.push(
          `      <failure type="${failType}" message="${escapeXml(failMsg.summary)}">${escapeXml(failMsg.detail)}</failure>`,
        );
      }

      // Always include score + cost in system-out for downstream filters
      const sysOut = renderSystemOut(r);
      if (sysOut) {
        lines.push(`      <system-out>${escapeXml(sysOut)}</system-out>`);
      }

      lines.push(`    </testcase>`);
    }

    lines.push(`  </testsuite>`);
  }

  lines.push(`</testsuites>`);
  return lines.join("\n") + "\n";
}

function summarizeIssuesForFailure(r: ScenarioRunResult): {
  summary: string;
  detail: string;
} {
  if (r.issues.length === 0) {
    return {
      summary: r.status === "fail" ? "Audit failed" : "Audit warned",
      detail: `Score: ${r.overall_score.toFixed(1)} / 10`,
    };
  }
  const top = r.issues[0]!;
  const summary = `[${top.severity.toUpperCase()}] ${top.description}`;
  const detail = r.issues
    .map(
      (i, idx) =>
        `${idx + 1}. [${i.severity.toUpperCase()}] ${i.description}\n   → ${i.recommendation}`,
    )
    .join("\n");
  return { summary, detail };
}

function renderSystemOut(r: ScenarioRunResult): string {
  const parts: string[] = [];
  parts.push(`Overall score: ${r.overall_score.toFixed(1)} / 10`);
  parts.push(`Cost: $${r.cost_usd.toFixed(3)}`);
  parts.push(`Steps: ${r.steps.length}`);
  for (const s of r.scores) {
    parts.push(`  ${s.dimension}: ${s.score.toFixed(1)}`);
  }
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────
// SARIF v2.1.0 — for GitHub Code Scanning + GitLab SAST
// ─────────────────────────────────────────────────────────────

/**
 * Tool driver metadata embedded in every SARIF document. Pulled from
 * package.json at the call site so we don't drift across releases.
 */
export interface SarifToolDriver {
  name: string;
  version: string;
  informationUri?: string;
}

function defaultTool(): SarifToolDriver {
  return {
    name: "pixelcheck",
    version: getPackageVersion(),
    informationUri: "https://github.com/xcodethink/pixelcheck",
  };
}

/**
 * Write a SARIF 2.1.0 document. Each Issue across all audit units
 * becomes a `result`, with severity mapped to SARIF's `level` enum.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
 *
 * GitHub Code Scanning consumes SARIF via the `github/codeql-action/upload-sarif`
 * Action; GitLab SAST consumes it via the `secure_files` mechanism.
 */
export function writeSarifReport(
  inputAudit: AuditRun,
  runDir: string,
  tool: SarifToolDriver = defaultTool(),
): string {
  const filePath = path.join(runDir, "audit.sarif");
  const audit = applyRedaction(inputAudit);
  const sarif = renderSarif(audit, tool);
  fs.writeFileSync(filePath, JSON.stringify(sarif, null, 2));
  return filePath;
}

interface SarifResult {
  ruleId: string;
  level: "none" | "note" | "warning" | "error";
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
  properties: {
    severity: string;
    scenario_id: string;
    scenario_name: string;
    persona_id: string;
    persona_display_name: string;
    overall_score: number;
    cost_usd: number;
    recommendation: string;
  };
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  /**
   * Top-level URL rendered by GitHub Code Scanning as a "View documentation"
   * link in the issue detail panel. For WCAG rules this is the canonical
   * W3C Understanding URL. SARIF 2.1.0 § 3.49.13.
   */
  helpUri?: string;
  /**
   * Rich help shown when the user expands a result. GHCS / GitLab SAST
   * render `help.markdown` directly. Used today for WCAG rules to inline
   * a brief link snippet. SARIF 2.1.0 § 3.49.12.
   */
  help?: { text?: string; markdown?: string };
  defaultConfiguration: { level: "error" | "warning" | "note" };
}

interface SarifDocument {
  $schema: string;
  version: "2.1.0";
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri?: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
    properties?: Record<string, unknown>;
  }>;
}

export function renderSarif(audit: AuditRun, tool: SarifToolDriver = defaultTool()): SarifDocument {
  const results: SarifResult[] = [];
  const ruleMap = new Map<string, SarifRule>();

  for (const r of audit.results) {
    const locUri = `audit/${r.scenario_id}/${r.persona_id}`;
    for (const issue of r.issues) {
      const ruleId = ruleIdForIssue(issue);
      if (!ruleMap.has(ruleId)) {
        ruleMap.set(ruleId, buildRule(ruleId, issue));
      }
      results.push({
        ruleId,
        level: SEVERITY_LEVELS[issue.severity].sarif,
        message: { text: `${issue.description} — ${issue.recommendation}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: locUri },
            },
          },
        ],
        properties: {
          severity: issue.severity,
          scenario_id: r.scenario_id,
          scenario_name: r.scenario_name,
          persona_id: r.persona_id,
          persona_display_name: r.persona_display_name,
          overall_score: r.overall_score,
          cost_usd: r.cost_usd,
          recommendation: issue.recommendation,
        },
      });
    }
  }

  return {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: tool.name,
            version: tool.version,
            informationUri: tool.informationUri,
            rules: [...ruleMap.values()],
          },
        },
        results,
        properties: {
          run_id: audit.run_id,
          project_name: audit.project_name,
          base_url: audit.base_url,
          summary: audit.summary,
        },
      },
    ],
  };
}

function ruleIdForIssue(issue: Issue): string {
  // M2-2: WCAG-attributed accessibility issues route to a per-criterion
  // SARIF ruleId (`wcag/1-4-3`, `wcag/2-1-1`, etc) so GitHub Code
  // Scanning groups them under the actual WCAG SC the violation is
  // graded against. ADA / EAA compliance teams can filter by the
  // ruleId in GitHub Security tab (e.g. show only "wcag/1.4.3
  // Contrast" violations) without parsing issue text.
  if (issue.wcag_criterion !== undefined) {
    return wcagSarifRuleId(issue.wcag_criterion);
  }
  // Stable, kebab-case rule id — derived from the dimension when set,
  // otherwise from a generic "audit-issue" bucket.
  if (issue.dimension) {
    return `audit/${issue.dimension.replace(/_/g, "-").toLowerCase()}`;
  }
  return "audit/general-issue";
}

function buildRule(ruleId: string, issue: Issue): SarifRule {
  // M2-2: when this is a WCAG-attributed rule, embed the SC name +
  // canonical W3C Understanding URL so GitHub's rule detail panel
  // shows the human-readable criterion alongside the violation.
  if (issue.wcag_criterion !== undefined) {
    const sc = findWcagCriterion(issue.wcag_criterion);
    if (sc) {
      const helpUri = wcagHelpUrl(sc);
      return {
        id: ruleId,
        name: ruleId,
        shortDescription: {
          text: `WCAG ${sc.id} ${sc.name} (Level ${sc.level})`,
        },
        fullDescription: {
          text: `Web Content Accessibility Guidelines ${sc.id} — ${sc.name}. Conformance level ${sc.level} under the ${sc.principle} principle. See ${helpUri}.`,
        },
        // T6: top-level helpUri + help.markdown render in GitHub Code
        // Scanning's issue detail panel as a "View documentation" link +
        // an inline expandable help section. Verified manually via
        // docs/integration/sarif-upload-verified.md.
        helpUri,
        help: {
          text: `WCAG ${sc.id} ${sc.name} (Level ${sc.level}). ${helpUri}`,
          markdown: `**WCAG ${sc.id} ${sc.name}** (Level ${sc.level})\n\n[View on W3C](${helpUri})`,
        },
        defaultConfiguration: {
          level: SEVERITY_LEVELS[issue.severity].sarif === "note"
            ? "note"
            : SEVERITY_LEVELS[issue.severity].sarif === "warning"
              ? "warning"
              : "error",
        },
      };
    }
  }
  return {
    id: ruleId,
    name: ruleId,
    shortDescription: { text: issue.dimension ?? "audit issue" },
    fullDescription: {
      text:
        issue.dimension !== undefined
          ? `Issues raised by the PixelCheck against the ${issue.dimension} dimension.`
          : "Issues raised by the PixelCheck that are not bound to a single scoring dimension.",
    },
    defaultConfiguration: {
      level: SEVERITY_LEVELS[issue.severity].sarif === "note"
        ? "note"
        : SEVERITY_LEVELS[issue.severity].sarif === "warning"
          ? "warning"
          : "error",
    },
  };
}

// ─────────────────────────────────────────────────────────────
// JSONL — one record per line
// ─────────────────────────────────────────────────────────────

/**
 * Write a JSON Lines file: first line is a `summary` record carrying
 * the audit-level header; subsequent lines are one `scenario_result`
 * record per audit unit. Each line is a complete JSON document so the
 * file is consumable by `jq -c '.kind=="scenario_result"'` and similar
 * stream tools.
 */
export function writeJsonLinesReport(
  inputAudit: AuditRun,
  runDir: string,
): string {
  const filePath = path.join(runDir, "audit.jsonl");
  const audit = applyRedaction(inputAudit);
  const lines = renderJsonLines(audit);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

export function renderJsonLines(audit: AuditRun): string[] {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      kind: "summary",
      schema_version: audit.schema_version,
      run_id: audit.run_id,
      project_name: audit.project_name,
      base_url: audit.base_url,
      started_at: audit.started_at,
      finished_at: audit.finished_at,
      duration_ms: audit.duration_ms,
      summary: audit.summary,
    }),
  );
  for (const r of audit.results) {
    lines.push(
      JSON.stringify({
        kind: "scenario_result",
        schema_version: audit.schema_version,
        ...r,
      }),
    );
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────
// GitHub Actions workflow commands
// ─────────────────────────────────────────────────────────────

/**
 * Render GitHub Actions workflow-command lines for every issue in the
 * audit. Each line follows the `::level file=...,title=...::message`
 * shape that GitHub Actions parses to attach inline annotations to PR
 * diffs and surface them in the workflow run summary.
 *
 * Spec: https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 *
 * `file` is set to a synthetic `<run_dir>/<scenario>/<persona>` so the
 * annotation appears in the workflow summary even when no source file
 * maps directly. CI integrators can override the file mapping by
 * post-processing the JSONL output.
 */
export function writeGithubAnnotationsReport(
  inputAudit: AuditRun,
  runDir: string,
): string {
  const filePath = path.join(runDir, "github-annotations.txt");
  const audit = applyRedaction(inputAudit);
  const lines = renderGithubAnnotations(audit);
  fs.writeFileSync(filePath, lines.join("\n") + (lines.length ? "\n" : ""));
  return filePath;
}

export function renderGithubAnnotations(audit: AuditRun): string[] {
  const lines: string[] = [];
  for (const r of audit.results) {
    for (const issue of r.issues) {
      const level = SEVERITY_LEVELS[issue.severity].gha;
      const file = `audit/${r.scenario_id}/${r.persona_id}`;
      const title = `[${issue.severity.toUpperCase()}] ${r.scenario_name} × ${r.persona_display_name}`;
      // Workflow-command newlines must be encoded as %0A; commas/colons
      // in the message are escaped to avoid breaking the parser.
      // Use a real newline; encodeWorkflowCommandValue turns it into %0A once.
      // Embedding a literal "%0A" here double-encoded to "%250A" (the % got
      // escaped to %25), so annotations showed a stray "%0A" instead of a line
      // break. (Audit 2026-06-02 H2.)
      const message = encodeWorkflowCommandValue(
        `${issue.description}\n→ ${issue.recommendation}`,
      );
      lines.push(
        `::${level} file=${encodeWorkflowCommandValue(file)},title=${encodeWorkflowCommandValue(title)}::${message}`,
      );
    }
  }
  return lines;
}

/**
 * Encode a value for inclusion in a GHA workflow-command property.
 * Per GitHub's documented escaping: %25, %0D, %0A, %3A, %2C for
 * literal `%`, `\r`, `\n`, `:`, `,`.
 */
export function encodeWorkflowCommandValue(s: string): string {
  return String(s)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

// ─────────────────────────────────────────────────────────────
// CI environment auto-detection
// ─────────────────────────────────────────────────────────────

/**
 * Best-effort detection of common CI environments. Returns null when
 * no recognised CI flag is set (so `pixelcheck run` from a developer
 * laptop doesn't accidentally emit annotations to stderr).
 */
export function detectCiEnvironment(env: NodeJS.ProcessEnv = process.env):
  | "github-actions"
  | "gitlab-ci"
  | "circle-ci"
  | "azure-pipelines"
  | "jenkins"
  | "generic-ci"
  | null {
  if (env.GITHUB_ACTIONS === "true") return "github-actions";
  if (env.GITLAB_CI === "true") return "gitlab-ci";
  if (env.CIRCLECI === "true") return "circle-ci";
  if (env.TF_BUILD === "True" || env.AZURE_HTTP_USER_AGENT) {
    return "azure-pipelines";
  }
  if (env.JENKINS_URL) return "jenkins";
  if (env.CI === "true" || env.CI === "1") return "generic-ci";
  return null;
}

export const CI_FORMATS = ["junit", "sarif", "jsonl", "gha"] as const;

/**
 * Resolve `--ci-format` into the set of formats to emit.
 *
 * Default ("auto" / unset): emit all four when CI is detected, none
 * otherwise — keeps developer-laptop runs clean. "all" / "none" /
 * comma-separated subset are explicit overrides.
 *
 * Throws on an unknown token. Silently dropping it meant
 * `--ci-format saraf` produced zero CI output and the build still passed
 * green — the worst kind of CI misconfiguration. (Audit 2026-06-02 H7.)
 */
export function resolveCiFormats(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  if (raw === undefined || raw === "auto") {
    return detectCiEnvironment(env) ? new Set(CI_FORMATS) : new Set();
  }
  if (raw === "none") return new Set();
  if (raw === "all") return new Set(CI_FORMATS);
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter(
    (r) => !(CI_FORMATS as readonly string[]).includes(r),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --ci-format value(s): ${unknown.join(", ")}. ` +
        `Valid formats: ${CI_FORMATS.join(", ")} (or "all", "none", "auto").`,
    );
  }
  return new Set(requested);
}
