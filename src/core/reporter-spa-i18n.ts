/**
 * Localised UI strings for the audit-explorer.html SPA (T18 — closes
 * R65 partial). The dictionary is exported so the SPA renderer can
 * inline it as JSON; the runtime locale switch happens in the browser
 * via `URLSearchParams("?lang=...")` with `navigator.language` as
 * fallback.
 *
 * Why a separate module from src/core/i18n.ts:
 *
 * The 90-key static-reporter dictionary (`i18n.ts`) is for the audit.html
 * + audit.pdf + reporter-trends.html + reporter-diff.* outputs — those
 * render server-side at one fixed locale per call. The SPA is different:
 * it ships all 5 locales inline and switches at runtime, so the
 * dictionary it embeds must be a strict subset that fits in the HTML
 * payload (~3 KB / locale × 5 = ~15 KB inline overhead, fine).
 *
 * Keep keys sorted alphabetically. Use `{n}` and `{total}` placeholders
 * for interpolated count strings — the SPA does a tiny `.replace(/\{n\}/g, ...)`
 * substitution.
 *
 * v1 ships machine-assisted translations + `docs/translation-review-template.md`
 * native-speaker review pass for the static dictionary (T11 — same flow
 * applies here when reviewers extend to the SPA).
 */

export const SPA_LOCALES = ["en", "zh-CN", "ja", "es", "de"] as const;
export type SpaLocale = (typeof SPA_LOCALES)[number];
export const SPA_DEFAULT_LOCALE: SpaLocale = "en";

const en = {
  audit_explorer_title: "Audit Explorer",
  btn_collapse: "Collapse",
  btn_expand_all: "Expand all",
  count_format: "{n} of {total}",
  empty_no_results: "No results match your filters.",
  filter_all: "all",
  filter_any: "any",
  filter_dim_max: "dim ≤",
  filter_issue: "issue",
  filter_persona: "persona",
  filter_scenario: "scenario",
  filter_status: "status",
  section_dimensions: "Dimensions",
  section_issues_n: "Issues ({n})",
  section_steps_n: "Steps ({n})",
  step_col_duration: "duration",
  step_col_id: "id",
  step_col_status: "status",
  step_col_timing: "timing",
  step_col_type: "type",
  step_col_via: "via",
  summary_cost: "Cost",
  summary_fail: "Fail",
  summary_issues: "Issues",
  summary_pass: "Pass",
  summary_total: "Total",
  summary_warn: "Warn",
};

const zhCN: Record<keyof typeof en, string> = {
  audit_explorer_title: "审计浏览器",
  btn_collapse: "全部折叠",
  btn_expand_all: "全部展开",
  count_format: "{n} / {total}",
  empty_no_results: "没有匹配筛选条件的结果。",
  filter_all: "全部",
  filter_any: "任意",
  filter_dim_max: "维度 ≤",
  filter_issue: "问题",
  filter_persona: "用户画像",
  filter_scenario: "场景",
  filter_status: "状态",
  section_dimensions: "维度评分",
  section_issues_n: "问题 ({n})",
  section_steps_n: "步骤 ({n})",
  step_col_duration: "耗时",
  step_col_id: "编号",
  step_col_status: "状态",
  step_col_timing: "时序",
  step_col_type: "类型",
  step_col_via: "方式",
  summary_cost: "成本",
  summary_fail: "失败",
  summary_issues: "问题数",
  summary_pass: "通过",
  summary_total: "总计",
  summary_warn: "警告",
};

const ja: Record<keyof typeof en, string> = {
  audit_explorer_title: "監査エクスプローラー",
  btn_collapse: "すべて折りたたむ",
  btn_expand_all: "すべて展開",
  count_format: "{n} / {total}",
  empty_no_results: "条件に一致する結果はありません。",
  filter_all: "すべて",
  filter_any: "任意",
  filter_dim_max: "次元 ≤",
  filter_issue: "問題",
  filter_persona: "ペルソナ",
  filter_scenario: "シナリオ",
  filter_status: "ステータス",
  section_dimensions: "ディメンション",
  section_issues_n: "問題 ({n})",
  section_steps_n: "ステップ ({n})",
  step_col_duration: "所要時間",
  step_col_id: "ID",
  step_col_status: "状態",
  step_col_timing: "タイミング",
  step_col_type: "種別",
  step_col_via: "経路",
  summary_cost: "コスト",
  summary_fail: "失敗",
  summary_issues: "問題数",
  summary_pass: "成功",
  summary_total: "合計",
  summary_warn: "警告",
};

