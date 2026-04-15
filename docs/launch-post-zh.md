# 测试全过了，CI 全绿了。但真实用户看到的到底是什么？

**我开源了一个工具：启动真实浏览器，模拟 15 个国家的 18 种用户，告诉你产品体验到底行不行 —— 而不仅仅是代码能不能跑。**

---

## 我是怎么意识到 E2E 测试不够的

我运营一个面向多国用户的 SaaS 产品（[ScamLens](https://scamlens.org)）。每次部署后，CI 流水线全绿。单元测试通过。集成测试通过。Playwright E2E 测试通过。

然后一个日本用户发来邮件：页面有一半是英文。一个阿拉伯用户发来截图 —— 整个布局的左右方向反了。我们的 Google OAuth 登录悄无声息地坏了，10 次部署里坏了 6 次。

这些都不是传统意义上的"bug"。代码是对的。功能能用。但对真实场景下的真实用户来说，**体验是碎的**。

我花了几周手动排查 —— 打开 Chrome，切语言环境，测不同屏幕尺寸，检查 RTL 布局，盯着截图核对翻译。这是发版中最痛苦的环节，而且我还是会漏掉问题。

所以我做了一个工具来自动化这件事。

## AI Browser Auditor 是什么

一个开源的命令行工具：

1. 启动真实 Chromium 浏览器，配置准确的设备指纹（语言、时区、屏幕尺寸、User-Agent）
2. 以 18 种不同角色身份走完你产品的核心流程，覆盖 15 个国家
3. 用 Claude Vision **像人一样看页面**，评估体验质量
4. 用 axe-core 做 WCAG 无障碍合规检测
5. 生成结构化报告：截图、录屏、网络日志、多维度评分

可以理解为：**每次部署后，自动安排一个资深产品经理 + QA + 无障碍审计师，用所有语言、在所有设备上审查你的产品。**

```bash
npm install ai-browser-auditor
npx ai-audit init my-app --url "https://myapp.com"
npx ai-audit run --project my-app
```

## 技术原理

对每个**（角色 x 场景）** 组合，工具会：

**启动一个带指纹的浏览器。** 不只是改屏幕尺寸 —— 它设置语言环境、时区、HTTP 语言头、User-Agent，并注入 15 项反检测补丁，确保你的网站渲染的结果和真实用户看到的一样（而不是被反爬识别后的降级版本）。

**语义化执行步骤。** 场景用声明式 YAML 编写。步骤写的是"点击注册按钮"，不是"点击 #btn-signup-v3"。底层基于 [Stagehand](https://github.com/browserbase/stagehand)，用 Claude 理解页面结构并执行自然语言指令。

**5 层可靠性栈。** 语义化浏览器自动化天然不稳定（基线成功率约 75%）。我们做了五层级联回退，目标 98-99%：

```
L1: 页面稳定性门控     —— 等待网络空闲 + DOM 稳定 + 框架水合完成
L2: LLM 指令改写       —— Haiku 根据 DOM 上下文重写失败的指令
L3a: Selector Hint     —— 可选的 CSS 选择器回退（YAML 中指定）
L3b: 自动 Selector 发现 —— Stagehand observe() 自动提取候选选择器
L4: Computer Use       —— Claude 直接看像素操作浏览器
```

每层只在上一层失败时才触发。成本：L1-L3 基本为零；L4 每次约 $0.01-0.15。

**Claude Vision 评分。** 在视觉检查点，截图被分段发送给 Claude Vision，从多个维度评估页面：

- **completion（完成度）**—— 流程走完了吗？
- **localization（本地化）**—— 文字都是正确的语言吗？
- **visual_polish（视觉质感）**—— 这看起来像专业产品吗？
- **trust_signals（信任信号）**—— 用户会信任这个页面吗？
- **accessibility（无障碍）**—— 所有人都能用吗？（配合 axe-core WCAG 分析）

评分是 0-10 分带解释，不是简单的通过/失败 —— 而是像人一样的综合判断。

**axe-core 做 WCAG 合规。** 专门的 `assert_a11y` 步骤把 axe-core 注入页面，执行规则化的 WCAG 分析。它能捕获 AI 视觉看不到的问题（缺失的 ARIA 标签、对比度不足、键盘导航缺陷），而视觉 Critic 能捕获规则看不到的问题（混乱的布局、难以辨认的文字、糟糕的视觉层次）。

## 18 个角色

这是让工具真正有用（而不只是有趣）的部分。

每个角色不只是一个屏幕尺寸，它是一个完整的身份：

| | 国家 | 语言 | 设备 | 心智模型 |
|---|---|---|---|---|
| 大学生 | 美国 | 英语 | iPhone | "10 秒内给我看到价值，否则走人" |
| 退休教师，72 岁 | 美国 | 英语 | iPad | "这安全吗？会不会被骗？" |
| 主妇 | 日本 | 日语 | MacBook | "只要有一个英文字符串，就觉得这不是给我用的" |
| 安全分析师 | 德国 | 德语 | iPad Pro | "给我看方法论，不要营销话术" |
| 零工平台工人 | 印尼 | 印尼语 | 低端 Android | "我的流量套餐加载得起吗？" |
| 商人 | 沙特 | 阿拉伯语（RTL） | iPhone 15 | "如果布局方向反了，我完全没法用" |
| 学生 | 中国 | 中文 | 小米 | "我需要翻墙才能打开这个" |

......另外还有 11 个角色，覆盖印地语、韩语、越南语、俄语、约鲁巴语/英语、拉美西语、泰语、繁体中文、法语。

AI 审查员**透过他们的眼睛**评判你的产品。当日本角色看到导航栏里有英文字符串，这会被标记为本地化问题 —— 但同样的字符串被美国角色看到就完全正常。

## 输出长什么样

每次审计产出一整套证据包：

```
reports/2026-04-12_post-deploy/
  audit.json              # 机器可读：所有评分、问题、步骤结果
  audit.html              # 暗色主题仪表板，内嵌 SVG 趋势折线图
  summary.md              # 终端友好格式，可粘贴到 CI 日志或 Slack

  jp-japanese-pro__signup-flow/
    01-homepage.png        # 时间戳截图 + SHA-256 哈希
    02-localization.png
    network.har            # 完整网络日志
    console.log            # 浏览器控制台错误
    video/recording.webm   # 会话录屏
```

HTML 报告包含历史趋势图（基于本地 SQLite 数据库），你可以看到产品质量随时间的变化。还能对比任意两次审计：

```bash
ai-audit history                          # 历史评分趋势
ai-audit diff run_0411 run_0412           # 这次比上次变了什么
ai-audit run --min-score 7.5              # CI 质量门禁
```

## 诚实说说局限性

- **成本。** 一次完整的 18 角色审计花费 $80-300 的 Claude API 费用。实际操作中，你会在每次部署时跑 P0 场景（3-5 个角色，约 $5-15），完整矩阵每周跑一次。

- **可靠性。** 98-99% 的目标是架构设计值，还不是经过几百次真实运行验证的数字。我正在多个生产站点上持续验证。

- **不是 E2E 测试的替代品。** 这是 E2E *之后*的那一层。你的测试验证代码正确性，这个工具验证产品质量。

- **依赖 Claude。** 目前需要 Anthropic API key。多模型支持（GPT-4o、Gemini）在计划中但还没实现。

- **新项目。** 这是 v0.2.0。核心引擎稳固且已在一个生产站点上实战检验，但生态（场景模板、社区角色、集成）才刚起步。

## 为什么开源

三个原因：

**1. 角色库应该由社区共建。** 没有任何一个团队能代表全世界所有用户。我希望来自各个国家的人贡献带有真实心智模型和关注点的角色。一个在拉各斯长大的人写出的尼日利亚角色，比我这个外人猜出来的要准确十倍。

**2. 场景模板应该共享。** "OAuth 注册流程"、"结账流程"、"仪表板加载" —— 这些模式是通用的。我们不应该每个人都从零发明。

**3. 这个品类还不存在。** 市场上有浏览器自动化框架（browser-use，87K stars）。有无障碍规则引擎（axe-core，7K stars）。有视觉回归工具（Applitools，$20-100K/年）。但"AI 产品体验审计"作为一个品类，**在开源世界里没有任何成型的工具**。我宁愿把它作为开源来播种这个品类，也不愿意一个人在付费墙后面慢慢搭。

## 试一下

```bash
npm install ai-browser-auditor
npx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...

npx ai-audit init my-app --url "https://your-site.com"
npx ai-audit run --project my-app --headed   # 第一次跑用 headed 模式看浏览器
```

仓库地址：**[github.com/xcodethink/ai-browser-auditor](https://github.com/xcodethink/ai-browser-auditor)**

如果你也经历过"CI 全绿但用户说体验烂了"的时刻，这个工具就是为你做的。欢迎 star、提 issue、贡献角色。

---

## 链接

- GitHub: [xcodethink/ai-browser-auditor](https://github.com/xcodethink/ai-browser-auditor)
- 变更日志: [CHANGELOG.md](https://github.com/xcodethink/ai-browser-auditor/blob/main/CHANGELOG.md)
- 架构文档: [docs/architecture.md](https://github.com/xcodethink/ai-browser-auditor/blob/main/docs/architecture.md)

**技术栈：** TypeScript, Playwright, Stagehand 2.0, Claude (Vision + Computer Use), axe-core, better-sqlite3

**协议：** MIT
