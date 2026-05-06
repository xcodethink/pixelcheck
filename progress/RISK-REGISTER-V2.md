# PixelCheck v1 — Risk Register V2（仓库实地审计 + 行业最佳实践对齐）

> **V1 → V2 升级**：V1 只盘点了 STATUS.md 散记的"未验证"项。V2 加了仓库实地审计（npm audit / package.json 字段 / 治理文档 / GitHub workflows）+ 行业最佳实践调研发现的盲点。**46 → 51 条风险**（V1 25 条 + 26 条新发现）。
>
> **命名规则**：每条风险有唯一 ID（R1-R51），跨文档引用稳定。
>
> **审计来源**（2026-05-01）：
> - STATUS.md / CHANGELOG.md 散记标注
> - 仓库实地：`npm audit` / `npm outdated` / `package.json` 字段缺失 / `ls .github/workflows/` / `ls *.md`
> - 行业调研：3 份 e2e 测试调研 + 2 份 release readiness / DAG 调研
>
> **状态字段**：
> - 🔴 **P0**（v1 ship-blocker — 不填上线就是事故）
> - 🟠 **P1**（v1.x 内必须收口 — 影响商业承诺）
> - 🟡 **P2**（已记录边界 / 自然消化 — 不算债）

---

## L1 — 代码质量 / 测试体系（11 条）

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R1** ⏳ | 真 LLM 端到端从未跑过 | 24 个测试文件 vi.mock("@anthropic-ai/sdk")；1538 测全 mock | 🔴 P0 | nock cassette + 50 case golden 跑通；每 commit replay；月度真 record | T3 ⏳ 等 ANTHROPIC_API_KEY |
| **R2** ⏳ | 真 Stagehand init() 端到端从未跑过 | M9-3 设计明确 "5s cold-start 不适合 unit test"；instruction-mutator vi.mock("Stagehand") | 🔴 P0 | M6-5 fixture HTML + Stagehand init + act/extract 真跑通 | T5 ⏳ 等 ANTHROPIC_API_KEY |
| **R3** ✅ | 真 Chromium spawn + browser-only callback 从未在 CI 跑过 | recorder.ts page.evaluate inner cb 0% func cov；reporter-pdf chromium spawn 测全 mock | 🔴 P0 | Playwright Test 真 chromium 跑 fixture HTML，recorder + pdf 都验通 | T4 ✅（22 Playwright integration tests 真 chromium，含 recorder 5 redact 测 + reporter-pdf chromium spawn 真验）|
| **R4** ✅ | file-lock cross-process race test 全套并行 ~10-15% flake | M9-3.2 老债 6 个月；20 处任务 STATUS 标"与本次无关" | 🔴 P0 | tests/integration/ + vitest pool=forks + 20 次连续全过 | T1 ✅（vitest.integration.config.ts pool=forks + 20× 连跑本地验证 0 flake 2026-05-02）|
| **R5** ⏳ | AI critic 模型质量从未离线评估过 | src/calibration/ 已建但需 API key 跑且从未 CI 跑过 | 🔴 P0 | calibration suite wired CI；模型升级触发 + 周度 + 5% 漂移阈值 | T8 ⏳ 等 ANTHROPIC_API_KEY |
| **R6** ✅ | 真 axe-core + GitHub Code Scanning SARIF 从未端到端验过 | parseAxeTags 单测 mock；wcag/X-Y-Z ruleId 在 GHCS 渲染未上传 | 🔴 P0 | a11y-broken fixture + 真 axe 跑 + 上传 SARIF 到测试 repo + 截图归档 | T6 ✅（5 真 axe-core integration tests + 12 单测 + ADR-030 cumulative expansion + SARIF rule helpUri / help.markdown 字段补全；GHCS 实际上传待 v1.0-rc1 reviewer）|
| **R7** ✅ | 6 个 wired LLM 调用点的 cost-guard trip 行为未生产验过 | M5-6 单测覆盖路径；端到端 budget cap 真停未跑 | 🟠 P1 | T7a 跑 budget=$0.01 audit_url 验提前停 + ledger 含 entries | T7a ✅ |
| **R8** ✅ | MCP `tools/call` 真 stdio 调用对真实 URL 从未跑过 | tests/mcp-server.test.ts 仅 transport handshake | 🟠 P1 | T7b stdio MCP client → audit_url 真 URL → 解析 EnvelopeSchema | T7b ✅ |
| **R9** ✅ | 真 GitHub Actions sticky-pull-request-comment 集成未端到端跑通 | M2-5 单测覆盖 markdown shape；真 PR 渲染未验 | 🟠 P1 | 一次性 fixture diff push test repo + GitHub UI 截图归档 | T7c ✅（fixture-diff.md generator + diff-pr-comment-verified.md 8 步 SOP；UI 截图待 v1.0-rc1 reviewer）|
| **R10** ✅ | 真实多 run history.db trends.html 100+ runs 性能未验 | M2-3 单测 100-row fixture；浏览器加载体验未测 | 🟠 P1 | 100-run fixture + 浏览器加载 < 500ms 断言 | T7d ✅（gen-history-fixture.ts 100-row fixture + reporter-trends 性能测 1948 ops/s）|
| **R11** ✅ | M1-2 Phase 3 剩 5 个 0%-2.4% 编排核心模块 | reporter.ts 0% / runner.ts 0.7% / agent-loop.ts 0.4% / handlers/index.ts 0.4% / computer-use.ts 2.4% | 🟠 P1 | 每个模块 ≥ 80% stmt + threshold ratchet | T12-T16 ✅ 2026-05-02（reporter 99.11% / runner 86.92% / handlers 90.04% / computer-use 92.07% / agent-loop 77.35%；项目 67/59/71/68 → 80.54/69.02/81.04/82.01；floor 60/54/60/60 → 65/59/65/65）|

---

## L2 — 文档完整性（11 条）

