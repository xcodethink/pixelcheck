# Research: Pre-ship Positioning & Naming Audit

- **Module ID**: W1-pre-ship
- **Date**: 2026-05-01
- **SOP Step**: 1 (Research) → 2 (Impact) → 3 (Design) → 4 (Risk) → **5 (Awaiting user confirm)**
- **Trigger**: v1.0 即将 npm publish；执行前发现品牌叙事与 ADR-001 战略定位不一致

---

## 1. 问题陈述

v1.0 ship 在即（0 P0 blocker，1853 测试，570 KB tarball），但 **launch 文案与 README 头部仍使用 v0.x 旧定位**，跟 [ADR-001 AI-first 产品定位](../decisions/) 决议不一致。

如果按现状 publish，市场看到的是"又一个 UX 审计工具"，而项目实际架构（MCP-first / 5 primitives / single-tenant local-first）是更稀缺的"AI 用来与可视化网络交互的基础设施"。**最关键的开源传播窗口（HN/Reddit/Show HN 首发）会用错误的故事进入市场，且不可逆**。

## 2. 证据

| 文件 | 当前定位文案 | ADR-001 期望定位 | 一致性 |
|---|---|---|---|
| `package.json` `name` | `ai-browser-auditor` | `pixelcheck`（OpenTools 主方案统一名） | ❌ 名称未改 |
| `package.json` `description` | `"AI-driven post-deployment UX audit. Real browser, real personas, real scenarios, commercial-grade evaluation."` | "AI-first MCP infrastructure for browser primitives" | ❌ 旧定位 |
| `README.md` H1 | `AI Browser Auditor` | `PixelCheck`（或保留 + 副标题） | ❌ |
| `README.md` 副标题 | `Your AI-powered product experience reviewer. Deploys real browsers. Simulates real users. Delivers real verdicts.` | "MCP-first browser primitives for AI agents" | ❌ |
| `README.md` body | 25 处 MCP + 14 处 primitive 提及 | — | ⚠️ 实质内容已对齐，**但被旧 H1 框死** |
| `docs/launch-post.md` | "I built an open-source tool that launches real browsers as 18 different users from 15 countries..." | "I built an open-source MCP server that gives AI agents real eyes and hands on the web..." | ❌ 100% 旧定位 |
| `docs/launch-post-zh.md` | "我开源了一个工具：启动真实浏览器，模拟 15 个国家的 18 种用户" | "我开源了一个 MCP server，给 AI agent 装上看网页的眼睛和操作浏览器的手" | ❌ 100% 旧定位 |
| `docs/show-hn.md` | "Show HN: AI Browser Auditor -- launches real browsers as 18 personas to audit your product" | "Show HN: PixelCheck — MCP server giving AI agents real eyes and hands on the web" | ❌ 100% 旧定位 |

## 3. 为什么这是 ship-blocker 级别（不是 cosmetic）

### 3.1 商业级标准对照
- **品牌一致性**：v1.0 launch 是品牌奠基时刻。npm 包名 + GitHub repo + HN 标题 + Reddit 帖 + Twitter 转发的故事必须完全一致
- **不可逆性**：npm 包名一旦 publish，改名要么放弃 stars/版本历史（重发新包），要么走 deprecated 通知 + 迁移指南，体验差
- **GTM 杠杆**：HN/Show HN 一次性流量峰值，用错故事 = 浪费窗口

### 3.2 战略一致性对照
- ADR-001 (2026-04-25) 明文: "PixelCheck v1.0 重新定位为：AI 用来与可视化网络世界交互的通用基础设施" + "主接口是 MCP server（不是 CLI）。99% 的调用来自 AI agent"
- ADR-002 (2026-04-25): "Audit 是 primitive 的预设组合，不是产品核心"
- 当前 launch 文案讲的是 v0.x 故事，**不是 v1.0 故事**

### 3.3 技术一致性对照
- 实际架构已是 MCP-first（17 个 tools / 5 primitives / `ai-audit-mcp` binary 已存在）
- 但 launch 文案完全没提"AI agent 用"这个核心使用场景
- 用户读完 README 后会期待"我手动跑 audit"，跟实际 99% 用法（AI 通过 MCP 调用）错位

## 4. 影响范围分析（Step 2）

如果选 "Option A：完整对齐 ADR-001"，影响以下文件：

