# ADR-030 — axe-core standard 累积展开（T-NEW-11，关 RISK-REGISTER R-NEW-11）

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: T-NEW-11（衍生于 T6 axe + SARIF 验证）
- **Closes**: RISK-REGISTER-V2 R-NEW-11

## Context

T6（真 axe + SARIF 验证）跑 fixture 时发现一个 **production bug**：

`src/handlers/index.ts handleAssertA11y` 把用户传入的 `step.standard`
（默认 `"wcag2aa"`）直接作为单元素数组传给 axe-core：

```ts
runOnly: { type: "tag", values: [runOpts.standard] }
```

axe-core 的 `runOnly: { type: "tag", values }` 是**精确匹配**——传
`["wcag2aa"]` 只跑标记为 `wcag2aa` 的规则，**不含** Level A 规则。

具体后果：
- `image-alt` (WCAG 1.1.1, Level A, axe tag `wcag2a`) — **不会被检测**
- `label` (WCAG 4.1.2, Level A) — **不会被检测**
- `button-name` (WCAG 4.1.2, Level A) — **不会被检测**
- `link-name` (WCAG 2.4.4, Level A) — **不会被检测**

但 `color-contrast` (WCAG 1.4.3, Level AA, tag `wcag2aa`) — 被检测 ✓

含义：**任何用 `standard: "wcag2aa"` 跑生产 audit 的用户结果都严重低估
a11y 违规数**。Level A 是 AA 的子集（"AA 包含 A"），用户期望 AA 测试
覆盖 A，但 axe 不这么自动展开。

## Decision

新增 `expandAxeStandard()` 辅助函数到 `src/core/wcag.ts`，把单一 standard
展开为完整累积 tag 列表，handler 调用 axe 前用它展开：

```ts
const axeTags = expandAxeStandard(standard);
// "wcag2aa"  → ["wcag2a", "wcag2aa"]
// "wcag22aa" → ["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]
// "best-practice" → ["best-practice"]  (axe 自家规则不累积)
```

完整展开表（cumulative across version × level）：

| 输入 | 输出 |
|---|---|
| `wcag2a` | `["wcag2a"]` |
| `wcag2aa` | `["wcag2a", "wcag2aa"]` |
| `wcag2aaa` | `["wcag2a", "wcag2aa", "wcag2aaa"]` |
| `wcag21a` | `["wcag2a", "wcag21a"]` |
| `wcag21aa` | `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]` |
| `wcag22a` | `["wcag2a", "wcag21a", "wcag22a"]` |
| `wcag22aa` | `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]` |
| `best-practice` | `["best-practice"]` |
| 未知值 | 原样返回（防御性 fallback） |

### Schema 变更

`AssertA11yStepSchema` 的 `standard` enum 加入 `wcag22a`（之前漏，axe 实际有此 tag），现在 8 个值。`wcag2aaa` / `wcag21aaa` / `wcag22aaa` 中只保留 `wcag2aaa`（AAA 商业 audit 极少要求；axe 本身在 2.1/2.2 也很少标 AAA tag）。

### 验证

- **12 个新单测**（`tests/wcag.test.ts > expandAxeStandard`）：表驱动覆盖 8 个 enum + 未知值 fallback + 数组隔离 + Level A regression guard + WCAG 2.2 AA 完整 6 标签
- **集成测试更新**（`tests/integration/playwright/wcag-axe.test.ts`）：第 1 测原本手动传 `["wcag2a", "wcag2aa"]`，改用 `expandAxeStandard("wcag2aa")` —— 同步走生产路径
- **行业惯例对齐**：axe-core 官方 docs 推荐"WCAG 2.2 AA 完整 conformance"传 `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]`，与本展开一致

## Alternatives rejected

1. **不修，让用户自己传完整数组** —— 把行业惯用的 axe 陷阱让用户每次踩；违 "best-practice" 默认安全
2. **改 enum 加 "wcag2-all" / "wcag22-aa-cumulative" 等显式值** —— 违 axe 标准 tag 命名；用户需要重新学一套
3. **直接用 `[standard].concat(["wcag2a"])`**（硬编码加 A） —— 不能处理 21aa / 22aa；不优雅
4. **保留旧行为 + warn**（runtime warning 提醒） —— a11y audit 是 commercial 必查项，warn 比 silent miss 好但不如直接修；warn 还会污染 logger
5. **用 axe 的 `tags` filter 全跑然后 post-filter** —— 更慢 + 浪费；axe runOnly 就是为这个性能场景设计
6. **AAA 完整支持 wcag21aaa / wcag22aaa** —— v1 范围之外（AAA 商业 audit 极少；如有用户要求再加一行展开表）

## Consequences

- **生产 audit 准确性立即提升**：用 `wcag2aa` 默认值的所有 audit 现在会检测 Level A 违规。**用户老 audit 跟新 audit 对比可能违规数显著增加** —— 需要在 v1.0 release notes / MIGRATION.md 明确说明（"v1.0 修了 a11y 漏检 bug，相同站点 Level A 违规数会增加"）。
- **公共 API 不变**：`AssertA11yStepSchema` 多一个 enum 值（`wcag22a`），但 schema 是输入约束（生产者格式），不是输出 Result Schema（消费者契约），所以**不触发 SemVer major bump**（输入容忍度从 7 → 8 个值是 backward-compatible）。
- **Result Schema 1.2.0 不变**（无需 RESULT_SCHEMA_VERSION bump）。
- **`expandAxeStandard` 现在是公共 API 的一部分**（待 src/index.ts 添加 export 时纳入；本次 commit 暂不导出，T-NEW-11.x follow-up 视用户需求决定）。

## Files added / changed

- `src/core/wcag.ts` — 加 `AxeStandard` 类型 + `STANDARD_EXPANSIONS` 常量表 + `expandAxeStandard()` 函数（~70 LoC）
- `src/core/types.ts` — `AssertA11yStepSchema.standard` enum 加 `wcag22a` + 注释说明展开行为
- `src/handlers/index.ts` — `handleAssertA11y` import `expandAxeStandard` + 用 `expandAxeStandard(standard)` 替代 `[standard]`
- `tests/wcag.test.ts` — 12 个新 `expandAxeStandard` 测试（表驱动 8 + fallback + 数组隔离 + regression guard + 完整展开）
- `tests/integration/playwright/wcag-axe.test.ts` — 第 1+2 测改用 `expandAxeStandard("wcag2aa")` 走生产路径
- `docs/decisions/ADR-030-axe-standard-cumulative-expansion.md` — 此 ADR