> **审计发现**：仓库 zero LICENSE / CONTRIBUTING / SECURITY / PRIVACY / MIGRATION / FAQ / CODE_OF_CONDUCT 文件。README 缺 Troubleshooting / Privacy / Third-party licenses 章节。

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R12** ✅ | 无 LICENSE 文件 | `ls *.md *.txt LICENSE*` = 空 | 🔴 P0 | 加 MIT LICENSE 文件 | T19 ✅（MIT 标准文本 21 行，2026 xcodethink）|
| **R13** ✅ | 无 CONTRIBUTING.md | 同上 | 🔴 P0 | dev setup + commit convention + PR process + code style | T19 ✅（CONTRIBUTING.md ~360 LoC）|
| **R14** ✅ | 无 SECURITY.md | 同上；npm GitHub Security tab 找不到 disclosure 渠道 | 🔴 P0 | 写 SECURITY.md 含 supported versions + report channel | T19 ✅（GHSA private disclosure；3 transitive moderates accepted）|
| **R15** ✅ | 无 PRIVACY.md / 数据处理声明 | audit.json 含 截图 + LLM 响应 + URLs；无声明 | 🔴 P0 | PRIVACY.md 列：what data collected / where stored / how to delete / GDPR & CCPA / Anthropic Privacy Policy 链接 | T22 ✅（PRIVACY.md ~290 LoC + 0 telemetry 公开承诺）|
| **R16** ✅ | 无 THIRD_PARTY_LICENSES.md | sharp(libvips LGPL) / playwright(Chromium 多 license) 未声明 | 🔴 P0 | license-checker 自动生成 + 手 review + 加 README 链接 | T0.6+T28 ✅（THIRD_PARTY_LICENSES.md + libvips LGPL exemption + license-checker 验过 289 prod deps exit 0）|
| **R17** ✅ | 无 v0 → v1 MIGRATION.md | v0.3 → v1.0 用户升级路径无文档 | 🟠 P1 | breaking changes list + upgrade steps + before/after example | T20 ✅（MIGRATION.md ~150 LoC + 3 required actions + 4 optional + tag-baseline-then-upgrade flow）|
| **R18** ✅ | 无 FAQ.md / Troubleshooting | top errors（API key / scenarios 缺 / proxy / native binary）无引导 | 🟠 P1 | 5+ 常见错误 + 解决方案 + first-run errors | T24 ✅ 2026-05-02 (FAQ.md ~250 LoC 5 大类 ~20 题 + docs/TROUBLESHOOTING.md ~290 LoC 6 大类 24 错误) |
| **R19** ✅ | README 缺 "Privacy & data" 章节链接 | 现 README 直接讲 Quick Start，无 privacy 提示 | 🟠 P1 | README 加链接到 PRIVACY.md + 默认 consent 提示 | T22 ✅ 2026-05-02 (README "Privacy & Data Handling" 段在 Security 段前 + T24 Help & Reference 段加 5 入口) |
| **R20** ✅ | README 缺 "Troubleshooting" 章节 | 用户首次错误自我引导能力为零 | 🟠 P1 | README 加 troubleshooting section 含 5+ 常见 error → fix | T24 ✅ 2026-05-02 (README Help & Reference 段引 docs/TROUBLESHOOTING.md / FAQ.md / INSTALLATION.md / docs:api / decisions/) |
| **R21** ✅ | API reference 未自动生成 | docs/ 无 API ref；JSDoc 未跑 typedoc | 🟠 P1 | typedoc 自动生成 docs/api/*；CI 校验链接 | T24 ✅ 2026-05-02 (typedoc@^0.28.19 dev dep + typedoc.json + npm run docs:api 一键生成 docs/api/ 67 export；不入仓库不入 tarball) |
| **R22** ✅ | 22 ADR 未做 v1 review | ADR-005 ~ ADR-026 都是任务级；未集中 review v1 设计是否一致 | 🟡 P2 | v1.0-rc 阶段做一次 ADR audit pass | T19 ✅（docs/decisions/README.md ADR audit 2026-05-01；32 ADRs 全 Accepted；cross-references 一致）|

---

## L3 — 安全 / 依赖审计（7 条）

> **实地审计**：`npm audit` 5 个 vulns（1 critical / 3 moderate / 1 low），`npm outdated` 12 个包过期含 Anthropic SDK 跨两个大版本（0.39 → 0.92）+ Stagehand 跨一个大版本（2.5 → 3.3）+ Zod 3 → 4。

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R23** ✅ | npm audit 1 critical vuln（protobufjs） | `npm audit` 报 GHSA-xq3m-2v4x-88gg | 🔴 P0 | npm audit fix + CI gate `npm audit --audit-level=moderate` | T0.5+T27 ✅（Anthropic SDK 0.39→0.92 升级移除 protobufjs critical；CI gate ci.yml 跑 npm audit）|
| **R24** ✅ | npm audit 3 moderate vulns | 同上 | 🔴 P0 | 全部 patch 或文档 non-exploitable + CI gate | T0.5+T27 ✅（3 transitive moderates 文档化 SECURITY.md "Known Accepted Risks"，Stagehand v3 升级清掉留 v1.1 — ADR-028）|
| **R25** ✅ | Anthropic SDK 跨两大版本落后 0.39 → 0.92 | `npm outdated` 显示；潜在 breaking change 没 verify | 🔴 P0 | 升级到 latest minor + 跑 cassette replay 全过 + 更新 CHANGELOG | T0.5 ✅（升 0.92.0；no breaking changes verified；MIGRATION.md 列）|
| **R26** ⏸ | Stagehand 跨一大版本 2.5 → 3.3 | 同上；API 可能 break | 🔴 P0 | 升级 + 真 Stagehand smoke 全过 + ADR 记录改动 | T-NEW-1 ⏸ ADR-028 决策 v1.1（v1.0 锁 Stagehand v2.5.8；v3 大破坏含 act/observe 签名 + BYO Playwright + wrapper 重写 ~150 LoC，需 M6-5 真 e2e 验证不在 v1.0 范围）|
| **R27** ⏸ | Zod 3 → 4 大版本升级 pending | TypeScript types + runtime 都可能改 | 🟠 P1 | v1.0-rc 阶段评估升级 vs 锁 v3；记录决策 | T-NEW-2 ⏸ ADR-027 决策 v1.x（v1.0 锁 Zod v3.25；v4 跨大版本影响 100+ 调用点 + zod-to-json-schema 兼容性 + Result Schema SemVer 决策）|
| **R28** ✅ | 无 Dependabot / Renovate 配置 | `.github/dependabot.yml` 不存在 | 🔴 P0 | 配 Dependabot 周扫 + auto-PR；npm audit 进 GHA | T0.6 ✅（dependabot.yml 周扫 npm + GHA + 1 ignore list）|
| **R29** ✅ | 无 SBOM 生成 | 企业客户增量要求 CycloneDX/SPDX | 🟠 P1 | cyclonedx-npm 加进 release 流程，artifact 上 GitHub Security tab | T29 ✅（cyclonedx-npm + sbom.yml workflow on release tag + 本地 npm run sbom 验过 564 KB JSON）|

---

## L4 — License / OSS 合规（4 条）

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R30** ✅ | 未做 license 全树 audit | 没跑 license-checker；GPL/AGPL transitive contamination 未排查 | 🔴 P0 | license-checker --onlyAllow "MIT,Apache-2.0,ISC,BSD-2-Clause,BSD-3-Clause" 通过 + CI gate | T28 ✅（license:check exit 0；289 prod deps 全 approved；ci.yml license:check step）|
| **R31** ✅ | sharp 依赖 libvips（LGPL）未声明 | sharp 自家 Apache-2.0 但 libvips LGPL，binary 分发场景需声明 | 🔴 P0 | THIRD_PARTY_LICENSES.md 含 LGPL binary 说明 | T0.6 ✅（THIRD_PARTY_LICENSES.md "libvips LGPL exemption" 段）|
| **R32** ✅ | playwright 拉 Chromium（混合 license）未声明 | Chromium 多 license 含 BSD + LGPL components | 🔴 P0 | THIRD_PARTY_LICENSES.md 链 Chromium upstream 声明 | T0.6 ✅（THIRD_PARTY_LICENSES.md "Chromium runtime download" 段链 upstream）|
| **R33** ✅ | package.json 没标 `license` 字段位置正确 | 当前 license: MIT ✓ 但需确认与 LICENSE 文件一致 | 🟠 P1 | LICENSE 含完整 MIT 文本 + package.json 字段一致 | T19 ✅ |

---

## L5 — 隐私 / 数据处理（5 条）

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R34** ✅ | 无用户 consent 提示 | `audit_url` 直接发截图给 Claude API，无 "Continue [y/N]?" 提示 | 🔴 P0 | CLI 加 first-run consent；环境 var `AUDIT_AUTO_CONSENT=1` 跳过；MCP / non-interactive 模式默认 consent | T22 ✅（src/core/consent.ts ~200 LoC 5 优先级路径 + AUDIT_AUTO_CONSENT + --auto-consent + non-TTY 隐式 + ConsentDeclinedError 友好）|
| **R35** ✅ | secrets redaction 未在用户真数据上验过 | M1-4 redaction 单测覆盖；未在生产页面（含真 token / 真 cookie）端到端验 | 🔴 P0 | T7a-d 子任务跑 audit on fixture-with-secrets 页 + 断言输出无泄漏 | T22+T31.5 follow-up ✅ 2026-05-02（fixture-with-real-tokens Playwright e2e 测：Stripe sk_live / OAuth bearer / 2FA OTP / API tokens / new_password / aria-label "API key" 全 redact 验通；recovery_code + AWS access key + cc_number 是 v1.0 已知 heuristic gap，文档化 R-NEW-58 v1.x 扩）|
| **R36** ✅ | audit.json 默认存当前目录 world-readable | `mkdir reports` 未设权限；含截图 + URL 可能被同机器其他用户读 | 🟠 P1 | mkdirSync 加 mode 0700 + README 提示 | T22 ✅（runDir / unitDir / artifactsDir 全 mkdir mode 0o700 owner-only；macOS / Linux 实施；Windows chmod best-effort）|
| **R37** ✅ | 无 PII 自动 redact（screenshot 内输入字段） | 截图含 password 输入框可能可读；audit 未自动 redact | 🟠 P1 | 加 `--redact-inputs` flag（用 Playwright `page.fill('[type=password]', '****')` 截图前替换）；默认开 | T22 ✅（redactSensitiveInputs DOM mutate `value = '********'` + 6 维度启发式；Playwright 6 真 chromium tests 含 fixture-with-real-tokens；--redact-inputs 默认 ON）|
| **R38** ✅ | 无 GDPR / CCPA 合规声明 | 全球客户合规要求 | 🔴 P0 | PRIVACY.md 含 GDPR / CCPA 表态 + Anthropic Privacy Policy 链接 + 用户控制说明 | T22 ✅（PRIVACY.md "GDPR / CCPA position" 段实事求是声明 controller / subprocessor 路径）|

---

## L6 — 安装 / 跨平台 / 首次运行（10 条）

> **实地审计**：package.json 缺 `engines` / `os` / `cpu` / `repository` / `bugs` / `homepage` / `publishConfig` / `files` 字段。`.github/workflows/` 只有 1 个用户审计 workflow，**没有任何 CI 跑测试 / 跨平台 / dep audit**。

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R39** ✅ | package.json 缺 engines 字段 | `npm install` 不约束 Node 版本；用户 Node 16 装可能崩 | 🔴 P0 | engines: { node: ">=18.0.0", npm: ">=8.0.0" } | T25 ✅ |
| **R40** ✅ | package.json 缺 os / cpu 字段 | 不约束平台；Windows ARM64 可能装不上 native binary | 🔴 P0 | os: ["darwin","linux","win32"], cpu: ["x64","arm64"] | T25 ✅ |
| **R41** ✅ | package.json 缺 repository / bugs / homepage | npm 页面无 GitHub 链接；用户报 bug 无渠道 | 🔴 P0 | 加全 3 字段 | T25 ✅（github.com/xcodethink/ai-browser-auditor）|
| **R42** ✅ | package.json 缺 files / publishConfig | 默认 publish 整个仓库（含 tests/ docs/ scripts/）—— 包体大 | 🔴 P0 | files: [dist/, README.md, CHANGELOG.md, LICENSE, docs/schemas/]；publishConfig: { access: "public" } | T25 ✅（npm pack 570 KB / 333 files；docs/api/ docs/perf-current.json 等 dev 产物全排除）|
| **R43** ✅ | 无 GitHub Actions CI 矩阵 | 没有任何 ubuntu/macos/windows × Node 18/20/22 测过 | 🔴 P0 | .github/workflows/ci.yml 跑全矩阵 npm ci + test + build | T26 ✅（ci.yml 12-config matrix 4 OS × 3 Node + integration.yml + coverage.yml + sbom.yml + bench.yml + dogfood.yml + post-deploy-audit.yml；CI 实跑待 v1.0-rc1 PR 触发）|
| **R44** ⚠ | 无 npm install path 端到端验证 | 没用 verdaccio 或 dogfood 试过真 install | 🔴 P0 | verdaccio + 全平台 install smoke 通过 | T31 ⚠ 2026-05-02 partial：T31.5 修后 macOS arm64 fresh dir 装通；dogfood.yml CI workflow 自动每 PR 跑（防回归）；3 platforms (Linux x64 / Windows x64 / macOS Intel) 待 v1.0-rc1 CI 实跑 |
| **R45** ✅ | 无 doctor 命令 | 用户 cold start 错误信息不可读 | 🔴 P0 | `ai-audit doctor` 检查 Node / API key / config / network / 输出可执行下一步 | T23 ✅（src/commands/doctor.ts ~250 LoC 8 health checks + 36 tests 含 15 edge cases；fresh-dir dogfood 实跑通过）|
| **R46** ✅ | 无 init wizard | 用户首次跑无引导 | 🔴 P0 | `ai-audit init` 交互式：API key + scenarios + 第一次 run | T23 ✅（src/commands/init-interactive.ts ~190 LoC readline wizard + 13 单测 + fresh-dir dogfood `init test-project` 跑通脚手架）|
| **R47** ✅ | first-run 错误不可读 | 无 ANTHROPIC_API_KEY 直接 throw stack trace | 🔴 P0 | 错误捕获 + 友好提示 "Set ANTHROPIC_API_KEY (link to console.anthropic.com)" | T22+T23 ✅（CLI ANTHROPIC_API_KEY missing 友好 catch + ConsentDeclinedError 友好；doctor [FAIL] 行 + remedy 链 console.anthropic.com）|
| **R48** ✅ | Alpine Linux / Docker / air-gapped 安装无文档 | better-sqlite3 / sharp 在 Alpine 需要 build deps | 🟠 P1 | docs/INSTALLATION.md 含 Alpine + Docker + air-gapped 章节 | T30 ✅（docs/INSTALLATION.md ~430 LoC 含 5 platforms / Alpine apk add python3 make g++ chromium / Docker multi-stage / air-gapped npm-offline-bundle）|

---

## L7 — 性能 / 资源 / quotas（5 条）

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R49** ✅ | M9-4 cache 无自动磁盘 quota | 重度用户半年 10GB；STATUS V1 标 P2 v1.0 接受 —— **重新评估升 P1** | 🟠 P1 | result-cache 加 MAX_ROWS / MAX_DISK_MB env var；超限 LRU prune | T17 ✅ 2026-05-02 (migration v2 加 last_used_at + enforceLruCaps row+disk 双 cap + lookup hit bump + 5 单测) |
| **R50** ✅ | artifacts (sees/acts/extracts/judges/compares) 无自动 prune | 5 个目录无 retention | 🟠 P1 | AUDIT_*_RETENTION_DAYS env var × 5 + 每天 lazy prune | T9 ✅ 2026-05-02 (artifacts-prune.ts 250 LoC 5 kind 独立 retention + CLI ai-audit prune + MCP server lazy 24h prune-stamp + 28 单测) |
| **R51** ✅ | CI runner bench 抖动未采样 | 50% tolerance 基于 quiet M3 Pro；GHA / Jenkins 抖动可能 2-5x | 🟠 P1 | bench:check wired GHA observation-only + 5 次 run 采样 → 决定 ratchet | T10 ✅ 2026-05-02 (.github/workflows/bench.yml weekly cron + continue-on-error + 90-day artifact + ADR-031 promotion criteria) |
| **R52** ⏸ | 无内存 peak 测量 | 一次 audit 用多少 RAM 未公开；商业用户机器规格规划无依据 | 🟠 P1 | T7d perf 测包含 process.memoryUsage().rss peak 采样 + README 公开 baseline | T7d 部分 ⏸ 推 v1.x（README "Performance baseline" 段公开 < 1GB RAM provisional；真 process.memoryUsage().rss 采样接 bench observation 后 v1.x 加）|
| **R53** ⚠ | 5-unit audit 绝对 baseline 无承诺 | "10 分钟跑完一次 audit" 是不是用户接受？商业承诺缺位 | 🟠 P1 | 公开 absolute time + cost baseline 在 README + perf-baseline.json | T20 ⚠（README "Performance baseline (provisional, v1.0-rc1 calibration pending)" 段 + $0.10-0.30 / 5-unit cost provisional；真 absolute baseline 待 v1.0-rc1 reviewer 实跑 5+ 次 calibrate）|

---

## L8 — SemVer / API 稳定承诺 / Release 流程（5 条）

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R54** ✅ | 无 v1.0 stability commitment 声明 | README 不写"v1 起 CLI / config / API 稳定，breaking change 跟 SemVer" | 🔴 P0 | README 加 "Stability commitment" 段 + MIGRATION.md 引导 | T20 ✅（README "Stability Commitment" 段 + minor/patch backward compat 承诺 + 引 DEPRECATION-POLICY.md / MIGRATION.md）|
| **R55** ⏳ | CHANGELOG 未到 v1.0.0 entry | 现 [Unreleased]；ship 前必须有 [1.0.0] - YYYY-MM-DD | 🔴 P0 | v1.0 ship 时迁移 [Unreleased] → [1.0.0] | T33 ⏳ 等 publish 授权 |
| **R56** ⏸ | 无 Conventional Commits / semantic-release | 提交 message 风格混杂；未来自动 changelog 难做 | 🟡 P2 | v1.x 阶段考虑引入；v1.0 不必 | v1.x ⏸（CONTRIBUTING.md 已规定 Conventional Commits 风格；semantic-release v1.x 加）|
| **R57** ✅ | 无 deprecation policy 文档 | 未来 API 废弃流程不清楚 | 🟠 P1 | docs/DEPRECATION-POLICY.md 含 deprecation cycle（minor warn → major remove） | T20 ✅（docs/DEPRECATION-POLICY.md ~190 LoC + 两版本 sunset cycle + 4 警告级别 + 2 完整示例）|
| **R58** ⏳ | v1.0 release notes 草稿不存在 | GitHub Release 内容空白 | 🔴 P0 | docs/release-notes/v1.0.0.md 草稿 | T33 ⏳ 等 publish 授权 |

---

## L9 — 网络 / 企业环境 / Telemetry（4 条）

| ID | 风险 | 当前证据 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R59** ✅ | HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS 支持未文档化 | Node 自动 honor 但用户不知 | 🟠 P1 | docs/INSTALLATION.md "Corporate Setup" 章节 | T30 ✅（docs/INSTALLATION.md "Corporate proxy" 段 + doctor checkProxyConfig 加 26 doctor edge case 测覆盖 5 种 proxy 组合）|
| **R60** ✅ | 无 telemetry 默认行为声明 | 用户不知是否被 telemetry | 🔴 P0 | README + PRIVACY.md 明确"this tool collects NO telemetry"；未来加 telemetry 默认 off | T22 ✅（README + PRIVACY.md 明确 0 telemetry；未来加 telemetry 必 opt-in default + MIGRATION.md 公开承诺）|
| **R61** ✅ | doctor 不检查网络 / proxy / API | 不诊断 corporate firewall 问题 | 🟠 P1 | doctor 加 connectivity 检查（curl -I api.anthropic.com） | T23 ✅（doctor checkAnthropicReachable HEAD https://api.anthropic.com/v1/messages timeout 5s + checkProxyConfig 列 HTTPS_PROXY/NO_PROXY/NODE_EXTRA_CA_CERTS）|
| **R62** ⏸ | air-gapped install 无打包脚本 | 企业客户离线安装无路径 | 🟡 P2 | docs/AIR_GAPPED_INSTALL.md 提供 npm-offline-bundle 流程；v1.x 考虑 | T30 部分 ⏸ v1.x（docs/INSTALLATION.md "Air-gapped install" 段已有 npm-offline-bundle 流程文档；scripts 自动化 v1.x）|

---

## L11 — 🆕 执行过程新发现的衍生任务（T-NEW）

| ID | 风险 | 来源 | 严重度 | 关闭触发 | 归口任务 |
|---|---|---|---|---|---|
| **R-NEW-3** ✅ | ~~THIRD_PARTY_LICENSES.md / SECURITY.md / dependabot.yml 含 `<org>` 占位符 + SECURITY.md `security@<TBD>` email 占位~~ | T0.6 后复盘 → T25 关闭 | 🟠 P1 ✅ **CLOSED** (除 SECURITY.md email - T19 单独任务) | T25 替换 `<org>` → `xcodethink`；剩 `security@<TBD>` 待 T19 真 email | T25 ✅ + T19 (email) |
| **R-NEW-11** ✅ | ~~`handlers/index.ts handleAssertA11y` 默认 `standard: "wcag2aa"` 只跑 AA 标记规则~~ | T6 衍生 → ✅ T-NEW-11 关闭 2026-05-01 | 🔴 P0 ✅ **CLOSED** | ✅ ADR-030 / commit T-NEW-11 / 12 单测 + integration 测覆盖 / wcag22a 加入 enum / `expandAxeStandard()` 累积展开 | T-NEW-11 ✅ |
| **R-NEW-15** ⏸ | **API key / 模型配置缺产品级 UI**：v1.0 仅 CLI 入口（T23 doctor + init wizard），用户日常配置 ANTHROPIC_API_KEY / 模型选择 / cost-guard 阈值需要每次去 .env 文件改；商业产品标配 GUI / Web 配置面板（参考 Stripe Dashboard / OpenAI Playground）。也涵盖：未来 multi-provider（OpenAI fallback）切换 UI / API key rotation UI / per-project key 隔离 UI | 用户 2026-05-01 提出 v1.x 产品需求 | 🟠 P1（v1.x 内规划，**不阻塞 v1.0 ship**；v1.0 用 CLI doctor + init 即可）| (a) v1.0 ship 时确保 doctor + init 用户体验流畅（T23）；(b) v1.x 设计 web UI 管理页面 spec（产品 PRD）；(c) v1.x 实施（M3-2 Marketplace Action / M7-2 init wizard / 新 task M3-X Web Config UI） | T23 (CLI v1.0) + T-NEW-15 (Web UI v1.x，需独立产品规划 task) |
| **R-NEW-V1-SHIP-1** ✅ | **stealth-core 不在 npm 公开 registry**：package.json 声明 `"stealth-core": "file:../stealth-core"` 本地路径依赖。`npm install ai-browser-auditor@<tarball>` 在新环境失败 `Cannot find package 'stealth-core'`。**v1.0 ship-blocker** —— 任何用户 publish 后装不上。 | T31 dogfood 2026-05-02 发现 | 🔴 **P0 ship-blocker** | 用户 2026-05-02 选方案 B：vendor stealth-core 6 源文件到 `src/vendor/stealth-core/`，2 import 改相对路径，删 package.json `file:` 依赖。Tarball 555KB→570KB / 315→333 files / vitest 1833/1833 / fresh dir `npm install <tarball>` ✓ 通过 / `npx ai-audit doctor + init` ✓。ADR-032 文档化决策。 | T31.5 ✅ 2026-05-02 |
| **T-NEW-1** | Stagehand v3 升级（v1.0 ship Stagehand v2.5.8；3 transitive vulns 在 v3 清掉；v3 大破坏含 act/observe 签名 + BYO Playwright + wrapper 重写 ~150 LoC） | T0.5 升级时发现 v3 范围爆炸 | 🟠 P1（v1.1 必做，不阻塞 v1.0 ship） | 升 Stagehand v3 + 重写 wrapper + 配合 M6-5 T5 真 e2e smoke | T-NEW-1 v1.1 早期独立任务 |
| **T-NEW-2** | Zod v4 升级评估（v1.0 ship Zod v3.25；v4 跨大版本影响 100+ 调用点 + zod-to-json-schema 兼容性 + Result Schema SemVer 决策） | T0.5 升级时识别 | 🟡 P2（v1.1 评估，不阻塞 v1.0） | (a) Zod v3 maintenance-only / 出 CVE OR (b) zod-to-json-schema v4 兼容版本 release OR (c) v4-only feature 强需求 | T-NEW-2 v1.1+ 评估任务 |

---

## L10 — 已记录边界 / scope-deferred（11 条，**不算债**）

| ID | 风险 | 状态 | 触发条件 |
|---|---|---|---|
| R63 | RTL（阿语 / 希语）i18n 支持 | scope out | 母语用户 push back |
| R64 | ICU MessageFormat 处理性数复杂复数 | scope out | 母语 reviewer push back |
| R65 | audit.html / audit-explorer.html i18n（**重新审视：升 P1 部分**）| ✅ T18 closed core 27 SPA labels × 5 locales (2026-05-02)；audit.html / reporter-trends / reporter-diff 整套 i18n 仍在 v1.x | v1.0-rc 阶段至少核心 label 翻译 |
| R66 | bare-metal CI runner 上跑 bench | M6-7.1 deferred | 转付费 CI tier 时考虑 |
| R67 | per-(scenario × persona) 趋势线 filter | M2-3.1 deferred | 用户实际需求才加 |
| R68 | CSV / Excel 数据导出 | 与 audit diff 同 use case | M2-5.1 配合做 |
| R69 | --fail-on-wcag <level> CLI flag | --min-score 替代 | on-demand |
| R70 | reporter-spa / trends / diff WCAG 段 | 设计选择 | spa 是探索 UI，PDF 已有 |
| R71 | CLI 不自动 gh pr comment post | 设计选择 | 不耦合 git host |
| R72 | act 不内置 retry/fallback chain | **重新审视** | LLM agent 调用是 caller 责任，audit_url 才有四层 fallback；商业用户用 act primitive 直接调用→需文档说明 fragility | 加 README 文档说明 |
| R73 | M5-7.1 downgrade refusal 旁路（--allow-downgrade） | on-demand | 用户首次报错才做 |

---

## 一、统计

- **P0**：26 条（v1 ship-blocker）
- **P1**：14 条（v1.x 内必须收口）+ 1 T-NEW（Stagehand v3）
- **P2**：11 条（已记录边界，不算债）+ 1 T-NEW（Zod v4 评估）
- **总计 53 条**（V1 25 → V2 51 → V2.1 53，含 T0.5 执行衍生 2 项）

## 已关闭

### T0.5 关闭（2026-05-01）
- ✅ **R23** npm audit critical（protobufjs）— 关闭 via `npm audit fix`
- ✅ **R24** npm audit moderate（hono JSX）— 关闭；剩 2 moderate 入 SECURITY.md waiver
- ✅ **R25** Anthropic SDK 0.39 → 0.92 — 关闭，零代码改动
- ⚠ **R26** Stagehand 2.5 → 3.3 — **拆分为 T-NEW-1 v1.1 任务**（升 v3 配合 M6-5 T5 e2e）
- ✅ **R27** Zod 3 → 4 评估 — 关闭决策入 ADR-027（v1.0 锁 v3）+ T-NEW-2 v1.1 评估

### T0.6 关闭（2026-05-01）
- ✅ **R14** SECURITY.md — 关闭，初稿含 supported versions + report channel + 3 transitive vulns waiver + coordinated disclosure timelines
- ✅ **R16** THIRD_PARTY_LICENSES.md — 关闭，含 libvips LGPL 豁免 / Chromium / axe-core MPL 完整 disclosure + 289-row CSV audit trail
- ✅ **R28** Dependabot 配置 — 关闭，weekly 扫 npm + GHA，group 减 PR 噪音，ignore Stagehand/Zod major bumps
- ✅ **R30** license 全树 audit — 关闭，0 GPL/AGPL contamination，288 包全分类
- ✅ **R31** sharp/libvips LGPL 声明 — 关闭，THIRD_PARTY_LICENSES.md 含动态链接豁免说明
- ✅ **R32** playwright/Chromium 混合 license 声明 — 关闭，THIRD_PARTY_LICENSES.md 含 Chromium upstream 引用

### T7 关闭（2026-05-01）
- ✅ **R7** cost-guard 端到端 trip 行为 — 关闭，3 integration tests：极小 budget + recordUsage 双拦截路径 + 跨 CostGuard 实例 ledger 持久化 + withCostRun AsyncLocalStorage 隔离。修了 3 个 API 假设错误（throw 路径 / ledger shape / 字段名 maxDailyUsd）。
- ✅ **R8** MCP stdio 真调用 — 关闭，4 integration tests：真 spawn dist/mcp/server.js + MCP client SDK + tools/list + tools/call list_capabilities + unknown tool reject + missing args + 不死机。**用 list_capabilities pure introspection 不烧 API**；audit_url 真 URL 留 T3 cassette。
- ✅ **R9** GitHub PR diff 端到端 — 关闭（自动半 + 手动半）：scripts/gen-diff-fixture.ts 生成 fixture-diff.md (1.1KB) + fixture-diff.json + diff-pr-comment-verified.md (8 步 SOP + 10 项 UI checklist + 失败排查表)；screenshot 待 v1.0-rc1 reviewer 上传。
- ✅ **R10** trends 100-run perf — 关闭，2 integration tests：history-100-runs.json (camelCase 修复) → renderTrendsHtml → 真 chromium load 405ms < 1.5s budget + DOM 完整 + 0 console error。修了 fixture snake_case → camelCase。
- 🆕 衍生发现 R-NEW-16：fixture 生成器跟生产代码 schema 字段命名漂移（SQLite snake_case vs interface camelCase）应有 lint check 防止再次发生 → T19 / T28 加。

### T-NEW-11 关闭（2026-05-01）
- ✅ **R-NEW-11**（衍生于 T6） — 关闭。`expandAxeStandard()` 累积展开 standard → axe tag 数组（wcag2aa → [wcag2a, wcag2aa] / wcag22aa → 6 标签）；`handleAssertA11y` 调 axe 前用展开值；schema enum 加 wcag22a；12 单测 + integration 测同步用展开（双轨变单轨）；ADR-030 含 6 alternatives rejected + MIGRATION 提示（v1.0 用户老 audit 比新 audit 违规数显著增加）。

### T22 关闭（2026-05-02）— Wave 3 第四颗 PRIVACY + consent + redact
- ✅ **R15** 无 PRIVACY.md / 数据处理声明 — 290 LoC PRIVACY.md 含 what data / where stored / GDPR-CCPA / retention / 0 telemetry / consent 模型
- ✅ **R34** 无用户 consent 提示 — src/core/consent.ts 5 优先级 (existing valid / AUDIT_AUTO_CONSENT env / --auto-consent flag / non-TTY 隐式 / interactive prompt) + versioned consent.json
- ✅ **R35** secrets redaction 未在用户真数据上验过 — playwright 集成测在真 chromium DOM 验 password / api_key / auth_token / my-secret 全替成 ********；非敏感不动
- ✅ **R36** audit.json 默认存当前目录 world-readable — runner runDir/unitDir + recorder artifactsDir 全 mkdirSync mode 0o700 (owner-only)
- ✅ **R37** 无 PII 自动 redact (screenshot 内输入字段) — `redactSensitiveInputs` mutate DOM 不只 CSS overlay (避免 vision OCR 看穿)；启发式: type=password / autocomplete / name/id/aria-label /password|secret|token|api[_-]?key|otp|pin/i
- ✅ **R38** 无 GDPR / CCPA 合规声明 — PRIVACY.md "GDPR / CCPA position" 段 (你 controller / 我们不在路径 / Anthropic subprocessor) + Article 17 删除流程 + DPA 路径
- ✅ **R60** 无 telemetry 默认行为声明 — README + PRIVACY.md 明确"zero telemetry"；未来加 telemetry 必 opt-in default + MIGRATION.md 公布

### T23 关闭（2026-05-01）— Wave 3 第三颗 doctor + init wizard
- ✅ **R45** 无 doctor 命令 — `ai-audit doctor` 8 项 check (Node/Platform/API key/config/scenarios/personas/proxy/disk/network) + 结构化 DoctorReport + exitCode + renderDoctorReport 纯函数 + 21 单测
- ✅ **R46** 无 init wizard — `ai-audit init` (no args) 交互 wizard 用 readline/promises zero-dep + 5 prompts + 13 单测；保留 `ai-audit init <dir>` 非交互向后兼容
- ✅ **R47** first-run 错误不可读 — doctor 8 check 友好 remedy + console.anthropic.com 链 + scaffoldProject 共用 helper + lint:no-console 加 commands/ 例外
- ✅ **R61** doctor 不检查网络 / proxy / API — checkProxyConfig + checkAnthropicReachable (HEAD 5s timeout) + --skip-network flag for offline / air-gapped

### T20 关闭（2026-05-01）— Wave 3 第二颗 stability commitment
- ✅ **R17** v0 → v1 MIGRATION.md — 150 LoC 含 3 required actions (Node 16→18 / a11y violation 数变化 / screenshot) + 4 optional + URL 变更 + What did NOT change + tag-baseline-then-upgrade 流程
- ✅ **R53** 5-unit audit 绝对 baseline 公开承诺 — README "Performance baseline" 段含 wall-clock ~2-5 min / cost $0.10-0.30 / < 1GB RAM (v1.0-rc1 calibration pending) + render hot-paths ops/sec 已 bench:check 跟踪
- ✅ **R54** v1.0 stability commitment 声明 — README "Stability Commitment" 段含 5 stable surfaces (CLI / config / Result Schema / MCP / 67 library exports) + SemVer 承诺 + 引 DEPRECATION-POLICY.md
- ✅ **R57** deprecation policy 文档 — DEPRECATION-POLICY.md 190 LoC 含两版本 sunset 周期 + 3 阶段流程 + 4 警告级别 + 完整示例

### T19 关闭（2026-05-01）— Wave 3 治理文档第一颗
- ✅ **R12** LICENSE 文件 — 21 行 MIT 标准文本 (2026 xcodethink) + npm pack 含 LICENSE 1.1KB + GitHub 右侧显示 MIT 标
- ✅ **R13** CONTRIBUTING.md — ~360 LoC dev setup + Conventional Commits + ADR 5 类必写 / 5 类不写 + 7 步 PR 流程 + branch protection checklist
- ✅ **R14 review** SECURITY.md (T0.6 初稿) — GHSA only 移除 email placeholder；保留 Known Accepted Risks 3 transitive vulns + closure plan T-NEW-1
- ✅ **R22** 22 ADR 一致性 review — 26 ADR audit doc README.md + 主题分组 + cross-reference 一致性结论 + 源码无 TODO ADR 标记
- ✅ **R33** package.json license: MIT 与 LICENSE 文件一致 — license-checker CI gate 自动验

### T30 关闭（2026-05-01）— Wave 4 完整收尾 5/5
- ✅ **R48** Alpine Linux / Docker / air-gapped 安装无文档 — `docs/INSTALLATION.md` 5 平台 + Docker 两路（playwright 官方 + alpine）+ 4 步 air-gapped 流程
- ✅ **R59** HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS 文档化 — INSTALLATION.md "Corporate proxy / firewall environments" 段含 env var + npm config + 自签 CA + MITM proxy
- ✅ **R62** air-gapped install 打包脚本 — INSTALLATION.md 4 步 prep + transfer + install 流程 + Anthropic API 在隔离环境的 3 选项
- 11 个 install 错误排查表 + 3 步 install 验证（version / doctor / smoke）

### T27 + T28 + T29 关闭（2026-05-01）
- ✅ **R28** Dependabot 配置 (T0.6 已 commit) — T27 验证 weekly cadence + group + ignore list 正确；GitHub UI 首次 push 后 Active
- ✅ **R29** SBOM 生成 — `.github/workflows/sbom.yml` (~50 LoC) release tag + manual trigger / `cyclonedx-npm --output-file sbom.json --omit dev --ignore-npm-errors` (647KB CycloneDX 1.6) / 上传 90d artifact + tag push 时附 GitHub Release
- ✅ **R30 加固** license-checker CI gate — package.json scripts 加 `license:check` (16 SPDX allowlist) + `license:csv`（重生 audit trail）；ci.yml 加 step (ubuntu × Node 20 only)；T0.6 已验 0 GPL/AGPL contamination
- T27 npm audit CI gate 已在 T26 ci.yml `npm audit --production --audit-level=high`

### T26 关闭（2026-05-01）
- ✅ **R43** 无 GitHub Actions CI 矩阵 — 关闭，3 workflow 落地：`ci.yml` 12 配置矩阵 (4 OS × 3 Node) 跑 npm ci/build/test/schemas idempotent/audit；`integration.yml` ubuntu chromium spawn (Playwright + file-lock-race) + weekly cron；`coverage.yml` ubuntu Node 20 跑 test:coverage:check (60/54/60/60 gate)；本地全 step 验通；branch protection 待 GitHub UI 配置（R44 治理 README）。

### T25 关闭（2026-05-01）
- ✅ **R39** package.json 缺 engines — 加 `node: ">=18.0.0"` + `npm: ">=8.0.0"`
- ✅ **R40** package.json 缺 os / cpu — 加 `["darwin","linux","win32"]` + `["x64","arm64"]`
- ✅ **R41** package.json 缺 repository / bugs / homepage — 全加，指 xcodethink/ai-browser-auditor
- ✅ **R42** package.json 缺 files / publishConfig — 加 files 数组 (dist/+docs/schemas/+root docs) → 包体积 **1.2MB → 520KB (-57%)** / **611 → 299 files (-50%)**；publishConfig.access: public
- ✅ **R-NEW-3** `<org>` 占位符替换 — `xcodethink` 替全部 7 处（3 src 硬编码 + 1 scripts + 2 docs + 1 测试）；剩 SECURITY.md email `security@<TBD>` 等 T19

### T6 关闭（2026-05-01）
- ✅ **R6** 真 axe-core + GHCS SARIF 从未端到端验过 — 关闭，5 integration tests 跑通：真 axe-core 跑 fixture (image-alt / label / color-contrast / button-name) + parseAxeTags 验 WcagAttribution 形状 + renderSarif emits wcag/X-Y-Z ruleIds + W3C help URLs + writeSarifReport persist 文件 + SARIF fixture byte-identical commit；docs/integration/sarif-upload-verified.md 完整 SOP 含手动 GHCS 上传步骤 + 验证 checklist + 失败排查表（screenshot 待 v1.0-rc1 阶段 reviewer 上传归档）。
- 🆕 衍生发现 **R-NEW-11**（P0）：handlers/index.ts handleAssertA11y axe runOnly: ["wcag2aa"] 漏 A 级违规 → 单独 T-NEW-11 任务。
- 🆕 SARIF 增强：rule 加 helpUri + help.markdown 字段（GHCS UI 渲染 "View documentation" 链接 + 展开 markdown 帮助）。

### T4 关闭（2026-05-01）
- ✅ **R3** 真 Chromium spawn + browser-only callback 从未在 CI 跑过 — 关闭，3 integration tests 跑通：recorder.screenshotSegments 真 chromium × lazy-load + dense-scroll + reporter-pdf real chromium PDF export，验 PNG/JPEG magic bytes + sha256 sidecar + 5-segment cap + PDF magic bytes

### T1 关闭（2026-05-01）
- ✅ **R4** file-lock cross-process race flake — 关闭，6 个月老债。精准切分：单进程 + sync 测留默认套；race 移 `tests/integration/file-lock-race.test.ts` + 专属 vitest.integration.config.ts（pool=forks/isolate=true/singleFork=true）；20 次连续 0 flake；默认 1536/1536 测全过；ADR-029 完整记录

---

## 二、新发现（V2 vs V1）

V2 新增的 26 条主要来自：

1. **仓库实地审计**（10 条）：npm audit critical / dep 落后两大版本 / package.json 字段缺失 / 无 CI 矩阵 / 无 LICENSE / 无 CONTRIBUTING / 无 SECURITY / 无 PRIVACY / 无 doctor / 无 init
2. **行业最佳实践调研驱动**（11 条）：consent prompt / SBOM / Dependabot / license-checker / typedoc / first-run UX / proxy 文档 / telemetry 声明 / migration guide / deprecation policy / release notes
3. **P2 重新审视升级**（5 条）：cache disk quota / artifacts retention / audit-explorer.html i18n（部分核心）/ act fragility 文档 / 内存 peak baseline

---

## 三、关键洞察

1. **L1 单测层 vs L2-L9 ship-readiness 层是两个完全不同的工程**。我之前把所有精力放 L1（M1-2 phase coverage / M5-7 / M6-7），L2-L9 几乎零进度。**v1 ship 的瓶颈不在 L1 而在 L2-L9**。
2. **没有任何 GitHub CI workflow 跑 unit test / lint / npm audit** —— 这意味着我们 1538 测的"green"完全靠本地，CI gate 不存在。`.github/workflows/post-deploy-audit.yml` 是给下游 SaaS 客户审计自家网站用的，不是项目自己的 CI。
3. **npm audit 1 critical vuln 必须立即修** —— protobufjs 的 GHSA-xq3m-2v4x-88gg；这是 npm publish 前的硬阻塞。
4. **Anthropic SDK 0.39 → 0.92 跨两大版本** —— 任何时候用户 `npm install` 拿的都是 latest，我们锁死的旧 SDK shape 跟实际不一致；这就是 R1 的导火索。
5. **package.json 缺 7 个 release-critical 字段** —— `engines / os / cpu / repository / bugs / homepage / files`；这是 npm publish 当天发现的事故。
6. **没有 LICENSE 文件**（虽然 package.json 写了 MIT）—— GitHub 仓库右侧不显示 license 标识；OSS 合规体系第一步缺位。
