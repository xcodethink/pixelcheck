# PixelCheck v1 — Risk Register（未验证项 + 已知技术债）

> **目的**：把散落在 STATUS.md 各任务里的"未验证"、"遗留"、"deferred"标记**汇总到一个表里**，按严重度排序、明确关闭触发条件。每条对应到具体的解决任务，避免一上线全变线上 bug。
>
> **维护节奏**：每完成一个 Phase 2 任务后回查 → 解决的项标 ✅ + 关闭日期；新发现的标 🆕。
>
> **状态字段**：
> - 🔴 **P0**（阻塞 v1 上线 — 不填会让产品基本能力不可信）
> - 🟠 **P1**（v1.x 内必须收口 — 影响商业承诺，但不阻塞首发）
> - 🟡 **P2**（已记录的 scope 边界 / 自然消化 — 不算债）
>
> **来源截止**：2026-05-01 M1-2 Phase 3 (recorder) 收尾后

---

## 一、🔴 P0 — 阻塞 v1 上线（共 6 类）

| ID | 风险 | 当前状态 | 证据 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R1** | **真 LLM 端到端从未跑过** —— 8 个 primitive (`see` / `judge` / `compare` / `extract` / `act` / `audit_url` / `explore_url` / `calibrate_critic`) 全部用 `vi.mock("@anthropic-ai/sdk")` 覆盖代码路径，但**没有一个测试真调过 Anthropic API**。SDK 升一次版本、模型升一次代、response 形状变一次，整套静默断手 | 单测全 mock | tests/critic.test.ts 等 24 个文件 `vi.mock("./llm.js")` / `vi.mock("@anthropic-ai/sdk")` | M6-5 LLM e2e smoke suite 跑通：每个 primitive 至少 1 次真 API 调用、断言 schema 不变（schema_version=1.2.0）+ cost 落 ledger | **M6-5 Integration tests** |
| **R2** | **真 Stagehand 端到端从未跑过** —— `act` / `extract` 都通过 `_openStagehand` test seam 覆盖路径，但 Stagehand `init()` (5s cold-start) 一次都没跑过。Stagehand 升 v2.0 / v2.1 / v3.0 时静默断手 | 单测 stub | tests/instruction-mutator.test.ts vi.mock("Stagehand")；M9-3 设计文档明确"Stagehand cold-start 5s 让单测不必要地慢" | M6-5 真 Stagehand init() + 1 个 act NL 步骤 + 1 个 extract schema 抽取，跑通 e2e | **M6-5 Integration tests** |
| **R3** | **真 Chromium spawn + 真页面渲染从未在 CI 跑过** —— `recorder.ts` 的 page.evaluate 内部 lazy-load + docHeight 读取（browser-only callback）、`reporter-pdf.ts` 的真 chromium PDF export、`audit_url` / `explore_url` 真页面 navigation 都没在 CI 验证过。生产页面某些 JS 框架 + intersection observer 行为可能让我们的代码卡住 | 单测全 mock Page | recorder.ts:202-228 triggerLazyLoad 内 `await this.page.evaluate(async () => { setInterval... })` browser-only；M2-1 PDF "需 Chromium spawn ~2s 不适合 unit test" | M6-5 在 CI 启 1 次 headless Chromium，跑：(a) recorder.screenshotSegments 真页面（fixture HTML）；(b) reporter-pdf 真 chromium PDF export；(c) audit_url 端到端 1 个 fixture URL | **M6-5 Integration tests** |
| **R4** | **file-lock cross-process race test 全套并行下 ~10-15% flake** —— 这是 baseline 已有的真 bug，从 M9-3 ship 后到现在 6 个月每次任务都标"与本次无关"地拖着。单独跑 20/20 全过；vitest 多 worker 并行下偶发失败 | 已知 flake | M9-3.2 follow-up；STATUS.md 18 处"与 X 无关"标记 | 单一专注任务：要么修 vitest worker 配置（pool/isolate）让 race test 稳定；要么把 race test 移到独立 vitest project | **M9-3.2 Cross-process race test 修复** |
| **R5** | **AI critic 模型质量从未离线评估过** —— `src/calibration/` 已建（labeled fixtures + agreement math）但需要 ANTHROPIC_API_KEY 跑且**从未在 CI 跑过**。模型升级（Sonnet 4.6 → 4.7 → 5.0）后 critic.ts 的 verdict score 漂移没人察觉 | calibration 套件存在但未 wire | src/calibration/ + STATUS critic 任务"calibration 责任 separated" | M6-5（或单独 calibration suite）跑：每周 1 次（或每 release 1 次）跑 calibration baseline，对比 score 漂移 ≥ 5% 报警 | **M8-1 Calibration dataset 公开化** + 自动化 |
| **R6** | **真 axe-core 在生产页面的 WCAG 标签输出形态 +真 GitHub Code Scanning 渲染从未验过** —— `parseAxeTags` 是按 axe-core 文档猜的，axe 实际输出有边界情况；`wcag/X-Y-Z` ruleId 在 GitHub Code Scanning UI 渲染未上传过 SARIF 验证 | parseAxeTags 单测 mock | tests/wcag.test.ts handler 集成测用 mocked axe | M6-5 跑 1 次真 axe-core 在 fixture a11y-broken 页 + 上传 SARIF 到 test repo 看 GitHub UI | **M6-5 Integration tests** |