| 类别 | 文件 | 改动量 |
|---|---|---|
| **元数据** | `package.json` (name + description + keywords) | ~10 行 |
| **README 头部** | `README.md` H1 + tagline + 第一节 | ~30 行 |
| **README body** | `README.md` quick start / "Built With" / "How Is This Different" | ~50 行 |
| **Launch 三套** | `docs/launch-post.md` + `docs/launch-post-zh.md` + `docs/show-hn.md` | 三份完整重写 |
| **CHANGELOG** | `CHANGELOG.md` v1.0.0 entry 加 "Renamed to PixelCheck" 段 | ~15 行 |
| **MIGRATION** | `MIGRATION.md` 加 v0.x → v1.0 重命名/重定位指南 | ~50 行 |
| **ADR-033** | 新建 `docs/decisions/ADR-033-rename-to-pixelcheck.md` | ~80 行 |
| **MCP server** | bin name `ai-audit-mcp` → `pixelcheck-mcp`？ | 跨文件 |
| **CLI** | bin name `ai-audit` → `pixelcheck`？ | 跨文件 |
| **GitHub repo** | repo 改名（不可逆） | 1 操作 |
| **NPM package** | 包名改（必须改，因为还没 publish） | 1 操作 |

**触发硬刹车**：
- ✅ 修改 5 个以上既有文件（非纯新增）
- ✅ 修改 67 个公共 API 名字快照中的 bin name
- ✅ 触发 npm publish 不可逆操作的前置
- ✅ 修改 package.json `name` 字段（构成新包）

## 5. 设计选项（Step 3）

### Option A：完整对齐 ADR-001（推荐）—— "PixelCheck" 完整重命名 + 重定位

**做什么**：
1. `package.json`: `ai-browser-auditor` → `pixelcheck`；description → "MCP-first browser primitives for AI agents — real eyes and hands on the web"
2. README H1: `AI Browser Auditor` → `PixelCheck`；tagline 改 "MCP server giving AI agents real eyes and hands on the web. Local-first. Vendor-agnostic. Yours to own."
3. CLI bin: `ai-audit` → `pixelcheck`；MCP bin: `ai-audit-mcp` → `pixelcheck-mcp`
4. Launch 三份完整重写 —— "反 vendor lock-in + AI agent 用 MCP" 主叙事
5. MIGRATION.md 加 v0.x → v1.0 重命名段
6. 新 ADR-033 记录决策
7. GitHub repo 改名（user 操作）
8. CHANGELOG v1.0.0 加 "Renamed to PixelCheck" + "Repositioned as MCP-first AI infrastructure"

**优势**：
- 战略一致性 100%
- launch 故事最符合 2026-Q2 主流（反 vendor lock-in / MCP 标配 / Linux Foundation MCP 加持）
- 长期品牌 = "PixelCheck" 唯一品牌

**劣势**：
- 工程量大（估 1-2 个工作日）
- 需要在你 ship gate 已 ready 的状态多等 1-2 天
- bin name 改名涉及 67 个 API 快照重生（要更新 schema-snapshots / api-snapshots）

**风险**：
- bin name 改后用户测试要全跑（doctor / init / wizard / MCP server self-describe）
- README 里 25 处 MCP / 14 处 primitive 文案与新 H1 协调一致性

**回滚**：
- ADR-033 + git revert + 包名 `pixelcheck` 不去 publish 即可（rename 在 publish 前完全可逆）

---

### Option B：保留 `ai-browser-auditor` 名字 + 仅升级 README/launch 叙事

**做什么**：
1. `package.json` name 保留
2. README H1 保留 "AI Browser Auditor"，但 tagline 改 "MCP-first AI infrastructure that audits products like real users do"
3. Launch 三份重写 —— 强调 MCP + primitive，但保留 "audit" 角度
4. CHANGELOG v1.0.0 不提"重命名"，只加"重新定位"段

**优势**：
- 工程量小（~半天）
- 不动 bin name / 公共 API
- 保留 "audit" 这个具体场景的可识别性

**劣势**：
- 战略一致性 70%（ADR-002 明文"audit 不是核心"，但产品名称还叫 auditor 矛盾）
- 长期品牌混乱（OpenTools 内部叫 PixelCheck，外部叫 ai-browser-auditor）
- launch 故事被名字框死，反 vendor lock-in 叙事弱化

**风险**：
- Wave 2 OSS GTM 阶段还得再做一次品牌过渡
- 用户社区记忆是 "AI Browser Auditor" → 后期重命名成本更高（已有 stars/issue/PR）

---

### Option C：保留旧定位完全不动，先 publish v1.0，后续再调整

**做什么**：
1. 不改任何 launch 文案 / package.json
2. 按当前状态 publish v1.0.0
3. 后续 v1.x 再考虑重定位

**优势**：
- 当下零工程量
- 最快 ship

**劣势**：
- launch 一次性窗口浪费
- 与 ADR-001/002 完全不一致，意味着 ADR 体系失效（违反"Spec 不是免责符"铁律的精神 —— 决策应一致）
- 后续重命名 npm 包成本极高

**风险**：
- 与 CLAUDE.md "一次做到位" 铁律冲突
- 战略基础不稳

