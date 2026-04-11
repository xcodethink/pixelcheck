# AI Browser Auditor — Master Plan

> 项目代号：**ai-browser-auditor**
> 制定日期：2026-04-11
> 状态：planning → implementation
> 关联项目：[ScamLens](../ScamLens), [playwright-screenshots](../playwright-screenshots), [stealth-core](../stealth-core)

---

## 0. 一句话定义

> 项目部署上线后，由 AI Agent 驱动一批带反检测指纹的真实浏览器，扮演不同国家/语言/设备/付费等级的用户身份，按真实用户路径完整跑通业务核心流程，输出"产品经理 + QA + UX Reviewer 三合一"级别的验收报告。

**这不是 E2E 测试**，是**自动化的产品体验审计**。

---

## 1. 背景与动机

### 1.1 ScamLens 的痛点

来自 [ScamLens/CLAUDE.md](../ScamLens/CLAUDE.md) 和 memory：

| 痛点 | 现状 | AI 验收能解决 |
|---|---|---|
| OAuth 链路反复被破坏（10 次部署 6 次出问题） | 只能手动登录验证 | 每次部署后自动跑完整 OAuth → dashboard → email 链路 |
| 12 语言混入英文（铁律级要求） | 切换页面手动检查不可行 | AI 用持身份"日本主妇"打开 /ja，全程视觉检查混入 |
| 商业级 UX 要求 | 主观判断 | Claude vision 给 5 维度评分（completion / localization / visual_polish / trust_signals / time_to_value） |
| Admin 面板 Tab 越加越多（最近 SloTab/IncidentTab/CreditsTab/Wallet Intelligence） | 每个 Tab 手动点 | AI 全 Tab 巡检 + console error 采集 |
| 12 语言 × N 落地页 × N 场景的组合爆炸 | 人工测不完 | 一晚上跑完一遍 |
| Stripe 付费、邮件触达、Chrome 扩展等跨服务流程 | 各自单测，端到端无 | 真实演练完整链路 |

### 1.2 为什么不是传统 E2E（Cypress / Playwright Test）

| 维度 | 传统 E2E | AI 验收 |
|---|---|---|
| 决策方式 | 写死脚本 | LLM 看页面决定下一步 |
| 断言 | `expect(text).toBe("欢迎")` | "作为日本免费用户，这个 CTA 是否清晰" |
| 失败定义 | exception | 一份带截图、视频、心智模型评分的报告 |
| UI 改动适应性 | 选择器一改就挂 | 语义级指令，自动适配 |
| 测的是什么 | 代码逻辑 | 完整体验：文案/排版/加载/多语言/引导/付费墙合理性 |
| 发现的问题类型 | 功能 bug | UX 问题、文化适配、语言混入、加载体感、商业转化 |

### 1.3 为什么不是 manual QA

不可扩展。12 语言 × 6 persona × 8 scenario × 多设备 = 单次回归 1000+ 用例。

---

## 2. 系统架构

### 2.1 三工具一底座

```
                    ┌──────────────────────────────────┐
                    │    /Users/wayne/Developer/       │
                    │       stealth-core/              │  ← 共享底座
                    │   (fingerprints + 15 patches +  │
                    │    browser launcher + retry)     │
                    └──────────────┬───────────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                      ▼
   playwright-screenshots/   ai-browser-auditor/   ScamLens/scamlens-sandbox/
   (被动视觉回归)            (主动 AI 验收)         (调查取证 agent)
   
   触发：CI 部署后/手动        触发：部署后定时         触发：用户调查请求
   产出：截图 + diff HTML      产出：审计报告 + 评分    产出：取证证据 + STIX
   驱动：固定 URL 列表          驱动：scenario YAML     驱动：用户提交目标
```

三者通过 stealth-core 共享同一套指纹层和反检测能力，**任何一处升级（如未来切换到 patchright）三个工具同步受益**。

### 2.2 ai-browser-auditor 内部架构