const es: Record<keyof typeof en, string> = {
  audit_explorer_title: "Explorador de auditoría",
  btn_collapse: "Contraer",
  btn_expand_all: "Expandir todo",
  count_format: "{n} de {total}",
  empty_no_results: "Ningún resultado coincide con los filtros.",
  filter_all: "todos",
  filter_any: "cualquiera",
  filter_dim_max: "dim ≤",
  filter_issue: "incidencia",
  filter_persona: "persona",
  filter_scenario: "escenario",
  filter_status: "estado",
  section_dimensions: "Dimensiones",
  section_issues_n: "Incidencias ({n})",
  section_steps_n: "Pasos ({n})",
  step_col_duration: "duración",
  step_col_id: "id",
  step_col_status: "estado",
  step_col_timing: "tiempos",
  step_col_type: "tipo",
  step_col_via: "vía",
  summary_cost: "Coste",
  summary_fail: "Fallo",
  summary_issues: "Incidencias",
  summary_pass: "Aprobado",
  summary_total: "Total",
  summary_warn: "Aviso",
};

const de: Record<keyof typeof en, string> = {
  audit_explorer_title: "Audit-Explorer",
  btn_collapse: "Einklappen",
  btn_expand_all: "Alle ausklappen",
  count_format: "{n} von {total}",
  empty_no_results: "Keine Ergebnisse entsprechen den Filtern.",
  filter_all: "alle",
  filter_any: "beliebig",
  filter_dim_max: "Dim. ≤",
  filter_issue: "Problem",
  filter_persona: "Persona",
  filter_scenario: "Szenario",
  filter_status: "Status",
  section_dimensions: "Dimensionen",
  section_issues_n: "Probleme ({n})",
  section_steps_n: "Schritte ({n})",
  step_col_duration: "Dauer",
  step_col_id: "ID",
  step_col_status: "Status",
  step_col_timing: "Zeitablauf",
  step_col_type: "Typ",
  step_col_via: "Pfad",
  summary_cost: "Kosten",
  summary_fail: "Fehlschlag",
  summary_issues: "Probleme",
  summary_pass: "Bestanden",
  summary_total: "Gesamt",
  summary_warn: "Warnung",
};

export const SPA_I18N: Record<SpaLocale, Record<keyof typeof en, string>> = {
  en,
  "zh-CN": zhCN,
  ja,
  es,
  de,
};

export type SpaTranslationKey = keyof typeof en;

export function spaTranslationKeys(): readonly SpaTranslationKey[] {
  return Object.keys(en) as SpaTranslationKey[];
}

/**
 * Family-aware locale matcher that mirrors the SPA's runtime logic. Useful
 * for the unit tests so the JS in reporter-spa.ts and the TypeScript here
 * stay in sync.
 */
export function normaliseSpaLocale(raw: string | undefined): SpaLocale {
  if (!raw) return SPA_DEFAULT_LOCALE;
  const trimmed = raw.trim();
  if (!trimmed) return SPA_DEFAULT_LOCALE;
  if ((SPA_LOCALES as readonly string[]).includes(trimmed)) {
    return trimmed as SpaLocale;
  }
  const lower = trimmed.toLowerCase();
  for (const supported of SPA_LOCALES) {
    if (supported.toLowerCase() === lower) return supported;
  }
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("de")) return "de";
  if (lower.startsWith("en")) return "en";
  return SPA_DEFAULT_LOCALE;
}

/** Substitute `{key}` placeholders with values; missing keys leave the placeholder verbatim. */
export function spaInterpolate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

/** Look up a translated string with fallback to en if locale or key is unknown. */
export function spaT(
  locale: SpaLocale,
  key: SpaTranslationKey,
  vars?: Record<string, string | number>,
): string {
  const dict = SPA_I18N[locale] ?? SPA_I18N[SPA_DEFAULT_LOCALE];
  const tpl = dict[key] ?? SPA_I18N[SPA_DEFAULT_LOCALE][key];
  return vars ? spaInterpolate(tpl, vars) : tpl;
}

/** Returns the keys missing from a given locale's dictionary. Always [] today; future-proofing. */
export function lintSpaTranslations(locale: SpaLocale): SpaTranslationKey[] {
  const enKeys = Object.keys(en) as SpaTranslationKey[];
  const dict = SPA_I18N[locale] ?? {};
  return enKeys.filter((k) => !(k in dict));
}
