# ADR-028 — Defer Stagehand v3 upgrade to a dedicated task（v1.0 ship Stagehand v2.5.8）

- **Status**: Superseded by [ADR-035](ADR-035-stagehand-v3-migration.md) (2026-05-03; originally filed as ADR-029, renumbered 2026-05-05)
- **Date**: 2026-05-01
- **Task**: T0.5（Wave 0 dep upgrade）

> **Update 2026-05-03**: T-NEW-1 was executed earlier than the original
> "v1.1 early task" plan — see ADR-035 for the actual migration record.
> The transitive vulnerability waiver in this ADR is now closed
> (Stagehand v3 dropped the vulnerable `ai` SDK / `jsondiffpatch`
> versions). The original deferral reasoning is preserved here for
> historical context.

## Context

`npm outdated` 显示 Stagehand 当前 2.5.8，latest 3.3.0。Stagehand v3（2025 Q4 发布）是大版本破坏性升级。

Stagehand 在我们项目里的使用面：
- 5 个核心 primitive (`act` / `extract` / `audit_url` / `explore_url` / 部分 `judge` 通过 navigator)
- `src/core/stagehand-wrapper.ts` 含 `StagehandLike` interface 锚 v2.5 API shape
- `src/cli.ts` line 875 注释明确"Stagehand 2.5 …"
- `src/agent/instruction-mutator.ts` 调 `observe()` 自动发现 selectors（v3 重命名为 `action`）
- `src/benchmark/executor.ts` 用 `createStagehandWrapper`

## Stagehand v3 Breaking Changes（来自 v3 migration guide）

1. **`act()` 签名变更**：v2 接受 action 对象 → v3 接受 instruction 字符串直接调用
2. **`observe()` 重命名为 `action`**：返回类型 `observeResult` → `action`
3. **移除内部 Playwright 依赖**：v3 BYO Playwright（Playwright / Puppeteer / Patchright 都可）—— 我们的 wrapper 需要重新接线
4. **新增 non-AI primitives**：`page` / `locator` / `frameLocator` / `deepLocator` —— 需评估是否替换我们部分 deterministic 路径
5. **CSS selector 支持** + iframe / shadow root 选择器扩展
6. **Action 缓存自动化** + 20-40% 速度提升（机会，不破坏）
7. **bun 兼容性**（机会）

升级影响范围：
- `src/core/stagehand-wrapper.ts` 重写（~150 LoC）
- `src/agent/instruction-mutator.ts` 改 observe→action（~20 行）
- 全部 `act()` 调用点 review
- `tests/instruction-mutator.test.ts` + `tests/instruction-mutator-extended.test.ts` 重写 mock shape
- `tests/integration/playwright/stagehand-smoke.test.ts`（M6-5 T5 任务）必须全部用新 API

预估工时：~6-8h（不止 T0.5 的 4h），且**必须配合 M6-5 T5 真 Stagehand smoke e2e 一起做**才能验证升级正确性。

## Stagehand v2.5.8 Transitive Vulnerabilities（升级前）

T0.5 跑 `npm audit fix` 后剩 3 vulns（来自 Stagehand v2.5.8 间接依赖）：

| 包 | 严重度 | CVE | 我们使用面 |
|---|---|---|---|
| `ai` (Vercel AI SDK) | moderate | GHSA-rwvc-j5jr-mgvh — 文件类型白名单 bypass | **不使用 ai SDK 文件上传功能**（仅作为 Stagehand 内部依赖被拉入）—— 不可利用 |
| `jsondiffpatch` | moderate | GHSA-33vc-wfww-vjfv — `HtmlFormatter::nodeBegin` XSS | **不使用 HtmlFormatter**（jsondiffpatch 是 Stagehand 内部 plan diffing 用，不渲染 HTML） —— 不可利用 |
| 1 low（未具体列名） | low | — | — |

这些 vulns 在 Stagehand v3 全部清掉（v3 重写不再依赖 vulnerable ai/jsondiffpatch 版本）。但 v3 升级是独立任务。

## Decision

**v1.0 ship Stagehand v2.5.8。Stagehand v3 升级作为独立任务 T-NEW-1 入 RISK-REGISTER-V2。**

具体：
- `package.json`: `@browserbasehq/stagehand: "^2.0.0"`（保持，但锁 v2 major）
- 3 transitive vulns 在 `SECURITY.md` 文档化为"non-exploitable in our usage"
- CI gate 调整：`npm audit --audit-level=high`（不是 moderate） + 在 SECURITY.md 列 known-accepted moderate
- T-NEW-1 排进 v1.1 早期：upgrade Stagehand v3 + 重写 wrapper + 配合 M6-5 T5 真 e2e smoke

## Alternatives rejected

1. **现在升 Stagehand v3 in T0.5** —— 范围爆炸（4h → 8h+）；阻塞 critical vuln 修复；v3 wrapper 重写需要配合真 e2e smoke 才能验证（M6-5 T5 还没建）
2. **使用 npm overrides 强制 nested transitive 升 latest** —— 风险：Stagehand v2 没在新 transitive 版上测过，可能运行时 break；package overrides 是逃避 root cause 的 hack
3. **降级 Stagehand 到没有这些 transitive 的更老 v2 版本** —— 反向操作；老版本只会引入更多 vulns + 缺 v2.5 修过的 bug
4. **fork Stagehand v2** —— 维护负担巨大
5. **抛弃 Stagehand 改用 Playwright 直调 + LLM** —— 重写整个 act/extract 语义层，~30+ 工时

## Consequences

- T-NEW-1（Stagehand v3 升级）入 RISK-REGISTER-V2 P0（v1.1 必做）
- v1.0 SECURITY.md 明确文档化 3 transitive vulns + non-exploitable rationale
- CI gate `npm audit --audit-level=high` 不阻断这 3 个 moderate
- 用户的 v1.0 → v1.1 升级会感受到 Stagehand v3 的 act/observe API 变化（不影响公共 API 用户，因为我们的 wrapper 屏蔽掉了 Stagehand —— 用户调的是我们的 `act` primitive）
- 性能：v3 自动 action caching 20-40% 速度提升 —— v1.1 升级后 audit_url 应该更快

## 触发 v3 升级的 signal

T-NEW-1 单一任务：v1.0 ship 后第一个 minor cycle（v1.1）的最早任务，**不晚于 v1.1 release**。

具体顺序：
1. v1.0 ship（含 Stagehand v2.5.8）
2. v1.1 cycle T-NEW-1 单独任务：升 Stagehand v3 + wrapper 重写 + M6-5 T5 真 e2e smoke 验证
3. 重新跑 `npm audit` 应该 0 critical / 0 moderate

## Files changed

- `package.json`: `"@browserbasehq/stagehand": "^2.0.0"`（保持现状，与 peer dep dotenv@^16 兼容）
- `docs/decisions/ADR-028-stagehand-v3-deferred.md`（this file）
- RISK-REGISTER-V2 加 T-NEW-1（Stagehand v3 升级 P0 v1.1）
- `SECURITY.md`（待 T19 task 写）含 3 transitive vulns waiver