```
ai-browser-auditor/
│
├── PLAN.md                      ← 本文档
├── README.md                    ← 用户文档
├── package.json
├── tsconfig.json
├── .env.example                 ← API 密钥/测试账号占位
│
├── src/
│   ├── cli.ts                   ← CLI 入口
│   ├── index.ts                 ← 库入口
│   │
│   ├── core/
│   │   ├── persona.ts           ← Persona 加载 + 校验
│   │   ├── scenario.ts          ← Scenario 加载 + 校验  
│   │   ├── runner.ts            ← 编排器：persona × scenario 矩阵
│   │   ├── browser.ts           ← Stagehand + stealth-core 启动
│   │   ├── stagehand-wrapper.ts ← act/extract/observe/agent 封装
│   │   ├── computer-use.ts      ← Playwright-backed Computer Use loop
│   │   ├── critic.ts            ← Claude vision 评分
│   │   ├── recorder.ts          ← 录视频/HAR/console/截图/hash
│   │   ├── reporter.ts          ← HTML + JSON 报告生成
│   │   ├── llm.ts               ← Anthropic SDK 包装
│   │   ├── email.ts             ← mail.tm 临时邮箱辅助
│   │   ├── secrets.ts           ← 凭据安全加载
│   │   └── types.ts             ← 共享类型
│   │
│   └── handlers/                ← 内置 step handler（声明式 step → 实际操作）
│       ├── visit.ts
│       ├── act.ts
│       ├── observe.ts
│       ├── extract.ts
│       ├── assertVisual.ts
│       ├── checkEmail.ts
│       ├── waitFor.ts
│       └── computerUseFallback.ts
│
├── personas/                    ← 6 个用户身份 YAML
│   ├── us-english-free-mobile.yaml
│   ├── jp-japanese-pro-desktop.yaml
│   ├── de-german-power-tablet.yaml
│   ├── cn-chinese-free-mobile.yaml
│   ├── br-portuguese-free-desktop.yaml
│   └── sa-arabic-pro-mobile.yaml         ← RTL 测试关键
│
├── scenarios/                   ← 8 个核心场景 YAML
│   ├── 01-google-oauth-signup.yaml
│   ├── 02-domain-check-flow.yaml
│   ├── 03-admin-panel-audit.yaml
│   ├── 04-language-localization-audit.yaml
│   ├── 05-crypto-trace-purchase.yaml
│   ├── 06-investigation-workflow-v2.yaml
│   ├── 07-email-opt-in-welcome.yaml
│   └── 08-chrome-extension-install.yaml
│
├── config/
│   └── scamlens.yaml            ← 项目级配置（target URL、密钥引用等）
│
├── docs/
│   ├── architecture.md
│   ├── writing-scenarios.md
│   ├── writing-personas.md
│   └── ci-integration.md
│
└── reports/                     ← 输出（gitignore）
    └── 2026-04-11_143022_scamlens-prod/
        ├── audit.html
        ├── audit.json
        ├── summary.md
        └── jp-japanese-pro-desktop_01-google-oauth-signup/
            ├── steps.json
            ├── 01-landing.png
            ├── 01-landing.png.sha256
            ├── 02-click-signin.png
            ├── ...
            ├── full-session.webm
            ├── network.har
            ├── console.log
            └── verdict.md
```

### 2.3 一次完整运行的数据流

```
1. CLI 启动
   └─ npx ai-audit run --config config/scamlens.yaml --tag prod
   
2. 加载 personas + scenarios，生成执行矩阵
   └─ 默认每个 scenario 跑指定的 persona 子集（不是全笛卡尔积，避免组合爆炸）

3. 创建并行调度池（默认 concurrency=3）
   └─ 同 origin 串行（避免 WAF），不同 origin 并行
   
4. 对每个 (persona, scenario) 执行单元：
   ├─ a. 从 stealth-core 启动指纹浏览器（按 persona 选 profile）
   ├─ b. 配置 viewport / locale / timezone / proxy（按 persona）
   ├─ c. 启动 recorder：video + HAR + console listener
   ├─ d. 实例化 Stagehand 复用上面的 browser context
   ├─ e. 按 scenario.steps 逐步执行：
   │     ├─ 简单 step → 内置 handler 直接调 Playwright/Stagehand
   │     ├─ AI step → stagehand.act("click signup")  
   │     ├─ 视觉断言 → vision critic 截图 + Claude 评判
   │     ├─ 关键 step（标记 critical: true）→ Computer Use 二次审查
   │     └─ 失败 step → 自动重试（指数退避）+ 切换 fingerprint profile
   ├─ f. 跑完后调用 critic 给 5 维度评分
   ├─ g. 持久化所有产物到 reports/<run>/<persona>_<scenario>/
   └─ h. 关闭 browser context

5. 全部跑完后：
   ├─ 生成 audit.json（机器可读）
   ├─ 生成 audit.html（人类可读，暗色主题，每个 scenario 一个 section）
   ├─ 生成 summary.md（terminal-friendly）
   └─ exit code: 0 = all pass, 1 = critical failure, 2 = partial failure
```

---

## 3. 技术选型（已确认）

### 3.1 核心栈

| 层 | 选型 | 理由 |
|---|---|---|
| 浏览器引擎 | **Playwright (chromium)** | 已是 ScamLens 全栈基础 |
| 反检测 | **stealth-core**（自研，从 playwright-screenshots 升级版抽取） | 9 个真实设备 profile + 15 项 patch |
| AI 操作框架 | **Stagehand 2.0** | TypeScript-native，act/extract/observe/agent，CDP 直连，Browserbase 维护 |
| AI 决策模型 | **Claude Sonnet 4.6**（默认） + **Opus 4.6**（关键场景 critic） | 性价比 + 视觉 + JSON mode |
| 视觉评判 | **Claude Vision via Sonnet 4.6** | 多模态，便宜 |
| 关键场景二次审查 | **Computer Use 2025-11-24**（Opus 4.6） | 像素级真人操作，**通过 Playwright primitives 实现 action handlers** |
| 配置格式 | **YAML** | persona / scenario 友好可读 |
| Schema 校验 | **Zod** | Stagehand extract() 标准 |
| CLI | **Commander** | 与 playwright-screenshots 一致 |
| 临时邮箱 | **mail.tm API** | 邮件链路验证 |
| 视频录制 | Playwright `recordVideo` | 内置零依赖 |
| HAR | Playwright `recordHar` | 内置零依赖 |
| 视觉 diff | **odiff** | 比 pixelmatch 快 3-10x，CI 友好 |
| 并发控制 | **p-limit** | 简单稳定 |
| 重试 | 自实现指数退避 | 控制错误分类 |

