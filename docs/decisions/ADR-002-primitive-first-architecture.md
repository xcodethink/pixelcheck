# ADR-002: Primitive-first 架构（audit 降为预设组合）

- **状态**：Accepted
- **日期**：2026-04-25
- **决策者**：Wayne
- **依赖**：[ADR-001 AI-first 定位](./ADR-001-AI-first-positioning.md)

---

## Context

v0.3 的核心抽象是 **AuditRun**：

```
audit run = scenario × persona × URL → AuditResult
```

这个抽象使所有能力都被框在"做一次审计"的范式里：
- 想"看一眼"某 URL → 必须造一个最小 scenario + persona 走 audit run
- 想"对比 A/B" → 跑两次 audit run 然后用 diff
- 想"调研 5 个站" → 跑 5 次 audit run
- 想让 AI "完成注册" → 必须把注册写成 scenario YAML

但 ADR-001 锁定的 AI-first 定位下，AI 真正想要的是**底层 primitives**：

```
AI: "帮我看一眼 stripe.com 的定价页"
    → 直接 see('https://stripe.com/pricing')，不需要造 audit

AI: "对比 5 个 SaaS pricing 页面，告诉我谁最人性化"
    → for each site: see + extract → compare 全部
    → 不是"5 次 audit run"

AI: "我刚改了 CSS，去看看实际渲染"
    → 单次 see 即可

AI: "去这个网站注册一个号"
    → register primitive，不是 scenario YAML
```

继续以 audit run 为核心抽象，会强迫 AI 用错误的颗粒度调用工具，**生产环境 AI 反复 burn token 跑过度抽象的流程**。

---

## Decision

**v1.0 架构以 primitives 为一等公民，audit 降级为 primitive 的预设组合（preset）。**

### 新模型

```
primitives:
  - see(url, opts)              ← 视觉 + DOM + 网络
  - act(url, steps)             ← 动作序列
  - compare(a, b, criteria)     ← A/B 对比 + 审美
  - extract(url, schema)        ← 结构化提取
  - register(service, profile)  ← 调研型注册
  - critic(target, rubric)      ← 通用判断
  - ...

presets（primitive 组合的便利 wrapper）:
  - audit_run = preset(see + act + critic + report)
  - research_workflow = preset(see × N + extract × N + compare)
  - ux_test = preset(act + see + critic)
  - register_evaluate = preset(register + see + critic)
```

### MCP 暴露

每个 primitive 是一个独立的 MCP tool：
```
mcp__pixelcheck__see
mcp__pixelcheck__act
mcp__pixelcheck__compare
mcp__pixelcheck__extract
mcp__pixelcheck__register
mcp__pixelcheck__audit_url       ← 预设的薄包装
mcp__pixelcheck__list_personas
...
```

AI 可以**自由组合调用**，也可以走预设。

### v0.3 兼容

- `pixelcheck audit ...` CLI 命令保留为预设的薄 shim
- 用户旧 personas / scenarios YAML 依然能跑（通过 shim 翻译为新 primitives）
- Wayne 一人用 → 不需要复杂的 deprecation policy

---

## Consequences

### 正面

- AI 调用颗粒度匹配实际需求 → 节省 token / 节省时间
- Primitive 可被多种 preset 复用 → 代码 DRY
- 添加新 preset（research / register-evaluate / ...）几乎零成本
- 测试更容易：每个 primitive 独立测试 + preset 组合测试
- MCP tool surface 更清晰

### 负面

- 现有代码大量重写：runner / handlers / agent-loop 都要解构成 primitives
- v0.3 的 audit-centric 文档需要全部更新
- 学习曲线：新用户既要懂 primitives 又要懂 preset
- 设计风险：primitives 颗粒度切错（太细 = AI 调用过多次；太粗 = 灵活性不足）

### 中性

- audit 这个词在 v1 里仍然存在（作为预设名），不会让 v0.3 用户彻底迷失
- HTML 报告依然产出（从 audit preset 输出），但不是核心

---

## Primitive 设计原则（v1.0 起强制）

1. **每个 primitive 单独可测试**：不依赖其他 primitive 的副作用
2. **输入输出都用 Zod / JSON Schema 定义**：AI 消费的契约
3. **副作用集中在 primitive 内部**：浏览器启动 / 网络请求 / DB 写入都有明确 owner
4. **支持 dry-run**：每个 primitive 提供 `dry_run: true` 选项给 AI 预览不执行
5. **可组合性优先**：返回值结构要让下一个 primitive 能消费
6. **Result schema 版本化**：每个 primitive 独立 SemVer

---

## Alternatives Considered

### A. 保持 audit-centric，添加 primitives 作为"高级 API"

**不选**。两套抽象并存 = 用户混乱 + 维护成本翻倍。

### B. 完全废弃 audit 概念

**不选**。Audit 仍是有用的预设（一种常见组合），保留作为 preset 而不是核心。

### C. 让 audit 自动从 primitives 反推（用户写 audit YAML，系统转 primitives）

**不选**。中间层抽象增加复杂度，不解决根本问题。

---

## References

- ADR-001：[AI-first 定位](./ADR-001-AI-first-positioning.md)
- 主方案 v3.0 第 5 部分：[架构原则](../../../project-internal planning)
