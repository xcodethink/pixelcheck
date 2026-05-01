# ADR-027 — Lock to Zod v3 for v1.0（推迟 Zod v4 升级）

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: T0.5（Wave 0 dep upgrade）

## Context

`npm outdated` 显示 Zod 当前 3.25.76，latest 4.4.1。Zod v4（2025 年 5 月发布）是大版本升级。

Zod 在我们项目的使用面**非常广**：
- 30 个 published JSON Schemas 都从 Zod schemas 生成（`zod-to-json-schema`）
- `RESULT_SCHEMA_VERSION = "1.2.0"` 公开承诺（ADR-007）
- 全部 `safeParse` / `parse` 调用点（runner / handlers / MCP tools / reporters / config / personas / scenarios）—— grep 出 100+ 调用
- `tests/public-api-contract.test.ts` 锁了 Ajv ↔ Zod 等价性
- 67 个 public API exports 含 Schema 类型（`AuditRunSchema`, `IssueSchema`, etc）

## Zod v4 Breaking Changes（调研）

主要破坏点：
1. `.parse()` 错误对象 shape 变（`ZodError.issues` 字段重组）
2. `z.record()` 签名变
3. `z.string().email()` 等 validator API 部分签名调整
4. `transform` / `refine` 链式行为细节微调
5. `zod-to-json-schema` 第三方包**不一定立即兼容 v4**
6. TypeScript 类型推导算法重写，部分边界 case 类型推导结果变

升级 Zod v4 需要：
- 全仓库 grep 100+ 调用点 review
- `zod-to-json-schema` 兼容性验证（可能需换 npm 包）
- 30 个 published JSON Schemas 重新生成 + 跑 contract test 确认 Ajv ↔ Zod 等价性
- ResultSchema 的 SemVer 决策：是否触发 1.2 → 2.0 major bump？

预估工时：~8-12h（不止 T0.5 的 4h）。

## Decision

**v1.0 锁 Zod v3.25.x latest minor。Zod v4 升级延后到 v1.1.x 评估。**

具体：
- `package.json`: `zod: "^3.25.76"`（保持当前 caret semver，自动收 3.x.y patch）
- v4 升级作为独立 task **T-NEW-2** 入 RISK-REGISTER-V2
- 触发条件：(a) Zod v3 进入 maintenance-only / 出 critical CVE；(b) 我们自己有强需求用 v4 新功能；(c) `zod-to-json-schema` 公开 v4 stable 兼容版本
- 在 `docs/release-notes/v1.0.0.md` + `MIGRATION.md` 明确"v1.0 ships with Zod v3"

## Alternatives rejected

1. **现在升 Zod v4** —— T0.5 范围爆炸（4h → 12h+）；阻塞 v1 critical vuln 修复；引入未充分测试的大破坏
2. **锁 Zod 到精确版本**（`zod: "3.25.76"` no caret）—— 失去自动收 3.x patch（safety-relevant patches 也收不到）；过度保守
3. **fork Zod**（pin 一个 known-good fork） —— 维护负担巨大，v1 单维护者不可能
4. **换 ajv-only 不用 Zod runtime** —— 重写量更大；Zod 给 TypeScript inference 不可替代

## Consequences

- v1.0 ship 时所有 Zod schemas 走 v3 行为（runtime + types）
- 用户用 `import { AuditRunSchema, type AuditRun } from "ai-browser-auditor"` 拿到的是 Zod v3 类型；v1.x 内不变
- Result Schema 1.2.0 的 SemVer 承诺不受影响（SemVer 锚的是 published JSON Schemas + 我们的字段语义，与 Zod 库版本无关）
- v1.1 评估升 Zod v4 时，必须做 SemVer 决策：v4 升级如果不破坏现有用户的 `parse(input)` 行为 → v1.x minor；如果破坏 → v2.0 major

## 触发 v4 升级 review 的 signal

- Zod v4 stable + zod-to-json-schema v4 兼容包 release 双条件满足
- Zod v3 出 CVE 且 v3 不再发 patch
- 用户 demand v4-only feature（如新的 metaprogramming API）
- v1.x 累计积累足够其他改动一起升

## Files changed

- `package.json`: `"zod": "^3.25.76"`（保持现状）
- `docs/decisions/ADR-027-zod-3-lock-in.md`（this file）
- RISK-REGISTER-V2 加 T-NEW-2（Zod v4 升级评估）