### 3.2 关键设计决策

#### 决策 1：Stagehand 默认 + Computer Use 二次审查

**默认路径（90% 场景）**：Stagehand 走 DOM/Accessibility tree，快、便宜、稳定。

**Computer Use 升级（10% 关键场景）**：在 scenario 标记 `critical_review: true` 的步骤，**额外**用 Computer Use 像真人一样看屏幕操作一遍，对比两种结果，发现 DOM-based 检测不到的视觉问题。

**关键创新 — Playwright-backed Computer Use**：
官方 Computer Use reference 用 Xvfb + Linux 桌面，**我们用 Playwright 实现 action handlers**：
```
Claude 发出 {action: "left_click", coordinate: [x, y]}
  → 我们的 handler 调 page.mouse.click(x, y)
Claude 发出 {action: "screenshot"}  
  → 我们的 handler 调 page.screenshot() 并按比例缩放
Claude 发出 {action: "type", text: "..."}
  → 我们的 handler 调 page.keyboard.type("...")
```

这样我们同时拥有：
- **stealth fingerprint**（真实浏览器，反检测）  
- **Computer Use 视觉智能**（像素级判断、视觉评分）
- **高效**（不需要 Docker + Xvfb，直接共用 Playwright context）

#### 决策 2：persona × scenario 矩阵不是笛卡尔积

每个 scenario 在 YAML 里声明 `applies_to.personas: [...]`，避免 6×8=48 次的组合爆炸。
- OAuth signup：用 4 个有代表性的 persona
- Localization audit：必须 6 个全跑
- Admin audit：1 个就够（admin 没有多语言变体）

#### 决策 3：scenario 是声明式 YAML 不是 TypeScript 代码

YAML 优势：
- 非工程师可读、可审阅
- AI 自己也能读懂、改写
- 可以版本化跟踪
- 配合 Zod schema 做严格校验

YAML 劣势：
- 复杂逻辑表达受限
- 解决方案：复杂场景可以引用 TS 文件 `customSteps: ./scenarios/custom/foo.ts`

#### 决策 4：失败重试策略分级

| 错误类型 | 策略 |
|---|---|
| `net::ERR_*` / timeout | 重试 3 次，指数退避 1s/3s/9s |
| HTTP 5xx | 重试 3 次 |
| HTTP 4xx | 不重试 |
| 检测到 Cloudflare/Datadome challenge 页 | 切换 fingerprint profile 后重试 |
| Stagehand `act()` 失败（找不到元素） | 重试 1 次，二次失败 → fallback 到 Computer Use |
| LLM 调用失败 | 重试 3 次（Claude → Sonnet → Haiku 降级链） |
| Critic 评分失败 | 不影响主流程，记录 warning |

#### 决策 5：所有截图带 SHA-256 哈希

为日后取证和**视觉回归对比**铺路。每张图旁边写一个 `.sha256` 文件 + JSON 报告里也带 hash。

---

## 4. Personas 设计（6 个）

每个 persona 定义：身份背景 + 设备 + 网络位置 + 语言 + 付费等级 + 期望体验。

| ID | 国家 | 设备 | 语言 | 等级 | 关键测试维度 |
|---|---|---|---|---|---|
| `us-english-free-mobile` | 🇺🇸 | iPhone 15 Pro | English | Free | 主市场，免费转付费漏斗 |
| `jp-japanese-pro-desktop` | 🇯🇵 | MacBook Pro | 日本語 | Pro | 多语言、付费体验、亚洲主市场 |
| `de-german-power-tablet` | 🇩🇪 | iPad Pro | Deutsch | Power | 欧洲/GDPR、最高级套餐 |
| `cn-chinese-free-mobile` | 🇨🇳 | Galaxy S24 (Android) | 简体中文 | Free | 中文用户、Android、网络条件较慢 |
| `br-portuguese-free-desktop` | 🇧🇷 | Win 11 PC | Português | Free | 拉美市场、小语种 fallback |
| `sa-arabic-pro-mobile` | 🇸🇦 | iPhone 15 | العربية | Pro | **RTL 布局**关键测试 |

每个 persona YAML 包含字段（详见 [docs/writing-personas.md](docs/writing-personas.md)）：
```yaml
id: jp-japanese-pro-desktop
display_name: 田中花子（35歳 主婦 東京）
country: JP
language: ja
locale: ja-JP
timezone: Asia/Tokyo
device_profile: desktop  # 用于 stealth-core 选 fingerprint
viewport: { width: 1440, height: 900 }
user_agent_class: macbook  # macbook | iphone | android | windows | ipad
payment_tier: pro
proxy: ${PROXY_JP}        # 可选，从 .env 读
mental_model: |
  35岁日本主婦，对加密货币不熟悉但对诈骗很警惕。
  收到可疑投资邀请，第一反应是用搜索引擎查"○○ 詐欺"，
  发现 ScamLens 后想验证那个网址。中等技术水平，
  期望日文流畅、不要专业术语、有清晰的"是不是骗局"判断。
critical_concerns:
  - 全程必须日文，任何英文混入都是 bug
  - 加密货币术语必须有日文解释
  - 付费套餐说明必须清晰，价格用日元显示
  - GDPR/法律相关说明必须本地化
test_credentials:               # 可选
  google_account: ${TEST_GOOGLE_JP}
```

