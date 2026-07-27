/**
 * Task Evaluator — scores a single task run against WebArena-style eval criteria.
 *
 * Matches WebArena's public evaluation logic:
 *   - string_match:  answer/text contains/excludes/exact/fuzzy strings
 *   - url_match:     final page URL matches reference (exact / prefix / substring)
 *   - exact_match:   extracted answer equals reference exactly
 *   - program_html:  per-URL DOM checks (required_contents locator + predicate)
 *   - page_image_query: not implemented here (would require vision model)
 *
 * Zero LLM cost — all deterministic.
 */

import type { Page } from "playwright";
import type { BenchmarkTask, TaskEval, ReferenceAnswers } from "./task.js";

export interface TaskRunOutcome {
  /** Final URL the agent landed on */
  final_url: string;
  /** The agent's free-form answer or last extracted text (optional) */
  answer?: string;
  /** Pages we can re-visit for program_html checks */
  page: Page;
}

export interface TaskEvalResult {
  passed: boolean;
  per_check: Array<{
    type: string;
    passed: boolean;
    detail: string;
  }>;
  score: number; // 0..1 — fraction of checks passed
}

export async function evaluateTask(
  task: BenchmarkTask,
  outcome: TaskRunOutcome,
): Promise<TaskEvalResult> {
  const perCheck: TaskEvalResult["per_check"] = [];

  for (const type of task.eval.eval_types) {
    switch (type) {
      case "string_match": {
        const r = evaluateStringMatch(outcome.answer ?? "", task.eval.reference_answers);
        perCheck.push({ type, passed: r.passed, detail: r.detail });
        break;
      }
      case "url_match": {
        const r = evaluateUrlMatch(outcome.final_url, task.eval);
        perCheck.push({ type, passed: r.passed, detail: r.detail });
        break;
      }
      case "exact_match": {
        const r = evaluateExactMatch(outcome.answer ?? "", task.eval.reference_answers?.exact_match);
        perCheck.push({ type, passed: r.passed, detail: r.detail });
        break;
      }
      case "program_html": {
        const r = await evaluateProgramHtml(outcome.page, task.eval);
        perCheck.push({ type, passed: r.passed, detail: r.detail });
        break;
      }
      case "page_image_query":
        perCheck.push({
          type,
          passed: false,
          detail: "page_image_query not implemented (requires vision model)",
        });
        break;
    }
  }

  const passed = perCheck.length > 0 && perCheck.every((c) => c.passed);
  const score = perCheck.length === 0 ? 0 : perCheck.filter((c) => c.passed).length / perCheck.length;
  return { passed, per_check: perCheck, score };
}

// ─────────────────────────────────────────────────────────────
// Individual evaluators (exported for unit testing)
// ─────────────────────────────────────────────────────────────

export function evaluateStringMatch(
  text: string,
  refs: ReferenceAnswers | undefined,
): { passed: boolean; detail: string } {
  if (!refs) return { passed: false, detail: "no reference_answers provided" };
  const normalized = text.toLowerCase();

  if (refs.exact_match !== undefined) {
    const ok = text.trim() === refs.exact_match.trim();
    if (!ok) return { passed: false, detail: `exact_match expected "${refs.exact_match}", got "${text.slice(0, 120)}"` };
  }

  if (refs.must_include) {
    for (const needle of refs.must_include) {
      if (!normalized.includes(needle.toLowerCase())) {
        return { passed: false, detail: `missing required substring: "${needle}"` };
      }
    }
  }
  if (refs.must_exclude) {
    for (const needle of refs.must_exclude) {
      if (normalized.includes(needle.toLowerCase())) {
        return { passed: false, detail: `contained forbidden substring: "${needle}"` };
      }
    }
  }
  if (refs.fuzzy_match) {
    const hits = refs.fuzzy_match.filter((n) => normalized.includes(n.toLowerCase())).length;
    if (hits < Math.ceil(refs.fuzzy_match.length / 2)) {
      return { passed: false, detail: `fuzzy_match: only ${hits}/${refs.fuzzy_match.length} hits` };
    }
  }
  return { passed: true, detail: "string_match ok" };
}

export function evaluateUrlMatch(
  actual: string,
  evalSpec: Pick<TaskEval, "reference_url" | "reference_url_match">,
): { passed: boolean; detail: string } {
  const ref = evalSpec.reference_url;
  if (!ref) return { passed: false, detail: "no reference_url provided" };
  const mode = evalSpec.reference_url_match ?? "exact";

  const strip = (u: string): string => u.replace(/[?#].*$/, "").replace(/\/$/, "");
  const a = strip(actual);
  const r = strip(ref);

  if (mode === "exact") {
    const ok = a === r;
    return { passed: ok, detail: ok ? "url exact" : `expected ${r}, got ${a}` };
  }
  if (mode === "prefix") {
    const ok = a.startsWith(r);
    return { passed: ok, detail: ok ? "url prefix ok" : `expected prefix ${r}, got ${a}` };
  }
  // substring
  const ok = a.includes(r);
  return { passed: ok, detail: ok ? "url substring ok" : `expected substring ${r}, got ${a}` };
}

export function evaluateExactMatch(
  actual: string,
  expected: string | undefined,
): { passed: boolean; detail: string } {
  if (expected === undefined) return { passed: false, detail: "no exact_match reference" };
  const ok = actual.trim() === expected.trim();
  return { passed: ok, detail: ok ? "exact_match ok" : `expected "${expected}", got "${actual}"` };
}

export async function evaluateProgramHtml(
  page: Page,
  evalSpec: TaskEval,
): Promise<{ passed: boolean; detail: string }> {
  const checks = evalSpec.program_html;
  if (!checks || checks.length === 0) {
    return { passed: false, detail: "no program_html checks" };
  }
  for (const check of checks) {
    try {
      // Navigate to the check URL if we're not already there.
      if (!page.url().includes(check.url)) {
        await page.goto(check.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      }
      const locator = page.locator(check.locator);
      const count = await locator.count();
      if (count === 0) {
        return { passed: false, detail: `locator "${check.locator}" not found on ${check.url}` };
      }
      if (check.required_contents) {
        const text = (await locator.first().textContent()) ?? "";
        for (const [key, value] of Object.entries(check.required_contents)) {
          if (typeof value === "string" && !text.toLowerCase().includes(value.toLowerCase())) {
            return {
              passed: false,
              detail: `required_contents.${key}: "${value}" not in locator text`,
            };
          }
        }
      }
    } catch (e) {
      return { passed: false, detail: `program_html check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { passed: true, detail: "program_html ok" };
}