---

## 二、🟠 P1 — v1.x 内必须收口（共 8 类）

| ID | 风险 | 当前状态 | 证据 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R7** | **6 个 wired LLM 调用点的端到端 cost-guard trip 行为未验** —— M5-6 单测覆盖 hook 路径，但实际"跑到 budget cap 自动停"在生产没真实复现过。误判 cost / ledger 未真持久化跨进程 | 单测覆盖路径 | M5-6 STATUS"已通过单测路径覆盖"；tests/cost-guard*.test.ts | M6-5 跑 1 个 budget=0.01 的 audit_url，断言提前停 + ledger 文件含 expected entries | **M6-5** 子任务 |
| **R8** | **MCP `tools/call` 真 stdio 调用对真实 URL 端到端从未跑过** —— 9 个 primitive 的 MCP transport 路径只跑过 handshake / tools/list smoke，没有对真实 URL 完整跑过；MCP server 在 Claude Code 真用户场景的"agent 调 see → judge → audit_url"链路未真实验 | MCP smoke 限于 handshake | tests/mcp-server.test.ts 仅 transport；STATUS 多次标"MCP handshake + tools/list smoke 已覆盖 transport" | M6-5 跑 1 个 stdio MCP client → 调 audit_url 完整审计 → 解析返回 | **M6-5** 子任务 |
| **R9** | **真 GitHub Actions sticky-pull-request-comment 集成未端到端跑通** —— M2-5 diff Markdown 输出 GFM 严格匹配单测覆盖，但没真在 GitHub PR 上贴过验证渲染；GitLab MR / Bitbucket PR 同 GFM 兼容路径未端到端测 | 单测覆盖 markdown shape | M2-5 STATUS"GitHub Actions sticky-pull-request-comment 真 PR 上贴 markdown 端到端 — 没真正 spawn workflow 验证 GitHub 渲染" | 上传 1 次 fixture diff 到测试 repo 的 PR + 截图归档 | **M6-5** 子任务 + 文档归档 |
| **R10** | **真实多 run history.db 端到端跑 trends.html + 生产规模图表性能未验** —— M2-3 单测用 saveAuditToHistory 覆盖路径但没真累积 100+ runs 看 SVG 渲染性能 + 浏览器加载体验 | 单测 100-row fixture | M2-3 STATUS"图表性能 SVG 在 100 点 ~30ms 渲染单测验证" | M6-5 写 fixture 累 100 runs → 渲染 trends.html → 浏览器加载 < 500ms 断言 | **M6-5** 子任务 |
| **R11** | **5 locale 翻译质量需母语 reviewer 审阅** —— en / zh-CN / ja / es / de 现是我直白专业翻译参照行业 SaaS dashboard 词汇；文化差异 / idiom 问题留 native speaker 反馈；用户碰到才知 | 我自己翻 | M2-4 STATUS"翻译质量需母语 reviewer 审阅" | v1.0 RC 阶段邀请 5 个 native speaker 审；标 "translation reviewed by @username" 在 i18n.ts | **M2-4.2 Native translation review**（new task） |
| **R12** | **CI runner 上 bench 抖动是否更高未验** —— 50% tolerance 是基于 quiet M3 Pro 实测 8-53% 噪声订的；GitHub Actions / Jenkins runner 抖动未采样；可能日常误报 | 本地实测 | M6-7 STATUS"CI runner 上 bench 抖动是否更高 — 单测覆盖了脚本逻辑，但实际 GitHub Actions / Jenkins 抖动需积累几次 release 才能校准" | wire `npm run bench:check` 进 GitHub Actions（仅观察、不阻断），收集 5 次 run 数据 → 看 P95 抖动 → 决定 ratchet 到 30% 还是保持 50% | **M6-7.1 CI bench observation** |
| **R13** | **artifacts 没有自动 prune** —— `~/.ai-browser-auditor/sees/` `acts/` `extracts/` `judges/` `compares/` 重度用户长期跑会累积；v1.0 接受但没机制 | feature-gap | N-1/2/4/3+8 STATUS 都标"artifacts 没有自动 prune（v1.0 接受，未来 task 加 AUDIT_*_RETENTION_DAYS）" | 加 1 个 prune helper（参考 cost-guard 30 天 prune）+ 5 个 AUDIT_*_RETENTION_DAYS env var | **M5-2.1 Artifacts retention** |
| **R14** | **MigrationVersionError downgrade refusal 在生产路径未碰过** —— M5-7 单测覆盖"current=5 vs target=1 抛错"，但用户跑过新 binary 写 v3 后 checkout 老 binary 跑 v1 这种回滚未真碰过；可能误判 ops | 单测覆盖 | M5-7 STATUS"M5-7.1 follow-up 视真实抱怨决定是否给 ops 加旁路（如 --allow-downgrade=migrate-down-from）" | 用户首次报错 → 决定加旁路 OR 接受现状（on-demand） | **M5-7.1**（on-demand 触发） |