---

## 5. 8 个核心 scenario 设计

### Scenario 01: Google OAuth Signup End-to-End
**优先级**：P0（OAuth 铁律守护者）
**适用 persona**：us, jp, de, cn（4 个）
**目的**：每次部署后立即验证 OAuth 链路完好，覆盖"10 次部署 6 次出问题"的痛点

**Steps（语义级）**：
1. 访问 `https://scamlens.org/${persona.locale}`
2. 视觉断言：所有可见文字都是 ${persona.language}
3. 点击 header 的 "Sign in" 按钮
4. 点击 "Continue with Google"
5. 在 Google 登录页输入 `${persona.test_credentials.google_account}`
6. 等待回调 → dashboard
7. 视觉断言：dashboard 用用户名打招呼，无英文混入
8. 检查临时邮箱：60 秒内收到欢迎邮件
9. 点击邮件中的确认链接
10. 断言：账号状态为 verified

**评分维度**：completion, localization, visual_polish, trust_signals, time_to_value
**critical_review**：true（步骤 6 → Computer Use 二次审查"dashboard 视觉是否商业级"）

---

### Scenario 02: Domain Check Flow
**优先级**：P0（核心 C 端入口）
**适用 persona**：us, jp, de, cn, br, sa（全部 6 个）

**Steps**：
1. 访问首页
2. 在主搜索框输入一个已知诈骗域名（用 ScamLens 自家测试集中的）
3. 等待报告页加载
4. 视觉断言：风险评分清晰可见，颜色编码符合直觉（红色=高危）
5. 检查报告中的威胁情报源是否完整显示
6. 检查 AI 风险摘要是否用 ${persona.language}
7. 视觉断言：报告页布局商业级（参考 VirusTotal/URLVoid 标准）
8. 点击"View Detailed Analysis"，验证深度分析展开
9. 检查"Report Inaccuracy"按钮可见且可点击

**评分维度**：completion, localization, visual_polish, information_density, trust_signals

---

### Scenario 03: Admin Panel Full Audit
**优先级**：P0（admin 越扩越大）
**适用 persona**：1 个（admin 无 i18n 变体），用 us-english-free-mobile 的 desktop 视图

**Steps**：
1. 用 admin cookie 登录 `/admin`
2. 等待 dashboard 加载
3. **遍历每个 Tab**（Users / Reports / Feedback / SLO / Credits / Wallet Intelligence / Incidents / Telegram / Health / API Keys / ...）：
   - 点击 Tab
   - 等待加载
   - 截图
   - 收集 console errors
   - 视觉断言：无空白页 / 无 React error / 无 500 / 无表格分页坏 / 无英文之外的文字混入（admin 是英文版）
   - 提取数据表格行数（验证不是空状态没处理）
4. 汇总所有 console errors 到一个列表

**评分维度**：completion, error_density, ui_consistency, data_integrity
**critical_review**：true（每个 Tab → Computer Use 评判"商业级 admin 标准"，对标 Stripe/Linear admin）

---

### Scenario 04: 12-Language Localization Audit
**优先级**：P0（铁律）
**适用 persona**：jp, de, cn, br, sa（5 个非英语 persona）

**Steps**（每个 persona 独立跑一次）：
1. 访问 `/${persona.locale}` 首页
2. **AI 视觉判断**：截图发给 Claude，要求列出所有英文文字（不含品牌名）
3. 点击主导航的每个一级菜单项，重复步骤 2
4. 访问 `/${persona.locale}/pricing`，重复步骤 2
5. 访问 `/${persona.locale}/wallet-intelligence`，重复步骤 2
6. 访问 `/${persona.locale}/blog`，点击第一篇博客，重复步骤 2
7. 切换到一个具体的诈骗指南页（如 `/${persona.locale}/scam-guides/romance-scam`），重复步骤 2

**输出**：每个 persona 一份"英文混入清单"，附定位（页面 + 选择器 + 截图）

**评分维度**：localization 单维度（0-10 分，10=完全无混入）

---

### Scenario 05: Crypto Trace Purchase Flow
**优先级**：P1（核心收入流）
**适用 persona**：us, jp, de（3 个有付费意愿的）

**Steps**：
1. 已登录状态访问 `/${persona.locale}/crypto-trace`
2. 视觉断言：三档价格清晰（$99/$199/$399）
3. 点击 "Start Tracking" 按钮
4. 选择 $199 档
5. 进入 Stripe checkout（**用 Stripe 测试卡 4242 4242 4242 4242**）
6. 完成支付
7. 等待回到 ScamLens，看到 access token 页面
8. 输入测试 USDT 地址，提交追踪请求
9. 等待追踪进度（设置较长的 timeout）
10. 查看初步报告
11. 视觉断言：报告专业级，实体图谱可见，风险评分有解释

**评分维度**：completion, payment_flow_clarity, trust_signals, time_to_value, visual_polish
**critical_review**：true（支付页面 + 报告页面 → Computer Use 二次审查）
**安全**：用 Stripe TEST 模式公开测试卡，**绝不用真实卡**

---

