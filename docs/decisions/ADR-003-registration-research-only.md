# ADR-003: 注册能力仅限调研用途

- **状态**：Accepted
- **日期**：2026-04-25
- **决策者**：Wayne
- **依赖**：[ADR-001 AI-first 定位](./ADR-001-AI-first-positioning.md)

---

## Context

ADR-001 锁定 AI-first 定位后，PixelCheck v1 必然要支持"AI 帮用户在第三方网站注册账号"的能力（见 N-5 primitive `register(service, profile)`）。这个能力对应的真实使用场景：

- AI 调研：评估某个 SaaS 的注册流程是否顺畅
- AI 写竞品报告：实际体验竞品产品需要先注册
- AI 帮用户做产品评估：注册一次然后看看实际功能
- AI 测试自己写的代码：注册账号验证完整用户路径

但同样这个能力如果被滥用，可能造成：

- 批量虚假注册（运营黑产）
- 自动化薅羊毛（注册赠送 / 邀请码奖励）
- 绕过反作弊批量创建身份
- 违反第三方网站 ToS（绝大多数禁止自动化注册）

需要在能力设计阶段就划清边界，避免 PixelCheck 成为"自动化注册黑产工具"。

---

## Decision

**N-5 register primitive 仅支持调研型注册，禁止用于批量注册。**

### 设计约束

1. **默认行为 = 单次有意图**：
   - 一次调用 = 一次注册行动
   - 必须显式指定 service + profile，不接受批量参数
   - 不内置任何"注册 N 次"的循环抽象

2. **测试身份池（N-7）只服务"不污染主账号"**：
   - 池里的身份是 Wayne / 团队成员的真实测试身份（自己拥有的备用账号）
   - 不生成虚假身份信息（虚构姓名 / 虚构手机号 / 虚构地址）
   - 不对接接码平台 / 虚拟手机号服务

3. **频率限制（在 N-5 内强制）**：
   - 同一 service 同一身份：24 小时内最多 1 次注册
   - 同一 service 跨身份：24 小时内最多 5 次（足够调研一次，不足以批量）
   - 全局：单个 PixelCheck 实例 24 小时内最多 50 次注册调用
   - 限制硬编码在 primitive 内，不暴露 config 让用户调高

4. **强制日志 + 审计**：
   - 每次 register 调用记录到本地 audit log（M5-2）
   - 包含：时间戳、target service、用了哪个身份、成功 / 失败、调用方（AI / CLI）
   - 不可关闭

5. **风险提示文档强制**：
   - README 显眼位置标注：注册能力仅供调研
   - CLI / MCP 调用 register 时输出警告："此能力仅用于调研，禁止批量注册 / 黑产用途，违反第三方 ToS 风险自负"
   - 第一次使用强制确认（环境变量 `PIXELCHECK_AGREE_REGISTER_TOS=1` 才生效）

6. **不支持的能力（明确禁止 PR）**：
   - 接码平台对接
   - 自动化绕过 captcha
   - 批量注册脚本 / 命令
   - 虚构身份生成
   - 大批量代理 IP 池

---

## Consequences

### 正面

- 法律 / 合规风险显著降低：能力设计上就禁止滥用，不依赖"用户自觉"
- OSS 发布时不会被打上"注册黑产工具"标签 → 社区接受度高
- 与 GitHub / npm / 主要发行平台的 acceptable use policy 兼容
- 为团队 / 公司用户提供合规背书：能在 enterprise 环境推广

### 负面

- 主动放弃了一部分"灰色市场"用户（运营黑产）
- 频率限制可能误伤合法的密集调研场景（例如一次性评估 100 个 SaaS）—— 通过提供"分批调研"指南缓解
- captcha 等反爬场景下注册可能失败 → 降级为提示用户"该站点反爬严，需要人工辅助"，不试图绕过

### 中性

- 与法律 / 合规专家咨询的差距：本 ADR 是工程层面的"安全边界"，不是法律意见
- 用户 fork 后修改限制是 OSS 性质 → 不可避免，但 PixelCheck 主线不背锅

---

## Alternatives Considered

### A. 不做 register 能力，让 AI 自己用 act 拼接

**不选**。act 拼接出注册流程对 AI 调用成本过高，且无法集中管控滥用。

### B. 做完整 register 能力，不加限制

**不选**。法律 + 合规风险高，OSS 发布会被审查。

### C. 只在 enterprise 版本做 register

**不选**。AI-first 定位下 register 是核心能力，缺它影响整体价值。

---

## Implementation Notes

实现 N-5 时需明确：

```typescript
// 必须的接口
async register(opts: {
  service: string;          // target service URL
  profile: TestIdentity;    // 来自 N-7 测试身份池
  intent: string;           // 调研意图描述（必填，写入 audit log）
  agree_to_tos: boolean;    // 必须 true 才执行
}): Promise<RegisterResult>

// 内部强制
if (!opts.agree_to_tos) throw new Error("Must accept registration ToS warning");
if (await rateLimitExceeded(...)) throw new Error("Rate limit: research-only mode");
await auditLog.write({ action: 'register', ... });
```

---

## References

- ADR-001：[AI-first 定位](./ADR-001-AI-first-positioning.md)
- N-5 任务规格：主方案 v3.0 第 2.4 节
- M5-2 任务规格（audit log）：主方案 v3.0 第 2.3 节
