/**
 * Report localisation — translates the static "skeleton" of every
 * stakeholder-facing report (PDF / trends dashboard / diff report /
 * SPA explorer) into the 5 most-requested languages.
 *
 * What's translated: section headings, table headers, card labels,
 * status / severity badges, disclaimer prose, empty-state messages.
 *
 * What's NOT translated: the audit's own findings (issue descriptions
 * + recommendations come from the LLM in whatever language the user
 * asked the model for); numbers / dates / run ids / cost values; raw
 * scenario / persona ids.
 *
 * Locale support is bounded to the 5 highest-priority markets for
 * v1.0.0:
 *   - en    — English (baseline / fallback)
 *   - zh-CN — Simplified Chinese
 *   - ja    — Japanese
 *   - es    — Spanish
 *   - de    — German
 *
 * Adding a new locale is a 90-string PR + one entry in SUPPORTED_LOCALES.
 * Translations were curated for brevity and industry-standard wording
 * (e.g. "Score" stays "评分" in zh-CN, the convention every Chinese SaaS
 * dashboard uses).
 */

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export const SUPPORTED_LOCALES = [
  "en",
  "zh-CN",
  "ja",
  "es",
  "de",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/**
 * Every translation key emitted by any reporter. Adding a new key
 * requires updating all 5 dictionaries below — the `lintTranslations`
 * function (and its unit test) enforces that coverage.
 */
export type TranslationKey = keyof (typeof TRANSLATIONS)["en"];

// ─────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────

/**
 * Look up a translated string. Falls back to English if the locale is
 * unknown or the key is missing in the requested locale (defensive —
 * lintTranslations() unit test asserts no key is missing).
 *
 * Usage:
 *   t("overall_score", "zh-CN")   → "总评分"
 *   t("overall_score")             → "Overall score" (default en)
 */
export function t(key: TranslationKey, locale: Locale = DEFAULT_LOCALE): string {
  const dict = (TRANSLATIONS as Record<string, Record<string, string>>)[locale];
  if (!dict) return TRANSLATIONS.en[key];
  return dict[key] ?? TRANSLATIONS.en[key];
}

/**
 * Normalise a free-form locale string from the CLI / config to a
 * supported Locale. Falls back to en for unknown / partial inputs.
 *
 *   "zh"     → "zh-CN" (zh-* family normalises to the canonical entry)
 *   "ZH-CN"  → "zh-CN"
 *   "fr"     → "en" (unsupported)
 */
export function normaliseLocale(raw: string | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_LOCALE;
  // Exact match first (case-sensitive then case-insensitive)
  if ((SUPPORTED_LOCALES as readonly string[]).includes(trimmed)) {
    return trimmed as Locale;
  }
  const lower = trimmed.toLowerCase();
  for (const supported of SUPPORTED_LOCALES) {
    if (supported.toLowerCase() === lower) return supported;
  }
  // Chinese family fallback. Only Simplified-script variants map to our
  // single Chinese dictionary (zh-CN). Traditional-script variants
  // (zh-Hant, zh-TW, zh-HK, zh-MO) read differently — serving them
  // Simplified is a silent mistranslation, so they fall back to en until a
  // Traditional dictionary exists. (Audit 2026-06-02 E8.)
  if (lower.startsWith("zh")) {
    const isTraditional =
      lower.startsWith("zh-hant") ||
      lower === "zh-tw" ||
      lower.startsWith("zh-tw-") ||
      lower === "zh-hk" ||
      lower.startsWith("zh-hk-") ||
      lower === "zh-mo" ||
      lower.startsWith("zh-mo-");
    return isTraditional ? DEFAULT_LOCALE : "zh-CN";
  }
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("de")) return "de";
  if (lower.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

/**
 * Returns the list of keys missing from a given locale's dictionary.
 * Used by the i18n unit test to enforce 100% key coverage across all
 * supported locales.
 */
export function lintTranslations(locale: Locale): string[] {
  const enKeys = Object.keys(TRANSLATIONS.en);
  const dict = (TRANSLATIONS as Record<string, Record<string, string>>)[locale] ?? {};
  return enKeys.filter((k) => !(k in dict));
}

// ─────────────────────────────────────────────────────────────
// Translations
//
// Keep keys sorted alphabetically for diff-friendliness. Keep values
// short — most are <30 chars; the disclaimer paragraphs are the only
// long-form entries.
// ─────────────────────────────────────────────────────────────

const en = {
  // Common labels
  after: "After",
  audit_report_title: "AI Browser Audit Report",
  baseline: "(baseline)",
  before: "Before",
  cost: "Cost",
  cost_unit_usd: "USD",
  critical: "critical",
  critical_issues: "Critical issues",
  date_label: "Run date",
  delta: "Delta",
  dimension: "Dimension",
  dimensions: "Dimensions",
  duration: "Duration",
  fail: "fail",
  generated_by: "Generated by PixelCheck",
  high: "high",
  issues: "Issues",
  latest_score: "Latest score",
  low: "low",
  mean_last_30: "Mean last 30",
  mean_last_7: "Mean last 7",
  medium: "medium",
  metric: "Metric",
  no_data: "No data",
  no_issues_found: "No issues found in this run.",
  no_issues_raised: "No issues raised.",
  overall_score: "Overall score",
  pass: "pass",
  pass_with_issues: "pass with issues",
  project_label: "Project",
  recommendation: "Recommendation",
  run_label: "Run",
  scenarios: "Scenarios",
  score: "Score",
  score_scale: "0–10 scale",
  status: "Status",
  steps: "steps",
  tag: "Tag",
  this_run: "(this run)",
  total: "Total",
  total_cost: "Total cost",
  total_issues: "Total issues",
  total_scenarios: "Total scenarios run",
  url_label: "URL",

  // PDF report sections
  pdf_disclaimer:
    "AI scoring is calibrated against a labelled fixture set and trends to within ±1 point of human review on a 10-point scale. Scores reflect what an experienced reviewer would see in a single user session — they do not guarantee absence of regressions in untested flows. For full evidence (screenshots, video, console logs), open audit-explorer.html in the same run directory.",
  pdf_findings_subtitle:
    "Sorted by severity. Critical / high issues are blockers; medium / low are improvement opportunities.",
  pdf_methodology_intro:
    "The PixelCheck launches real Chromium browser sessions configured with persona-specific device fingerprints and runs scripted user journeys end-to-end. After each run, screenshots and DOM data are scored by Anthropic's Claude vision model against a defined rubric.",
  pdf_methodology_title: "Methodology",
  pdf_no_scenarios: "No scenarios ran in this audit.",
  pdf_personas_in_run: "Personas in this run",
  pdf_run_id_archival: "Run id",
  pdf_scenario_results_title: "Scenario results",
  pdf_scenarios_in_run: "Scenarios in this run",
  pdf_top_findings_title: "Top findings",
  pdf_wcag_section_title: "WCAG compliance summary",
  pdf_wcag_section_intro:
    "Accessibility violations grouped by WCAG conformance level and Success Criterion. Counts come from the axe-core engine; see the W3C Understanding documents for full criterion descriptions.",
  pdf_wcag_no_a11y:
    "No accessibility issues detected by the assert_a11y step in this run.",
  pdf_wcag_by_level: "By conformance level",
  pdf_wcag_by_principle: "By principle",
  pdf_wcag_by_criterion: "Top violated criteria",
  pdf_wcag_principle_perceivable: "Perceivable",
  pdf_wcag_principle_operable: "Operable",
  pdf_wcag_principle_understandable: "Understandable",
  pdf_wcag_principle_robust: "Robust",
  pdf_wcag_principle_unknown: "Other",
  pdf_wcag_level_unknown: "Unknown",
  pdf_wcag_count_label: "Issues",

  // Trends dashboard sections
  trends_chart_cost_hint:
    "USD spent on AI inference per run. Drift up suggests inefficient scoring or larger scenarios.",
  trends_chart_cost_title: "Cost over time",
  trends_chart_dim_hint:
    "One line per scoring dimension. Spot when a single dimension regresses while the overall stays flat.",
  trends_chart_dim_title: "Per-dimension scores",
  trends_chart_issues_hint:
    "Total issues raised, with critical issues called out. Lower is better.",
  trends_chart_issues_title: "Issues over time",
  trends_chart_pwf_hint:
    "Counts of audit units by status, per run. Tall green bars = consistent runs; growing red = regression.",
  trends_chart_pwf_title: "Pass / Warn / Fail breakdown",
  trends_chart_score_hint: "0–10 scale. Higher is better.",
  trends_chart_score_title: "Overall score",
  trends_empty_state:
    "No audit history found yet. Run `pixelcheck run` to seed the trend dashboard.",
  trends_runs_count_one: "1 run",
  trends_runs_count_other: "{n} runs",
  trends_title: "PixelCheck — Trends",

  // Diff report sections
  diff_cross_project: "Cross-project diff",
  diff_footer_tail: "run ids",
  diff_headline_metrics: "Headline metrics",
  diff_no_changes:
    "No meaningful UX changes detected between these runs.",
  diff_per_dimension_changes: "Per-dimension changes",
  diff_resolved_issues: "Resolved issues",
  diff_title: "AI Browser Audit Diff",
  diff_total_new: "New issues",
  diff_total_resolved: "Resolved issues",

  // Severity / status accessibility (full names — used in
  // hover titles and screen-reader labels). The short forms above
  // (critical / high / medium / low) are the visible badges.
  status_pass_full: "Passed",
  status_warn_full: "Passed with issues",
  status_fail_full: "Failed",
};

const zhCN: Record<keyof typeof en, string> = {
  after: "之后",
  audit_report_title: "AI 浏览器审计报告",
  baseline: "（基准）",
  before: "之前",
  cost: "成本",
  cost_unit_usd: "美元",
  critical: "严重",
  critical_issues: "严重问题",
  date_label: "运行日期",
  delta: "差异",
  dimension: "维度",
  dimensions: "各维度",
  duration: "耗时",
  fail: "失败",
  generated_by: "由 AI 浏览器审计员生成",
  high: "高",
  issues: "问题",
  latest_score: "最新评分",
  low: "低",
  mean_last_30: "近 30 次平均",
  mean_last_7: "近 7 次平均",
  medium: "中",
  metric: "指标",
  no_data: "暂无数据",
  no_issues_found: "本次运行未发现任何问题。",
  no_issues_raised: "未发现问题。",
  overall_score: "总评分",
  pass: "通过",
  pass_with_issues: "通过但有问题",
  project_label: "项目",
  recommendation: "建议",
  run_label: "运行",
  scenarios: "场景",
  score: "评分",
  score_scale: "0–10 分制",
  status: "状态",
  steps: "步骤",
  tag: "标签",
  this_run: "（本次）",
  total: "总计",
  total_cost: "总成本",
  total_issues: "问题总数",
  total_scenarios: "总场景数",
  url_label: "网址",

  pdf_disclaimer:
    "AI 评分已通过带标签的样本集校准，10 分制下与人工评审的偏差在 ±1 分以内。分数反映经验丰富的评审在一次完整用户会话中所见——不保证未测试的流程不会回归。需查看完整证据（截图、视频、控制台日志），请打开同目录下的 audit-explorer.html。",
  pdf_findings_subtitle:
    "按严重程度排序。严重 / 高级问题需立即修复；中 / 低级是改进机会。",
  pdf_methodology_intro:
    "AI 浏览器审计员启动真实的 Chromium 浏览器会话，使用与用户角色匹配的设备指纹端到端跑完用户旅程。运行后由 Anthropic Claude 视觉模型按既定标准对截图与 DOM 数据评分。",
  pdf_methodology_title: "方法说明",
  pdf_no_scenarios: "本次审计未运行任何场景。",
  pdf_personas_in_run: "本次运行使用的角色",
  pdf_run_id_archival: "运行 ID",
  pdf_scenario_results_title: "场景结果",
  pdf_scenarios_in_run: "本次运行的场景",
  pdf_top_findings_title: "关键发现",
  pdf_wcag_section_title: "WCAG 合规摘要",
  pdf_wcag_section_intro:
    "无障碍违规按 WCAG 一致性级别和成功标准分组。计数来自 axe-core 引擎；完整标准描述请参考 W3C Understanding 文档。",
  pdf_wcag_no_a11y: "本次运行的 assert_a11y 步骤未检测到无障碍问题。",
  pdf_wcag_by_level: "按一致性级别",
  pdf_wcag_by_principle: "按四大原则",
  pdf_wcag_by_criterion: "违规最多的标准",
  pdf_wcag_principle_perceivable: "可感知",
  pdf_wcag_principle_operable: "可操作",
  pdf_wcag_principle_understandable: "可理解",
  pdf_wcag_principle_robust: "健壮",
  pdf_wcag_principle_unknown: "其他",
  pdf_wcag_level_unknown: "未知",
  pdf_wcag_count_label: "问题数",

  trends_chart_cost_hint: "每次运行的 AI 推理花费（美元）。持续上升提示评分流程低效或场景规模扩大。",
  trends_chart_cost_title: "成本趋势",
  trends_chart_dim_hint: "每个评分维度一条线。识别单一维度回归而总评分不变的情况。",
  trends_chart_dim_title: "各维度评分",
  trends_chart_issues_hint: "问题总数，严重问题单独高亮。越低越好。",
  trends_chart_issues_title: "问题数趋势",
  trends_chart_pwf_hint: "每次运行按状态统计的审计单元数。绿色条高 = 运行稳定；红色条增长 = 出现回归。",
  trends_chart_pwf_title: "通过 / 警告 / 失败分布",
  trends_chart_score_hint: "0–10 分制。越高越好。",
  trends_chart_score_title: "总评分",
  trends_empty_state: "尚无审计历史。运行 `pixelcheck run` 后再来查看趋势。",
  trends_runs_count_one: "1 次运行",
  trends_runs_count_other: "{n} 次运行",
  trends_title: "AI 浏览器审计 — 趋势",

  diff_cross_project: "跨项目对比",
  diff_footer_tail: "运行 ID",
  diff_headline_metrics: "关键指标",
  diff_no_changes: "两次运行之间未检测到有意义的体验变化。",
  diff_per_dimension_changes: "各维度变化",
  diff_resolved_issues: "已解决问题",
  diff_title: "AI 浏览器审计差异",
  diff_total_new: "新增问题",
  diff_total_resolved: "已解决问题",

  status_pass_full: "已通过",
  status_warn_full: "通过但有问题",
  status_fail_full: "失败",
};

const ja: Record<keyof typeof en, string> = {
  after: "後",
  audit_report_title: "AIブラウザ監査レポート",
  baseline: "（ベースライン）",
  before: "前",
  cost: "コスト",
  cost_unit_usd: "USD",
  critical: "致命的",
  critical_issues: "致命的な問題",
  date_label: "実行日",
  delta: "差分",
  dimension: "ディメンション",
  dimensions: "各ディメンション",
  duration: "所要時間",
  fail: "不合格",
  generated_by: "AIブラウザ監査ツールによって生成",
  high: "高",
  issues: "問題",
  latest_score: "最新スコア",
  low: "低",
  mean_last_30: "直近30回平均",
  mean_last_7: "直近7回平均",
  medium: "中",
  metric: "指標",
  no_data: "データなし",
  no_issues_found: "本実行で問題は検出されませんでした。",
  no_issues_raised: "問題は検出されませんでした。",
  overall_score: "総合スコア",
  pass: "合格",
  pass_with_issues: "警告つき合格",
  project_label: "プロジェクト",
  recommendation: "推奨",
  run_label: "実行",
  scenarios: "シナリオ",
  score: "スコア",
  score_scale: "0–10 スケール",
  status: "ステータス",
  steps: "ステップ",
  tag: "タグ",
  this_run: "（今回）",
  total: "合計",
  total_cost: "総コスト",
  total_issues: "問題の総数",
  total_scenarios: "実行シナリオ総数",
  url_label: "URL",

  pdf_disclaimer:
    "AIスコアはラベル付きフィクスチャセットで校正されており、10点満点で人間レビューと±1点以内の精度を持ちます。スコアは経験豊富なレビュアーが1回のユーザーセッションで観察する内容を反映しており、未テストフローの回帰がないことを保証するものではありません。完全な証拠（スクリーンショット、動画、コンソールログ）は同じ実行ディレクトリ内のaudit-explorer.htmlを開いてください。",
  pdf_findings_subtitle:
    "重要度順にソート。致命的・高優先度の問題は阻害要因、中・低は改善機会です。",
  pdf_methodology_intro:
    "AIブラウザ監査ツールは、ペルソナごとのデバイスフィンガープリントを設定した実際のChromiumブラウザセッションを起動し、スクリプト化されたユーザージャーニーをエンドツーエンドで実行します。実行後、AnthropicのClaudeビジョンモデルが定義済みのルーブリックに基づいてスクリーンショットとDOMデータをスコア付けします。",
  pdf_methodology_title: "方法論",
  pdf_no_scenarios: "本監査ではシナリオが実行されませんでした。",
  pdf_personas_in_run: "本実行のペルソナ",
  pdf_run_id_archival: "実行ID",
  pdf_scenario_results_title: "シナリオ結果",
  pdf_scenarios_in_run: "本実行のシナリオ",
  pdf_top_findings_title: "主要な検出",
  pdf_wcag_section_title: "WCAG準拠サマリー",
  pdf_wcag_section_intro:
    "アクセシビリティ違反をWCAG適合レベルおよび達成基準ごとに分類しました。件数はaxe-coreエンジンによるもの。基準の詳細はW3C Understanding 文書を参照してください。",
  pdf_wcag_no_a11y: "本実行のassert_a11yステップではアクセシビリティ問題は検出されませんでした。",
  pdf_wcag_by_level: "適合レベル別",
  pdf_wcag_by_principle: "原則別",
  pdf_wcag_by_criterion: "違反の多い基準",
  pdf_wcag_principle_perceivable: "知覚可能",
  pdf_wcag_principle_operable: "操作可能",
  pdf_wcag_principle_understandable: "理解可能",
  pdf_wcag_principle_robust: "堅牢",
  pdf_wcag_principle_unknown: "その他",
  pdf_wcag_level_unknown: "不明",
  pdf_wcag_count_label: "件数",

  trends_chart_cost_hint: "実行あたりのAI推論コスト（USD）。上昇傾向はスコアリングの非効率や対象範囲拡大を示唆します。",
  trends_chart_cost_title: "コストの推移",
  trends_chart_dim_hint: "スコアリングディメンション別の推移。総合スコア横ばいでも単一ディメンションの回帰を発見できます。",
  trends_chart_dim_title: "ディメンション別スコア",
  trends_chart_issues_hint: "問題の総数。致命的な問題は別線で強調。低いほど良好。",
  trends_chart_issues_title: "問題数の推移",
  trends_chart_pwf_hint: "実行ごとのステータス別ユニット数。緑が高いほど安定、赤が増加すれば回帰の兆候。",
  trends_chart_pwf_title: "合格 / 警告 / 不合格の内訳",
  trends_chart_score_hint: "0–10スケール。高いほど良好。",
  trends_chart_score_title: "総合スコア",
  trends_empty_state: "監査履歴がまだありません。`pixelcheck run` を実行してから再度ご覧ください。",
  trends_runs_count_one: "1回の実行",
  trends_runs_count_other: "{n}回の実行",
  trends_title: "AIブラウザ監査 — トレンド",

  diff_cross_project: "プロジェクト間差分",
  diff_footer_tail: "実行ID",
  diff_headline_metrics: "主要指標",
  diff_no_changes: "これらの実行間で意味のあるUX変化は検出されませんでした。",
  diff_per_dimension_changes: "ディメンション別変化",
  diff_resolved_issues: "解決済み問題",
  diff_title: "AIブラウザ監査差分",
  diff_total_new: "新規問題",
  diff_total_resolved: "解決済み問題",

  status_pass_full: "合格",
  status_warn_full: "警告つき合格",
  status_fail_full: "不合格",
};

const es: Record<keyof typeof en, string> = {
  after: "Después",
  audit_report_title: "Informe de Auditoría AI Browser",
  baseline: "(referencia)",
  before: "Antes",
  cost: "Coste",
  cost_unit_usd: "USD",
  critical: "crítico",
  critical_issues: "Incidencias críticas",
  date_label: "Fecha de ejecución",
  delta: "Variación",
  dimension: "Dimensión",
  dimensions: "Dimensiones",
  duration: "Duración",
  fail: "fallo",
  generated_by: "Generado por PixelCheck",
  high: "alto",
  issues: "Incidencias",
  latest_score: "Última puntuación",
  low: "bajo",
  mean_last_30: "Media últimos 30",
  mean_last_7: "Media últimos 7",
  medium: "medio",
  metric: "Métrica",
  no_data: "Sin datos",
  no_issues_found: "No se han detectado incidencias en esta ejecución.",
  no_issues_raised: "No se detectaron incidencias.",
  overall_score: "Puntuación general",
  pass: "aprobado",
  pass_with_issues: "aprobado con incidencias",
  project_label: "Proyecto",
  recommendation: "Recomendación",
  run_label: "Ejecución",
  scenarios: "Escenarios",
  score: "Puntuación",
  score_scale: "Escala 0–10",
  status: "Estado",
  steps: "pasos",
  tag: "Etiqueta",
  this_run: "(esta ejecución)",
  total: "Total",
  total_cost: "Coste total",
  total_issues: "Total de incidencias",
  total_scenarios: "Escenarios ejecutados",
  url_label: "URL",

  pdf_disclaimer:
    "La puntuación por IA está calibrada contra un conjunto de fixtures etiquetado y se mantiene dentro de ±1 punto de la revisión humana en una escala de 10. Las puntuaciones reflejan lo que un revisor experimentado vería en una sesión de usuario; no garantizan la ausencia de regresiones en flujos no probados. Para evidencia completa (capturas, vídeo, logs de consola), abra audit-explorer.html en el mismo directorio de ejecución.",
  pdf_findings_subtitle:
    "Ordenado por severidad. Las incidencias críticas/altas son bloqueantes; las medias/bajas son oportunidades de mejora.",
  pdf_methodology_intro:
    "PixelCheck lanza sesiones reales de Chromium con huellas digitales de dispositivo específicas por perfil y ejecuta recorridos de usuario de extremo a extremo. Tras cada ejecución, las capturas y datos del DOM se puntúan con el modelo de visión Claude de Anthropic siguiendo una rúbrica definida.",
  pdf_methodology_title: "Metodología",
  pdf_no_scenarios: "No se ejecutó ningún escenario en esta auditoría.",
  pdf_personas_in_run: "Perfiles en esta ejecución",
  pdf_run_id_archival: "ID de ejecución",
  pdf_scenario_results_title: "Resultados por escenario",
  pdf_scenarios_in_run: "Escenarios en esta ejecución",
  pdf_top_findings_title: "Hallazgos principales",
  pdf_wcag_section_title: "Resumen de cumplimiento WCAG",
  pdf_wcag_section_intro:
    "Incidencias de accesibilidad agrupadas por nivel de conformidad WCAG y criterio de éxito. Los recuentos provienen del motor axe-core; consulte los documentos Understanding del W3C para descripciones completas.",
  pdf_wcag_no_a11y:
    "El paso assert_a11y no detectó incidencias de accesibilidad en esta ejecución.",
  pdf_wcag_by_level: "Por nivel de conformidad",
  pdf_wcag_by_principle: "Por principio",
  pdf_wcag_by_criterion: "Criterios más infringidos",
  pdf_wcag_principle_perceivable: "Perceptible",
  pdf_wcag_principle_operable: "Operable",
  pdf_wcag_principle_understandable: "Comprensible",
  pdf_wcag_principle_robust: "Robusto",
  pdf_wcag_principle_unknown: "Otros",
  pdf_wcag_level_unknown: "Desconocido",
  pdf_wcag_count_label: "Incidencias",

  trends_chart_cost_hint: "USD gastados en inferencia por IA por ejecución. Una tendencia al alza sugiere ineficiencia o escenarios más extensos.",
  trends_chart_cost_title: "Coste en el tiempo",
  trends_chart_dim_hint: "Una línea por dimensión de puntuación. Detecte cuándo una dimensión retrocede mientras el total permanece estable.",
  trends_chart_dim_title: "Puntuaciones por dimensión",
  trends_chart_issues_hint: "Total de incidencias, con las críticas destacadas. Cuanto más bajo, mejor.",
  trends_chart_issues_title: "Incidencias en el tiempo",
  trends_chart_pwf_hint: "Recuento de unidades por estado, por ejecución. Barras verdes altas = consistencia; rojo creciente = regresión.",
  trends_chart_pwf_title: "Distribución Aprobado / Aviso / Fallo",
  trends_chart_score_hint: "Escala 0–10. Cuanto más alto, mejor.",
  trends_chart_score_title: "Puntuación general",
  trends_empty_state: "Aún no hay historial de auditorías. Ejecute `pixelcheck run` para alimentar el panel.",
  trends_runs_count_one: "1 ejecución",
  trends_runs_count_other: "{n} ejecuciones",
  trends_title: "Auditor AI Browser — Tendencias",

  diff_cross_project: "Diferencia entre proyectos",
  diff_footer_tail: "IDs de ejecución",
  diff_headline_metrics: "Métricas principales",
  diff_no_changes: "No se detectaron cambios significativos en la UX entre estas ejecuciones.",
  diff_per_dimension_changes: "Cambios por dimensión",
  diff_resolved_issues: "Incidencias resueltas",
  diff_title: "Diferencias de Auditoría AI Browser",
  diff_total_new: "Nuevas incidencias",
  diff_total_resolved: "Incidencias resueltas",

  status_pass_full: "Aprobado",
  status_warn_full: "Aprobado con incidencias",
  status_fail_full: "Fallido",
};

const de: Record<keyof typeof en, string> = {
  after: "Nachher",
  audit_report_title: "KI-Browser-Audit-Bericht",
  baseline: "(Referenz)",
  before: "Vorher",
  cost: "Kosten",
  cost_unit_usd: "USD",
  critical: "kritisch",
  critical_issues: "Kritische Probleme",
  date_label: "Lauf-Datum",
  delta: "Differenz",
  dimension: "Dimension",
  dimensions: "Dimensionen",
  duration: "Dauer",
  fail: "Fehler",
  generated_by: "Erstellt von KI-Browser-Auditor",
  high: "hoch",
  issues: "Probleme",
  latest_score: "Aktuelle Punktzahl",
  low: "niedrig",
  mean_last_30: "Durchschnitt letzte 30",
  mean_last_7: "Durchschnitt letzte 7",
  medium: "mittel",
  metric: "Kennzahl",
  no_data: "Keine Daten",
  no_issues_found: "In diesem Lauf wurden keine Probleme gefunden.",
  no_issues_raised: "Keine Probleme festgestellt.",
  overall_score: "Gesamtpunktzahl",
  pass: "bestanden",
  pass_with_issues: "bestanden mit Hinweisen",
  project_label: "Projekt",
  recommendation: "Empfehlung",
  run_label: "Lauf",
  scenarios: "Szenarien",
  score: "Punktzahl",
  score_scale: "Skala 0–10",
  status: "Status",
  steps: "Schritte",
  tag: "Etikett",
  this_run: "(dieser Lauf)",
  total: "Gesamt",
  total_cost: "Gesamtkosten",
  total_issues: "Gesamtzahl Probleme",
  total_scenarios: "Gesamtzahl Szenarien",
  url_label: "URL",

  pdf_disclaimer:
    "Die KI-Bewertung wurde gegen einen beschrifteten Fixture-Datensatz kalibriert und liegt auf einer 10-Punkte-Skala innerhalb von ±1 Punkt der menschlichen Prüfung. Die Punktzahlen spiegeln wider, was ein erfahrener Prüfer in einer einzelnen Nutzersitzung sehen würde — sie garantieren nicht das Ausbleiben von Regressionen in ungetesteten Abläufen. Für vollständige Belege (Screenshots, Video, Konsolen-Logs) öffnen Sie audit-explorer.html im selben Lauf-Verzeichnis.",
  pdf_findings_subtitle:
    "Nach Schweregrad sortiert. Kritische / hohe Probleme sind Blocker; mittlere / niedrige sind Verbesserungsgelegenheiten.",
  pdf_methodology_intro:
    "Der KI-Browser-Auditor startet echte Chromium-Browser-Sitzungen mit personenspezifischen Geräte-Fingerabdrücken und führt skriptgesteuerte Nutzerreisen Ende-zu-Ende aus. Nach jedem Lauf werden Screenshots und DOM-Daten vom Vision-Modell Claude von Anthropic anhand eines definierten Bewertungsschemas bewertet.",
  pdf_methodology_title: "Methodik",
  pdf_no_scenarios: "In diesem Audit wurden keine Szenarien ausgeführt.",
  pdf_personas_in_run: "Personas in diesem Lauf",
  pdf_run_id_archival: "Lauf-ID",
  pdf_scenario_results_title: "Szenario-Ergebnisse",
  pdf_scenarios_in_run: "Szenarien in diesem Lauf",
  pdf_top_findings_title: "Wichtigste Befunde",
  pdf_wcag_section_title: "WCAG-Konformitätsübersicht",
  pdf_wcag_section_intro:
    "Barrierefreiheits-Verstöße gruppiert nach WCAG-Konformitätsstufe und Erfolgskriterium. Zählungen stammen von der axe-core-Engine; vollständige Kriterien-Beschreibungen siehe W3C Understanding-Dokumente.",
  pdf_wcag_no_a11y:
    "Im assert_a11y-Schritt dieses Laufs wurden keine Barrierefreiheits-Probleme festgestellt.",
  pdf_wcag_by_level: "Nach Konformitätsstufe",
  pdf_wcag_by_principle: "Nach Prinzip",
  pdf_wcag_by_criterion: "Am häufigsten verletzte Kriterien",
  pdf_wcag_principle_perceivable: "Wahrnehmbar",
  pdf_wcag_principle_operable: "Bedienbar",
  pdf_wcag_principle_understandable: "Verständlich",
  pdf_wcag_principle_robust: "Robust",
  pdf_wcag_principle_unknown: "Sonstige",
  pdf_wcag_level_unknown: "Unbekannt",
  pdf_wcag_count_label: "Probleme",

  trends_chart_cost_hint: "USD-Aufwand für KI-Inferenz pro Lauf. Steigender Trend deutet auf ineffiziente Bewertung oder größere Szenarien hin.",
  trends_chart_cost_title: "Kosten im Zeitverlauf",
  trends_chart_dim_hint: "Eine Linie pro Bewertungsdimension. Erkennen Sie, wenn eine Dimension regrediert, während das Gesamt unverändert bleibt.",
  trends_chart_dim_title: "Punkte pro Dimension",
  trends_chart_issues_hint: "Gesamtzahl der Probleme, mit kritischen Problemen hervorgehoben. Niedriger ist besser.",
  trends_chart_issues_title: "Probleme im Zeitverlauf",
  trends_chart_pwf_hint: "Anzahl der Audit-Einheiten nach Status, pro Lauf. Hohe grüne Balken = stabile Läufe; wachsendes Rot = Regression.",
  trends_chart_pwf_title: "Verteilung Bestanden / Warnung / Fehler",
  trends_chart_score_hint: "Skala 0–10. Höher ist besser.",
  trends_chart_score_title: "Gesamtpunktzahl",
  trends_empty_state: "Noch kein Audit-Verlauf. Führen Sie `pixelcheck run` aus, um das Trend-Dashboard zu befüllen.",
  trends_runs_count_one: "1 Lauf",
  trends_runs_count_other: "{n} Läufe",
  trends_title: "KI-Browser-Audit — Trends",

  diff_cross_project: "Projektübergreifende Differenz",
  diff_footer_tail: "Lauf-IDs",
  diff_headline_metrics: "Kerngrößen",
  diff_no_changes:
    "Zwischen diesen Läufen wurden keine bedeutenden UX-Änderungen festgestellt.",
  diff_per_dimension_changes: "Änderungen pro Dimension",
  diff_resolved_issues: "Behobene Probleme",
  diff_title: "KI-Browser-Audit-Differenz",
  diff_total_new: "Neue Probleme",
  diff_total_resolved: "Behobene Probleme",

  status_pass_full: "Bestanden",
  status_warn_full: "Bestanden mit Hinweisen",
  status_fail_full: "Fehlgeschlagen",
};

const TRANSLATIONS = {
  en,
  "zh-CN": zhCN,
  ja,
  es,
  de,
} as const;

/**
 * Format a count with locale-aware pluralisation. Used for "{n} runs"
 * shown in the trends dashboard header.
 *
 *   formatRunsCount(1, "en")     → "1 run"
 *   formatRunsCount(3, "en")     → "3 runs"
 *   formatRunsCount(1, "zh-CN")  → "1 次运行"
 *   formatRunsCount(3, "zh-CN")  → "3 次运行" (Chinese has no plural form)
 */
export function formatRunsCount(n: number, locale: Locale = DEFAULT_LOCALE): string {
  const template =
    n === 1
      ? t("trends_runs_count_one", locale)
      : t("trends_runs_count_other", locale);
  return template.replace("{n}", String(n));
}