### Scenario 06: Investigation Workflow V2 E2E
**优先级**：P1（最近大改动 V2 引擎）
**适用 persona**：us, jp（2 个）

**Steps**：
1. 已登录访问报告页（或主动触发一次新调查）
2. 提交一个目标域名进入调查
3. 观察 Workflow V2 的 9 步进度可见
4. 等待调查完成（可能数分钟，要支持长 wait）
5. 查看最终报告
6. 验证实体图谱（Cytoscape）渲染完毕
7. 验证 STIX bundle 导出
8. 验证 IOC CSV 导出
9. 视觉断言：图谱可交互、节点风险颜色编码正确

**评分维度**：completion, workflow_visibility, output_quality, time_to_value

---

### Scenario 07: Email Opt-in + Welcome Email Verification
**优先级**：P1（验证 Brevo / Resend 集成）
**适用 persona**：us, jp, de, cn（4 个）

**Steps**：
1. 访问首页
2. 找到 Newsletter / "Get weekly safety report" 订阅入口
3. 用 mail.tm 临时邮箱填表
4. 同意条款，提交
5. 等待 60 秒
6. 检查临时邮箱
7. 验证收到欢迎邮件
8. 视觉断言：邮件是 ${persona.language}（HTML 邮件渲染检查）
9. 邮件包含正确的退订链接
10. 点击退订链接，验证可成功退订

**评分维度**：completion, localization, email_design, compliance（GDPR 退订）

---

### Scenario 08: Chrome Extension Install + Use
**优先级**：P2（OrangeDuck 扩展）
**适用 persona**：us, jp（2 个）

**Steps**：
1. 启动带扩展加载的 Playwright（`chromium.launchPersistentContext` + `--load-extension`）
2. 加载本地构建的 OrangeDuck 扩展
3. 打开扩展弹窗
4. 用持身份的 Google 账号登录
5. 在浏览器里访问几个真实网站
6. 触发 "Add to bookmarks"
7. 触发 "AI Summarize"
8. 验证 AI 摘要返回结果
9. 触发 "Auto Classify"
10. 验证分类生效
11. 触发"云备份"
12. 重启浏览器，验证书签恢复

**评分维度**：completion, extension_responsiveness, ai_quality, sync_reliability
**特殊要求**：必须用 `launchPersistentContext`，不能用 ephemeral context

---

## 6. Step 系统设计

### 6.1 Step 类型分类

| 类型 | 示例 | 后端 | 是否需要 LLM |
|---|---|---|---|
| `visit` | 打开 URL | Playwright | 否 |
| `act` | 点击 / 输入 / 滚动 | Stagehand | 是（解析自然语言指令） |
| `extract` | 取数据 | Stagehand + Zod | 是 |
| `observe` | 看页面有什么 | Stagehand | 是 |
| `wait_for` | 等待元素/条件 | Playwright | 否 |
| `assert_visual` | 视觉断言 | Claude vision | 是 |
| `assert_dom` | DOM 断言 | Playwright + Zod | 否 |
| `check_email` | 临时邮箱收件 | mail.tm | 否 |
| `screenshot` | 显式截图 | Playwright | 否 |
| `computer_use` | 显式调用 Computer Use | Anthropic API + Playwright handlers | 是 |
| `custom` | 自定义 TS 函数 | 用户代码 | 看实现 |

### 6.2 完整 step 例子

```yaml
steps:
  - id: open-home
    type: visit
    url: https://scamlens.org/${persona.locale}
    wait_until: networkidle
    
  - id: check-language
    type: assert_visual
    critical: true
    instruction: |
      Check that all visible text is in ${persona.language}.
      Brand names like "ScamLens" are exempt.
      Return: { "passed": bool, "violations": [{"text": str, "location": str}] }
    
  - id: click-signup
    type: act
    instruction: Click the sign in button in the page header
    retry: 2
    fallback: computer_use
    
  - id: choose-google
    type: act
    instruction: Choose "Continue with Google" option
    
  - id: google-login
    type: custom
    handler: ./scenarios/handlers/google-oauth.ts
    inputs:
      account: ${persona.test_credentials.google_account}
    
  - id: dashboard-loaded
    type: wait_for
    selector: '[data-testid="dashboard-greeting"]'
    timeout: 15000
    
  - id: rate-dashboard
    type: assert_visual
    critical_review: true     # 触发 Computer Use 二次审查
    instruction: |
      Rate this dashboard on 5 dimensions (0-10):
      1. completion: Did onboarding complete?
      2. localization: Any non-${persona.language} text?
      3. visual_polish: Commercial-grade UI?
      4. trust_signals: Does this make a paranoid user feel safe?
      5. time_to_value: How quickly can the user get value?
      Return JSON with scores + per-dimension justification.
    
  - id: check-welcome-email
    type: check_email
    timeout: 60000
    expected_subject_contains: ${persona.locale === 'ja' ? 'ようこそ' : 'Welcome'}
```

---

## 7. Vision Critic 设计

### 7.1 5 维度评分模板