---

## 三、🟡 P2 — 已记录的 scope 边界 / 自然消化（共 11 类，**不算债**）

| ID | 风险 | 状态 | 触发 |
|---|---|---|---|
| R15 | RTL（阿语 / 希语）i18n 支持 | 故意 scope out | ADR-023 明确"无人 ask 不上 RTL"；用户 push back 才加 |
| R16 | ICU MessageFormat（处理性数 / 复杂复数） | 故意 scope out | ADR-023 明确"现用中性表达 sidestep"；母语 reviewer push back 才加 |
| R17 | audit.html / audit-explorer.html i18n | M2-4.1 deferred | 500+ LoC 字符串站点；v1.x 视真实地区分布决定 |
| R18 | bare-metal CI runner 上跑 bench 稳定性 | M6-7.1 deferred | 单维护者过度；项目转付费 CI tier 时再考虑 |
| R19 | per-(scenario × persona) 趋势线 | M2-3.1 deferred | 视真实需求加 `--persona <name>` filter |
| R20 | CSV / Excel 数据导出 | 与 audit diff 同 use case | M2-5.1 配合做 |
| R21 | `--fail-on-wcag <level>` CLI flag | 用户可用 `--min-score 9` 替代 | on-demand |
| R22 | reporter-spa 没加 WCAG 段（trends/diff 同理无 a11y） | 设计选择 | spa 是流式探索 UI，WCAG 段在 PDF 即可 |
| R23 | M9-4 cache 自动磁盘 quota | v1.0 接受 | TTL 30 天足够；超 1GB 才考虑加 max-rows |
| R24 | CLI 不自动 `gh pr comment` post | 设计选择 | 不耦合 git host；用户 pipeline 各异 |
| R25 | act 不内置 retry/fallback chain | 设计选择 | audit_url 才有四层 fallback；act 是 primitive 责任清晰 |

---

## 四、🆕 衍生议题（执行 R1-R6 时可能浮现的二级问题）

| ID | 议题 | 备注 |
|---|---|---|
| R26 | **LLM response replay / cassette 库选型** —— 真 LLM e2e 不能每次 CI 都烧 token；需要 record-once / replay-many 模式 | 调研子代理回来后定 |
| R27 | **CI 上 Chromium spawn 的 flake 容忍** —— headless Chromium 在 GitHub Actions 偶发启动慢；需重试策略 + timeout 调优 | M6-5 设计时定 |
| R28 | **Calibration suite 触发频率** —— 每周 / 每 release / 模型版本升级时 —— 决策依据是模型漂移频率 | M8-1 设计时定 |
| R29 | **历史 schema 文件保留策略** —— 1.0 / 1.1 schema 是否 commit 进 docs/schemas/historical/ 来跑跨版本兼容测 | 调研子代理回来后定 |

---

## 五、统计

- **P0 数量**：6 类（R1-R6）—— **必须**在 v1 ship 前关闭
- **P1 数量**：8 类（R7-R14）—— **应**在 v1.x 内关闭
- **P2 数量**：11 类（R15-R25）—— 已记录边界，**不算债**
- **衍生议题**：4 类（R26-R29）

**关键洞察**：
1. **R1 / R2 / R3 / R6 全部归口 M6-5 Integration tests** —— 这一个任务消化掉一半 P0
2. **R5 归口 M8-1 Calibration dataset 公开化 + 自动化** —— 商业模型质量护栏
3. **R4 是 M9-3.2 单一专注任务** —— 6 个月没修，是时候了
4. **R7-R10 都能挂 M6-5 子任务** —— 不另立任务

**结论**：**M6-5 Integration tests 一个任务消化 R1 / R2 / R3 / R6 / R7 / R8 / R9 / R10 共 8 项 P0+P1 风险**。这是性价比最高的下一颗子弹。
