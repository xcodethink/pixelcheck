# ADR-001: AI-first 产品定位

- **状态**：Accepted
- **日期**：2026-04-25
- **决策者**：Wayne
- **方案**：[PixelCheck v1.0 v3.0 方案](../../../project-internal planning)

---

## Context

PixelCheck v0.3 的现有产品形态是"为人类开发者设计的浏览器审计工具"：
- 主用户：开发者运行 CLI / 配置 CI 跑 audit
- 主输出：HTML 报告、PDF（计划中）、CI 报错信息
- 主使用场景：每次部署后跑 audit 检查 UX 回归

继续这条路线规划 v1，会得到一个"更精致的人类审计工具"，但**完全没有解决一个真实的更大的问题**：

**AI 写代码不能看见自己的成果**。Claude Code、Codex、其他 AI agent 写完前端代码后，无法：
- 真实看到渲染效果
- 判断"这个按钮看起来对不对"
- 测试用户实际操作流程
- 调研竞品或参考站点
- 完成一次真实注册评估
- 持续追踪同一站点的变化

这个能力缺口比"人类有更好的审计工具"重要数量级，因为：
- AI 反复调用工具的总频率 >> 人类手动调用
- AI 的盲区（无视觉、无审美、无手）阻碍了 AI 工程的整体上限
- 给 AI 装上眼睛和手 = 改变 AI 写前端代码的工作方式

---

## Decision

**PixelCheck v1.0 重新定位为：AI 用来与可视化网络世界交互的通用基础设施。**

具体表现：

1. **主接口是 MCP server**（不是 CLI）。99% 的调用来自 AI agent，CLI 只用于 Wayne 手动 debug。

2. **能力面是 AI 的"感官 + 行动" primitives**：
   - 眼睛：see / OCR / 视觉 diff / 元素定位
   - 手：act / 表单填写 / 调研型注册
   - 审美：通用 critic（不只是 WCAG）
   - 记忆：跨会话登录态 / 站点学习
   - 嘴：标准化 result schema + 自由 research summary
   - 身份：Persona / 反指纹 / 测试身份池

3. **Audit 是预设组合，不是核心抽象**（参考 ADR-002）。原 v0.3 audit 流程在 v1 里降级为 primitives 的一种特定组合。

4. **输出格式 AI-friendly 优先**：
   - JSON Schema 规范化的 result（强契约 + SemVer）
   - HTML / PDF 是衍生物
   - 报告 i18n 等"人类阅读体验"优化降低优先级

5. **服务于商业 / OSS / 团队场景，但不做 SaaS 基础设施**：
   - 保留：单测、契约测试、PR Bot、Marketplace Action、文档、白皮书
   - 砍掉：多租户、HTTP server、PostgreSQL、远程存储、服务端监控

6. **生命周期路线**：Wayne 个人用 → 团队用 → OSS 公开 → 远期可能 SaaS（不在本轮）

---

## Consequences

### 正面

- 切到一个**更大的市场**：AI agent 反复使用 > 人类开发者偶尔使用
- 与 Anthropic Computer Use / Browserbase / Playwright MCP 等同方向产品形成差异化（PixelCheck 加了"审美 + persona + 跨会话记忆"层）
- 为后续 SaaS 演进保留可能性（不堵死任何路）
- 现有 v0.3 用户依然能用（audit shim 保留）

### 负面

- 工作量从原 v2.0 的 47 项扩到 56 项（+19%）
- 需要一次架构重写（v0.3 → v1.0），不是渐进升级
- 需要 worktree 隔离开发（参考 ADR-004），增加协调成本
- 部分 v0.3 的"人类 UX 优化"投入价值降低（但保留作为 OSS 友好性）

### 中性

- v0.3 audit 接口仍可用（作为 primitive 预设）
- v1.0 是 breaking change（pre-1.0 OSS 软件惯例允许）

---

## Alternatives Considered

### A. 继续 v0.3 路线，做"更精致的人类审计工具"

**不选**。本质问题没解决，人类审计工具的市场上限远低于 AI 工具基础设施。

### B. 砍到只做 MCP server，纯 AI 工具

**不选**。商业 / OSS / 团队场景仍有价值（团队 review、OSS 社区贡献），保留人类入口性价比合算。

### C. 中期演进，先做 v0.3.1 渐进改进，v1 留远期

**不选**。每次小改进都是机会成本，应该一次重写到位。

---

## References

- 主方案：[`project-internal planning`](../../../project-internal planning)（v3.0）
- ADR-002：[Primitive-first 架构](./ADR-002-primitive-first-architecture.md)
- ADR-004：[Worktree-isolated 开发 + Big Bang 切换](./ADR-004-worktree-isolated-development.md)