```typescript
interface ScenarioScore {
  completion: number;      // 0-10：流程能否走完
  localization: number;    // 0-10：本地化纯度
  visual_polish: number;   // 0-10：商业级 UI 标准
  trust_signals: number;   // 0-10：用户信任度
  time_to_value: number;   // 0-10：上手速度
  
  overall: number;         // 加权平均
  verdict: 'PASS' | 'PASS_WITH_ISSUES' | 'FAIL';
  
  issues: Issue[];
}

interface Issue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  step_id: string;
  dimension: keyof Omit<ScenarioScore, 'overall' | 'verdict' | 'issues'>;
  description: string;
  screenshot: string;
  recommendation: string;
}
```

### 7.2 Critic Prompt 模板

```
You are a senior product manager + UX reviewer auditing ${PROJECT_NAME}.
You are evaluating from the perspective of: ${PERSONA.mental_model}

The user just attempted: ${SCENARIO.goal}
Steps taken: ${STEPS_SUMMARY}
Final screenshot: <attached>

Score on these 5 dimensions (0-10 each):
1. completion: ...
2. localization: ${PERSONA.language} purity, no foreign text mixed
3. visual_polish: Commercial-grade like Stripe/Linear/Vercel
4. trust_signals: Does this feel professional and trustworthy?
5. time_to_value: How quickly does the user get useful output?

For each dimension, justify your score in 1 sentence.

Then list up to 5 specific issues found with severity (critical/high/medium/low),
description, and concrete recommendation.

Return valid JSON matching ScenarioScore schema.
```

### 7.3 Critical Review 升级路径

当 step 标记 `critical_review: true` 时：
1. 默认 Sonnet 4.6 vision critic 先评一次
2. 如果分数 < 8.0 或有 critical issues → 升级到 Opus 4.6 + Computer Use 重新审一次
3. Computer Use 像真人一样在屏幕上看，可以发现 DOM-based 检测不到的视觉问题（比如重叠、被遮挡、字体太小）

---

## 8. 商业级最佳实践集成

下面这些是商业级工具标配但开源工具常缺的能力，我们一次性都做进去：

### 8.1 失败重试（用户列表能力 #2）✅
分级策略见 §3.2 决策 4。

### 8.2 并行执行（用户列表能力 #3）✅
- 全局 `--concurrency N`，默认 3
- 同 origin 串行（避免 WAF），不同 origin 并行
- 用 p-limit 控制
- 每个并行 worker 独立的 stealth profile，避免指纹冲突

### 8.3 Console 错误采集（用户列表能力 #4）✅
- 每个 page 注册 `console`/`pageerror`/`requestfailed` 监听
- 写入 step 结果 + 总报告
- 关键错误（uncaught exception）自动升级为 issue

### 8.4 等待指定元素（用户列表能力 #5）✅
- `wait_for` step 支持 selector / text / function 三种
- 全局 `default_wait_until` 配置

### 8.5 JSON 输出（用户列表能力 #6）✅
audit.json 是一等公民，HTML 是从 JSON 渲染的。CI 直接消费 JSON。

### 8.6 代理支持（用户列表能力 #7）✅
- persona 级 proxy 配置
- 自动校验 proxy + locale + timezone 一致性
- 可选 GeoIP 自动推断

### 8.7 视觉回归对比（用户列表能力 #1）✅
- 每个 scenario 自动保存 baseline 截图集
- 下次跑用 odiff 对比
- diff 像素 > 阈值 → 标记 regression
- HTML 报告里"原始 / 当前 / diff"三栏对比

### 8.8 持久化 Profile ✅（项目专属补充 A）
- 每个 (persona, scenario) 可声明 `persistent: true`
- 用 Playwright `storageState` 持久化 cookie/localStorage/IndexedDB
- 适用于"多次使用同一身份"的连续测试

### 8.9 HAR 网络流量录制 ✅（项目专属补充 B）
- 默认开启
- 写入 reports/<run>/<unit>/network.har
- 失败 step 自动 attach 到 issue

### 8.10 视频录制 ✅（项目专属补充 E）
- 默认开启
- 用 Playwright `recordVideo`
- HTML 报告内嵌

### 8.11 SHA-256 截图哈希 ✅（项目专属补充 D）
- 每张截图旁生成 .sha256
- JSON 报告内嵌 hash
- 为未来取证锚定铺路

### 8.12 凭据管理（**安全关键**）
- 所有密码 / API key / Google 账号 / Stripe 测试卡从 `.env` 读
- 永远不写入 reports/
- 自动从所有日志中 redact
- 用 zod schema 校验 env 格式

### 8.13 失败截图自动 attach
- 任何 step 失败 → 立即截图 + DOM dump + console snapshot
- 三件套写入 issue 字段
- 即使 step 没要求截图

### 8.14 Trace Viewer 集成
- 关键失败启用 Playwright tracing
- 输出 .zip，可用 `npx playwright show-trace` 重放

### 8.15 Slack/Telegram 失败通知
- 配置 webhook，每次跑完自动推送 summary
- critical 失败立即推送

### 8.16 GitHub Actions 集成模板
- 提供 `.github/workflows/post-deploy-audit.yml` 示例
- 部署成功后自动触发
- 报告 artifact 上传
- PR 评论自动写 summary（可选）

### 8.17 增量运行
- `--only-changed` 只跑改动相关的 scenario（看 git diff）
- `--scenario 01-google-oauth-signup` 只跑特定 scenario
- `--persona jp-japanese-pro-desktop` 只跑特定身份
- `--tag ci/manual/regression` 标记本次运行

