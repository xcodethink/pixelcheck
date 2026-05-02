# PixelCheck — 给 AI agent 装上看网页的眼睛和操作浏览器的手

**你现在就是个截图中间人。**

你的 AI agent 写了你 80% 的前端代码。它快、它会写代码 —— 但它是瞎的：

- 它写了一个按钮。你开 Chrome 验证渲染对不对。截图贴回去。让它修。
- 它改了 OAuth 流程。你登录验证有没有又静默挂掉。这个月第六次了。
- 它更新了日文字符串。一个用户邮件来："半页是英文。"你没抓到。
- 它重写了结算流程。你 iPhone、Android、iPad 全走一遍才能"感觉"到 step 3 是不是绕。
- 它改了阿拉伯语布局。RTL 没正确传播。两天后才发现。

你成了那座桥。Agent 有想法。你有浏览器。**两边永远不见面。**每周这样耗几小时，无止境。

我开源了 [PixelCheck](https://github.com/xcodethink/pixelcheck) 把这个角色拆掉。它是一个 MCP server，给任何 AI agent 五个浏览器 primitive —— `see` / `act` / `extract` / `judge` / `compare` —— 让 agent 不再"描述会怎么做"，而是直接做。本地优先，不锁 LLM 厂商，MIT 开源。配进 `~/.mcp.json` 即可，Claude Desktop / Cursor / Cline / Continue / Zed / Claude Code 都支持。你的 agent 立即获得 17 个工具。

---

## 我意识到缺什么的那一刻

我在做一个 SaaS 产品（[ScamLens](https://scamlens.org)），前端绝大部分代码由 AI agent 写。Agent 能写按钮，能写 OAuth 回调，能写 i18n 字符串，能写 Stripe 结算 —— 然后就停了，因为**它根本看不见自己刚写出来的东西**。

于是我得手动开 Chrome，切语言，点界面，截图，贴回去给 agent，让它修。上面那五条 bullet？**字面意义上是我过去半年的真实场景** —— 每周耗几小时，当一个永远看不见的脑子的眼睛。

PixelCheck 把这座桥拆掉了。

## PixelCheck 是什么

PixelCheck 是一个 MCP server，把五个浏览器 primitive 暴露给任意 AI agent：

```
see(url, opts)              抓取一个页面（DOM + 截图 + console + network）
act(url, steps)             执行一组动作（语义 + 选择器 + Computer Use）
extract(url, schema)        按 Zod / JSON schema 抽取结构化数据
judge(url, rubric)          按打分标准给页面评分（"是否有 dark pattern"）
compare(a, b, criteria)     A/B 对比两个 URL（含 blind mode）
```

每个 primitive 返回严格 JSON Schema 响应，带 cost / 截图 / DOM 信封。可组合。可缓存。可审计。每次调用都会写入 per-run artefact（截图 / DOM dump / payload / response），AI 行为完全可重放可复盘。

给 AI agent 这五个动词，它就能：

- 验证 UI 改动部署后是否真的显示正确
- 测试改完配置后 OAuth 登录是否还能跑通
- 检查日文翻译是否漏掉了英文字符串
- 对比两个 SaaS 定价页提取竞品情报
- 走完一个真实注册流程，判断"首次用户 10 秒内能不能找到要做什么"
- 在产品上线前抓出 dark pattern

## 为什么 MCP-first 重要

[Model Context Protocol](https://modelcontextprotocol.io) 是 PixelCheck 能成立的基础。MCP 在 2025 年 12 月被 Anthropic 捐给 Linux Foundation（AAIF），2026 Q2 ship 了 OAuth 2.1 + Tasks primitive。到 2026 H2，MCP 支持已经是任何 AI 工具的勾选项标配。

PixelCheck 原生说 MCP —— 没有代理 server，没有 glue 代码，没有 SaaS 注册。装上 binary，配进 `~/.mcp.json`，agent（Claude Code / Cursor / Cline / Continue / Zed / Claude Desktop）立即获得 17 个工具。

```bash
npm install -g pixelcheck
pixelcheck doctor                # 8 项环境健康检查
pixelcheck-mcp                   # 启动 MCP server（stdio transport）
```

```jsonc
// ~/.mcp.json
{
  "mcpServers": {
    "pixelcheck": {
      "command": "pixelcheck-mcp",
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

就完了。你的 agent 拥有了眼睛。

## 为什么坚持本地优先 + 不锁厂商

两个早期定下、绝不妥协的设计：

**本地优先**。PixelCheck 完全跑在你的机器上。唯一对外网络是你 agent 自己用的 LLM provider。零遥测。零远程存储。零 SaaS 注册。截图 / DOM / 业务流程，全部留在你电脑上。（完整数据流披露见 [PRIVACY.md](../PRIVACY.md)）

**不锁厂商**。PixelCheck 不绑死任何 LLM provider。MCP server 是 provider-neutral 的 —— 你 agent 决定用哪个 LLM。多 provider 抽象（OpenAI / Gemini / Ollama 平级）在 v1.x roadmap。原因很简单：**2026 年的 AI agent 都是多模型最佳组合，锁单一 provider 的工具会死**。

这跟大部分"AI 浏览器" SaaS 是反的方向。它们是云端独占、模型锁定、信用卡门槛。PixelCheck 是一个你装下来、跑起来、彻底拥有的 npm 包。

## v1.0 实际交付物

不是 vapor。v1.0 ship gate 数字硬：

- **5 个 primitive** + 17 个 MCP 工具，每个返回严格 JSON Schema（30 个发布 schema，Ajv + Zod 双重校验）
- **5 层可靠性栈**把 Stagehand ~75% baseline 拉到 98-99%：Stability Gate → LLM Rewrite → Selector Hint → Auto Selector Discovery → Computer Use
- **9 套指纹 + 15 项 stealth patch**让 audit 看起来像真人，不是被 bot-flag 过的 Playwright 会话
- **18 personas × 15 国家 / 5 文字系统**（Latin / CJK / Arabic / Cyrillic / Devanagari）—— audit preset 用
- **WCAG 2.1 / 2.2 合规**：集成 axe-core（`assert_a11y` step + 50+ Success Criteria 映射）
- **跨会话记忆** + SQLite plan cache（同站重复 audit 60-80% 命中率，30 天 TTL）
- **Cost guard**：per-run + per-day USD 上限 + 跨进程 advisory lockfile
- **Audit explorer SPA**：单文件 HTML 报告，无 build step，无运行时依赖，可在防火墙内部打开
- **三档成本模式**：`economy`（仅 Haiku）/ `balanced`（Haiku 主 + Sonnet 兜底，便宜 3-5x）/ `max`（永远 Sonnet）
- **公共 API 稳定承诺**：67 个 named export + 30 个发布 schema 已快照固定，SemVer 锁定
- **1853 单测 + 22 Playwright e2e + 2 集成测试**，覆盖率 81 / 69 / 81 / 82
- **28 个 Architecture Decision Records**记录每个设计选择
- **CI workflows**：7 个 GitHub Actions（CI / coverage / integration / bench / SBOM / dogfood / post-deploy-audit）

## "真实用户审你的产品"是什么样（audit preset）

PixelCheck 在 primitive 之上还包了一个 CLI-first 的 audit preset —— 这是 v0.x 原始范围。它启动真实 Chromium，扮演 18 种来自 15 个国家的用户，走完你的场景，给出一份判决。

每个 persona 都是完整身份，不是只换个 viewport：

| 身份 | 国家 | 语言 | 设备 | 心智模型 |
|---|---|---|---|---|
| 大学生 | US | English | iPhone | "10 秒内看不到价值我就走" |
| 退休教师 72 岁 | US | English | iPad | "这是不是骗子？我会不会被坑？" |
| 主妇 | JP | 日语 | MacBook | "出现任何英文 = 这不是给我的" |
| 安全分析师 | DE | 德语 | iPad Pro | "给我看方法论，别给我市场话术" |
| 零工 | ID | Bahasa | 廉价 Android | "我的流量套餐撑得住吗" |
| 商务人士 | SA | 阿拉伯语（RTL） | iPhone 15 | "布局镜像反了我没法用" |
| 学生 | CN | 中文 | 小米 | "我得绕过审查才能用" |

…还有 11 个覆盖 印地 / 韩 / 越南 / 俄 / 约鲁巴英 / 西语美洲 / 泰 / 繁中 / 法语。

AI reviewer 会**用他们的眼睛**判断你的产品。日文 persona 看到导航有英文残留 = 标 localization issue；同样的英文给美国 persona 看就 OK。

```bash
pixelcheck init projects/my-app --name "My App" --url "https://myapp.com"
pixelcheck run --project projects/my-app
```

输出：`audit.json` + `audit.html`（深色 dashboard）+ `audit.pdf`（给 stakeholder 看的 PDF）+ `audit.sarif`（GitHub Code Scanning）+ 每步截图 + 视频 + HAR + console log。

CI 集成：exit code `0`/`1`/`2` 对应 pass / fail / warn。GitHub Actions 一行：`npx pixelcheck run --min-score 7.0`。

## 跟其他自动化框架的区别

OSS 浏览器自动化领域很拥挤。说清楚：

**PixelCheck 不是 browser-use**。browser-use（91k stars）是 Python 框架，让 agent 自主完成 web 任务，task-completion 极强。PixelCheck 是另一层 —— agent 调用的 primitive，专门用来**看页面 + 推理**，带严格 result schema 和多 persona audit preset。

**不是 Stagehand**。Stagehand（22k stars，Browserbase 出品）是 TS SDK，做 AI 驱动的语义浏览器操作。我们**内部用**Stagehand 作为可靠性栈的一层。Stagehand 是库；PixelCheck 是它之上的 MCP server。

**不是 Skyvern**。Skyvern（21k stars）是 vision-LLM workflow runner，表单专项强。形态不同：workflow-centric，云端部署。

**不是 BrowserOS / Comet / Atlas**。那些是 agentic browser —— 用 AI-native 浏览器替换 Chrome，C 端产品。PixelCheck 是开发者基础设施。

**一句话差异化**：现有 OSS 没有任何项目同时做到 MCP-first × 5-primitive 接口面 × 18-persona / 15 国模拟 × WCAG 合规 × stealth 指纹 × 历史趋势追踪。PixelCheck 是 AI agent 与可视化 web 之间缺失的那一层。

**还有一件 2026 年特别重要的事**：上面所有候选要么把你锁在单一 LLM provider，要么强制 SaaS 注册，要么有付费 "Pro" 等级躲在信用卡后面。PixelCheck 一个都没有 —— MIT 开源、source-available、零遥测、无付费版、无商业 fork、无云端控制面板。仓库里这个 1853 测试的产品**就是全部产品**。

## 成本与控制

AI 工具的常见担忧是失控成本。PixelCheck 多重护栏：

- **三档成本模式**：`economy`（仅 Haiku）比 `max`（仅 Sonnet）便宜 3-5x。默认 `balanced` 是 Haiku 主 + 置信度低时升 Sonnet
- **Cost guard**：config 中设 per-run + per-day USD 上限；累计成本越限就拒绝新单元；跨进程 advisory lockfile 防止双花
- **Plan cache**：同站重复运行 60-80% 命中率（DOM skeleton 命中缓存计划时跳过 Sonnet planning，7 天 TTL）
- **每次调用 budget**：每个 MCP 工具文档化典型 cost；`judge` / `compare` 接受 `max_iterations`

典型完整 audit（18 personas × 6 scenarios）`balanced` 模式 $2-8。单次 `see` 调用 $0.005-0.015。

## v1.x 后续路线

v1.0 是有意识地控制范围 ship。v1.x 已规划：

- **Wave 2**（30-90 天）：Provider 抽象（OpenAI / Gemini / Ollama）· 多 AI client 兼容矩阵 · 公开 benchmark 数字 · MCP 公开 registry 注册
- **Wave 3**（90-180 天）：Stagehand v3 升级 · Persona 扩展到 30+ 国 · A/B 上下文注入 · MCP OAuth 2.1 + Tasks primitive · 1M-context multi-step research workflow
- **Wave 4**（180+ 天，按需触发）：移动端 native（RN / Flutter / 原生）· 用户流自动发现 · Cognitive a11y · 语义视觉 diff

## 试一下

```bash
npm install -g pixelcheck
pixelcheck doctor
pixelcheck-mcp
```

或单项目安装：

```bash
npm install pixelcheck --save-dev
npx pixelcheck init projects/my-app --name "My App" --url "https://myapp.com"
npx pixelcheck run --project projects/my-app
```

GitHub：https://github.com/xcodethink/pixelcheck
License：MIT
文档：README + 13 份治理文档（LICENSE / SECURITY / PRIVACY / MIGRATION / CONTRIBUTING / CHANGELOG / FAQ / TROUBLESHOOTING / INSTALLATION / DEPRECATION-POLICY / THIRD_PARTY_LICENSES + ADRs + API ref）

## 我希望听到的反馈

如果你在用 AI agent 写代码，发现自己反复手动截图给 agent 看 —— PixelCheck 就是填这个缺。装上 MCP server 用你 agent 跑一下，告诉我哪里有缝。

如果你 ship 产品后被部署后问题打了脸（CI 全绿但用户看到的不一样）—— 试试 audit preset，看多 persona 视角能不能帮你抓出 CI 抓不到的东西。

如果你被锁死在单一 LLM provider 或被强迫云端上传的 AI 工具坑过 —— 试 PixelCheck 因为它两个都不做。

— Wayne