## 6. 推荐（Step 3 设计输出）

**推荐 Option A：完整对齐 ADR-001 + PixelCheck 重命名**

理由：
1. **商业级最佳实践**：v1.0 ship 是品牌定锚时刻，错过这个窗口的代价远大于 1-2 天工程
2. **战略一致性**：ADR-001/002 已经做过这个决策，本步只是执行
3. **可逆性**：publish 前 rename 完全可逆，publish 后改名极痛
4. **市场叙事**：2026-Q2 反 vendor lock-in + MCP 标配的故事窗口正在打开（OpenCode 120k stars / MCP Dev Summit 1200 人 / AAIF / OAuth 2.1 preview），错过窗口才是真损失
5. **AI-first 设计目标**：项目既然定位为 AI agent infrastructure，名字与叙事必须服务 AI agent 用户（不是 human auditor 用户）

## 7. 风险审查（Step 4）

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `pixelcheck` npm 包名已被占用 | 中 | 高 | Step 5 用户确认前先 `npm view pixelcheck`，被占则 fallback `pixelcheck-ai` 或 `pixelcheckhq` |
| `pixelcheck` GitHub org 被占 | 中 | 中 | 同上，可用 `pixelchecksh` / `getpixelcheck` |
| bin name `pixelcheck` 与现有 brew package 冲突 | 低 | 低 | 检查 homebrew + macports |
| README body 与新 H1 协调一致性 | 中 | 低 | 重写时全文 grep "auditor" 一并修 |
| 已写好的 launch 文案被弃用浪费 | 低 | 低 | 旧文案归档到 `docs/archive/v0.x-launch/` 留作 v0.x 历史参考 |
| 67 个公共 API 名字快照失效 | 高 | 中 | 重新生成快照；CI 自动比对 |
| MIGRATION 写不清 v0.x 用户被困 | 中 | 中 | 逐项写 "ai-audit X" → "pixelcheck X" 命令对照 |
| 工程量超 2 天 | 中 | 低 | 结构化分阶段（先元数据 → 后 launch 文案 → 后 bin name）每阶段独立验证 |

## 8. 回滚预案

- **publish 前**：所有改动可 git revert；包名 `pixelcheck` 没 publish 不会留痕
- **publish 后**：极痛，必须避免在该决策不稳的情况下 publish
- **执行原则**：本模块完成所有改动 + 全量回归测试通过 + 用户实测 ai-audit→pixelcheck 流程通畅，**才进入 publish gate**

## 9. DoD（Step 8 收尾标准）

完整对齐 Option A 的 DoD：
- [ ] `npm view pixelcheck` 验证可用 + GitHub `pixelcheck`/相关 org 可用
- [ ] ADR-033 已写，状态 Accepted
- [ ] `package.json` name + description + bin entries 改完
- [ ] README H1 + tagline + body grep "auditor" 全清
- [ ] `docs/launch-post.md` + `docs/launch-post-zh.md` + `docs/show-hn.md` 重写
- [ ] CHANGELOG v1.0.0 entry 加 "Renamed + Repositioned" 段
- [ ] MIGRATION.md 加 v0.x → v1.0 命令对照表
- [ ] CLI bin `pixelcheck --help` 跑通
- [ ] MCP server `pixelcheck-mcp` 注册 + Claude Desktop 跑通
- [ ] 公共 API 名字快照重生（67 → ~67 但 bin 名变）
- [ ] `npm pack` 包大小 < 1 MB
- [ ] Fresh dir dogfood install 通
- [ ] 全量回归（typecheck / build / test / bench / 0 schemas diff）
- [ ] 旧文案归档到 `docs/archive/v0.x/`

## 10. 给用户的明确请求（Step 5 待确认）

**需要 Wayne 决策的 3 个问题**：

**Q1：选哪个 Option？**
- [ ] **Option A** 完整对齐 + 重命名 PixelCheck（推荐，~1-2 天工程）
- [ ] **Option B** 保留名字 + 仅升级 launch 叙事（~半天）
- [ ] **Option C** 完全不动按现状 publish（不推荐）

**Q2：如果选 A，PixelCheck 名字 fallback 顺序**？
- 主选：`pixelcheck`
- 备选 1：`pixelcheckhq`
- 备选 2：`pixelcheck-ai`
- 备选 3：你自己定的名字（请提）

**Q3：是否同意我立即按选定 Option 进入 Step 6 实施**？
- 同意 → 我开始执行，按 8 步 SOP 全跑，期间不再打断
- 暂缓 → 你需要先做某事（npm 包名 check / 域名 / GitHub org / 跟其他人 sync），我等
- 修改方案 → 你针对上面 5/6 章节有具体修改

---

**本 research doc 至此结束。Step 5 - 等用户确认。**