### 8.18 成本守卫
- 每次运行预估 token 消耗
- 超过 `--budget $5` 自动停止
- 报告里展示实际花费

### 8.19 prompt 注入防御
- 截图喂给 Claude 前过滤可疑 OCR 文本
- 启用 Anthropic 的 prompt injection classifier（Computer Use 自带）
- 调查站点本身可能藏 prompt injection，不要让 critic 被诱导

### 8.20 失败的 minimum repro
- 失败后输出最小复现命令：`npm run audit -- --scenario X --persona Y --resume-from step3`

---

## 9. 实施阶段（按可交付物分阶段，无时间估计）

### Phase 0：底座（先做）
**交付物**：可工作的 stealth-core 包
- [ ] 创建 `/Users/wayne/Developer/stealth-core/` 项目
- [ ] 从 [playwright-screenshots/src/fingerprints.ts](../playwright-screenshots/src/fingerprints.ts) 抽取 9 个 profile
- [ ] 抽取 15 项 stealth patch
- [ ] 提供 `createStealthBrowser()` 和 `createStealthContext()` API
- [ ] 提供 `withRetry()` 重试工具
- [ ] package.json + tsconfig + npm run build 通过

### Phase 1：scaffold（最小可跑骨架）
**交付物**：能跑通一个最简 scenario
- [ ] 创建 `/Users/wayne/Developer/ai-browser-auditor/` 项目骨架
- [ ] package.json + 依赖（Stagehand / Anthropic SDK / Zod / Commander / yaml / p-limit / odiff-bin）
- [ ] tsconfig + ESM 配置
- [ ] core/types.ts（所有共享类型 + Zod schema）
- [ ] core/persona.ts（YAML 加载 + 校验）
- [ ] core/scenario.ts（YAML 加载 + 校验）
- [ ] core/llm.ts（Anthropic SDK 包装 + 降级链）
- [ ] core/browser.ts（启动 stealth context + 集成 Stagehand）
- [ ] core/runner.ts（最简 sequential runner，先不并行）
- [ ] handlers/visit.ts + handlers/act.ts + handlers/wait-for.ts
- [ ] cli.ts（最小命令）

### Phase 2：核心能力
- [ ] core/recorder.ts（video/HAR/console/screenshot/hash）
- [ ] core/critic.ts（Claude vision 评分，Sonnet 4.6 默认）
- [ ] handlers/extract.ts + handlers/observe.ts + handlers/assert-visual.ts
- [ ] handlers/check-email.ts（mail.tm）
- [ ] core/reporter.ts（JSON + HTML 双输出）
- [ ] HTML 报告模板（暗色，每 scenario 一 section）

### Phase 3：高阶能力
- [ ] core/computer-use.ts（Playwright-backed Computer Use loop）
- [ ] 关键场景 critical_review 升级路径接通
- [ ] 并行执行（p-limit + 同 origin 串行）
- [ ] 重试策略实现
- [ ] 视觉回归 diff（odiff-bin）
- [ ] 持久化 profile 支持
- [ ] 失败 minimum repro 输出

### Phase 4：六个 persona
- [ ] us-english-free-mobile.yaml
- [ ] jp-japanese-pro-desktop.yaml
- [ ] de-german-power-tablet.yaml
- [ ] cn-chinese-free-mobile.yaml
- [ ] br-portuguese-free-desktop.yaml
- [ ] sa-arabic-pro-mobile.yaml

### Phase 5：八个 scenario
- [ ] 01 OAuth signup
- [ ] 02 Domain check flow
- [ ] 03 Admin panel audit
- [ ] 04 Localization audit
- [ ] 05 Crypto trace purchase
- [ ] 06 Investigation V2 E2E
- [ ] 07 Email opt-in
- [ ] 08 Chrome extension

### Phase 6：CI / 通知 / 文档
- [ ] GitHub Actions workflow 模板
- [ ] Slack/Telegram webhook 通知
- [ ] README.md
- [ ] docs/architecture.md
- [ ] docs/writing-scenarios.md
- [ ] docs/writing-personas.md
- [ ] docs/ci-integration.md

### Phase 7：验收
- [ ] typecheck 通过
- [ ] 在本地用 `--dry-run` 跑 scenario 01 (jp persona)
- [ ] 真实跑一次完整 OAuth signup 验证
- [ ] 生成首份真实报告 review
- [ ] 调整后冻结 v0.1

### Phase 8（后续）
- [ ] 接入 ScamLens 部署后 hook
- [ ] 接入 sandbox（共享 stealth-core）
- [ ] 跨项目复用：把这套搬到 [Developer/](../) 下其他项目
- [ ] 升级到 patchright（应对 Cloudflare CDP detection）

---

## 10. 风险登记册

| 风险 | 影响 | 缓解 |
|---|---|---|
| Stagehand 2.0 API 不稳定 | 中 | pin 版本，封装在 stagehand-wrapper.ts 隔离 |
| Computer Use 速度慢/贵 | 中 | 只用于 critical_review，且有 budget cap |
| Google OAuth 自动化被风控 | 高 | 用专门的测试账号 + IP 一致 + 不要高频跑 |
| Stripe 测试支付影响真实账户 | **高** | 强制 Stripe TEST 模式 + 不允许真实卡 + 校验 publishable key 必须是 `pk_test_` |
| Cloudflare 反爬挡住 ScamLens 自身 | 低 | 自家网站不会，但要注意 admin 路径不要被自家 WAF 误杀 |
| LLM 评分 hallucination | 中 | 多次评分取均值 + Critic prompt 强制 JSON + Zod 校验 |
| 长时间运行内存泄漏 | 中 | 每 N 个 scenario 重启 browser（参考 sandbox 的 MAX_PAGES_BEFORE_RESTART） |
| 报告含敏感数据泄漏 | **高** | 强制 redact + 报告默认 gitignore + 上传前 scan |
| 12 语言审计 token 成本飙高 | 中 | budget cap + 每次抽样 N 个页面而非全量 |
| 失败重试触发 rate limit | 中 | 同 origin 串行 + 指数退避 |

---

## 11. 不做的事（明确边界）

为防止 scope creep，**第一版明确不做**：

1. **不做** Web UI 仪表盘 — CLI + HTML 报告够用
2. **不做** 历史趋势对比 — 用 git 看历次报告 diff
3. **不做** 多用户协作 / 评审流 — 单人本地 + CI
4. **不做** 自动修 bug — 只审计，不动代码
5. **不做** 跨浏览器测试 — 只 chromium，Firefox/Safari 后续
6. **不做** Mobile native app 测试 — 只 web 和 Chrome 扩展
7. **不做** A/B 测试 — 只审计当前线上版本
8. **不做** Lighthouse / Core Web Vitals 集成 — 后续 phase
9. **不做** 自家产品的 stealth 隐身——这是反诈工具，绝不能让自家流量被识别为 bot 流量
10. **不做** 替代真实 QA — 这是补充，不是替代

---

## 12. 成功标准

第一版（v0.1）发布后，需满足：

1. ✅ 能在 1 个命令内跑完 ScamLens 的 8 个 scenario × 4-6 个 persona
2. ✅ 生成的 HTML 报告产品经理能直接看懂
3. ✅ 能发现至少 5 个传统 E2E 找不到的真实 UX 问题
4. ✅ OAuth 链路审计稳定可重复
5. ✅ 12 语言混入审计能定位到具体页面 + 文本
6. ✅ 单次运行成本 < $3
7. ✅ 失败有最小复现命令
8. ✅ 通过 typecheck
9. ✅ 集成到 GitHub Actions 部署后自动跑

---

## 13. 与 ScamLens CLAUDE.md 铁律对齐

| ScamLens 铁律 | ai-browser-auditor 如何遵守 |
|---|---|
| OAuth 保护铁律 | scenario 01 是 P0，每次部署后必跑 |
| 12 语言无英文混入 | scenario 04 专门设计，5 个非英语 persona |
| 商业级 UX 标准 | critic 的 visual_polish 维度强制对标 Stripe/Linear |
| 不能私自降级 | 工具本身不修改 ScamLens 代码，只读 |
| 云资源保护 | 工具不操作云资源，只读浏览器 |
| Bug 分析铁律 | 工具发现 bug 后输出根因分析 + 复现命令，不修 |
| 不写 emoji | 报告 + 通知全程用 [PASS]/[FAIL]/[WARN] 文本标签 |
| 前端不显示原始值 | 工具会专门检测是否泄漏内部 ID/枚举 |

---

## 14. 后续演进路线

| Phase | 目标 |
|---|---|
| v0.1 | 本文档描述的最小可用版本 |
| v0.2 | patchright 升级（应对 CDP runtime leak） |
| v0.3 | Lighthouse + Core Web Vitals 集成 |
| v0.4 | 多浏览器（Firefox via camoufox） |
| v0.5 | 跨项目共享（搬到 Developer/ 下其他项目） |
| v1.0 | 持续运行模式（每小时自动跑关键 scenario） |
| v2.0 | 真实用户行为录制 + 回放（基于真实 session） |

---

## 附录 A：关键依赖清单

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@browserbasehq/stagehand": "^2.0.0",
    "playwright": "^1.49.0",
    "stealth-core": "file:../stealth-core",
    "zod": "^3.23.0",
    "yaml": "^2.6.0",
    "commander": "^12.1.0",
    "p-limit": "^6.1.0",
    "odiff-bin": "^3.1.0",
    "chalk": "^5.3.0",
    "ora": "^8.1.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0"
  }
}
```

## 附录 B：.env.example

```bash
# LLM
ANTHROPIC_API_KEY=sk-ant-...

# Test accounts (Google OAuth dedicated test accounts)
TEST_GOOGLE_US=audit-us@scamlens.test
TEST_GOOGLE_US_PASSWORD=...
TEST_GOOGLE_JP=audit-jp@scamlens.test
TEST_GOOGLE_JP_PASSWORD=...

# Stripe (TEST MODE ONLY)
STRIPE_TEST_PUBLISHABLE_KEY=pk_test_...
STRIPE_TEST_CARD=4242424242424242

# Admin access
SCAMLENS_ADMIN_COOKIE=...

# Optional: residential proxies per region
PROXY_US=http://...
PROXY_JP=http://...
PROXY_DE=http://...

# Optional: notifications
SLACK_WEBHOOK=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Budget cap (USD)
MAX_RUN_BUDGET=3.00
```
