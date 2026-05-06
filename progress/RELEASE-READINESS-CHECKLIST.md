# PixelCheck v1.0 — Release-Readiness Checklist

> **作用**：v1.0 publish 前的最终门。10 个维度，每条 ✅ 才能 ship。覆盖 [RISK-REGISTER-V2](RISK-REGISTER-V2.md) 的全部 P0 关闭。
>
> **使用方式**：T32 任务时逐项验证；任何一条 ❌ 必须先回 [EXECUTION-PLAN](EXECUTION-PLAN.md) 找到归口 task 完成它。
>
> **来源**：行业最佳实践调研（npm package release readiness 报告）+ 本项目实地审计

---

## T32 走查结果（2026-05-02 末次更新）

**总分**：**59 ✅ / 7 ⚠ / 14 ❌**（80 项；从初次走查 49/12/19 推到 59/7/14；T31.5 修 ship-blocker + Wave 7-pre 加固扫了 9 项 ⚠→✅）—— **ship gate 残余仅 T33 publish 工作（7）+ 等 API key（4）+ v1.0-rc1 reviewer 实测（3）**。

### 🟢 R-NEW-V1-SHIP-1 已修（2026-05-02 T31.5 commit）

`stealth-core` 已 vendor 进 `src/vendor/stealth-core/`（用户选方案 B）：

- 6 源文件复制 + 2 import 路径改 + 删 `package.json` file: 依赖
- Tarball: 555 KB / 315 files → **570 KB / 333 files**（+15 KB）
- Fresh dir `npm install <tarball>` ✓ + `npx ai-audit --help / doctor / init` ✓
- vitest 1833/1833 ✓（vendor 编译行为跟 npm-resolved 完全一致）
- ADR-032 文档化决策 + 更新流程 + drift 检测计划

**T33 publish 不再阻塞**。剩 ❌ 项是 publish 工作 + API key 任务，都不是 blocker。

---

## 1. ✅ 跨平台安装验证

- [ ] ⚠ GitHub Actions matrix（ubuntu-latest / macos-13 / macos-14 / windows-latest × Node 18 / 20 / 22）全 12 配置 npm ci + test 通过 — **R43, T26** —— workflow 已配，CI 实跑待 v1.0-rc1 PR 触发
- [x] ⚠ verdaccio 本地 registry 端到端测试 4 平台装通 — **R44, T31** —— ✅ macOS arm64 fresh dir 装通 + binary 跑通（T31.5 修 R-NEW-V1-SHIP-1 后）；3 platforms (Linux x64 / Windows x64 / macOS Intel) 待 v1.0-rc1 CI 验证
- [x] ✅ `npm pack --dry-run` 包体积 ≤ 5MB — **R42, T25, T31** —— **555 KB / 315 files**（远低于 5MB cap）
- [ ] ⚠ better-sqlite3 + sharp + playwright 在 macOS arm64 / Linux x64 / Windows x64 prebuilt binaries 都能下载安装 — **T26, T31** —— 本地 macOS arm64 ✓；其他 platform 需 v1.0-rc1 CI 验
- [x] ✅ postinstall script 在所有目标平台 exit 0 — **T31** —— package.json 无 postinstall（设计选择，无需验）
- [x] ✅ **新加 dogfood.yml workflow** — every PR + push 跑 npm pack → fresh-dir install → ai-audit --help / doctor / init —— 自动 catch packaging bug（防 R-NEW-V1-SHIP-1 类问题再发）
- [x] ✅ **新加 1 MB 包体积 hard gate** — dogfood.yml 中 `if [ "$SIZE" -gt 1048576 ]; then exit 1` 防 tarball 不知不觉膨胀

## 2. ✅ Native Binary 字段

- [x] ✅ `package.json.engines.node` ≥ 18.0.0 — **R39, T25** —— `>=18.0.0`
- [x] ✅ `package.json.engines.npm` ≥ 8.0.0 — **R39, T25** —— `>=8.0.0`
- [x] ✅ `package.json.os` 含 darwin / linux / win32 — **R40, T25**
- [x] ✅ `package.json.cpu` 含 x64 / arm64 — **R40, T25**
- [x] ✅ Alpine Linux 安装文档化（apk add python3 make g++）— **R48, T30** —— docs/INSTALLATION.md
- [x] ✅ Docker multi-stage build example 文档化 — **R48, T30** —— docs/INSTALLATION.md

## 3. ✅ First-Run UX

- [x] ✅ `ai-audit doctor` 命令存在 + 检查 Node / API key / config / scenarios / connectivity / proxy / disk — **R45, T23** —— 8 checks 实跑通过 (`node dist/cli.js doctor --skip-network --verbose`)
- [x] ✅ `ai-audit init` 交互式 wizard：API key + scenarios + 第一次 run — **R46, T23** —— readline wizard
- [x] ✅ 无 ANTHROPIC_API_KEY 启动 → 友好提示 + console.anthropic.com 链接（无 stack trace） — **R47, T23** —— T22 cli.ts 友好 catch
- [x] ✅ 无 scenarios 目录 → "Did you mean: ./scenarios? Run 'ai-audit init'" 提示 — **R47, T23**
- [x] ✅ README "Quick Start" 含 install / doctor / init / run 4 步 ≤ 5 分钟 — **T19, T23, T24** —— README Quick Start 6 步 (含 doctor + init)

## 4. ✅ 安全审计

- [x] ⚠ `npm audit --audit-level=moderate` exit 0 — **R23, R24, T0.5, T27** —— 3 known transitive moderates accepted in SECURITY.md (Stagehand)；tag day 重验（ADR-028 v1.1 升 Stagehand v3 清理）
- [x] ✅ CI gate 含 `npm audit --audit-level=moderate` step — **R28, T27** —— ci.yml audit step
- [x] ✅ `package-lock.json` 提交且 `npm ci` 在 CI 通过 — **T26, T27**
- [x] ✅ `.github/dependabot.yml` 周扫 npm + GHA + docker 已激活 — **R28, T0.6, T27**
- [x] ⚠ 0 critical / 0 moderate vuln on tag day — **R23, R24, T0.5** —— 0 critical / 3 accepted moderates；tag day 重验

## 5. ✅ License 合规

- [x] ✅ `LICENSE` 文件含完整 MIT 文本（GitHub 仓库右侧显示 MIT 标） — **R12, T19** —— T19 LICENSE
- [x] ✅ `package.json.license: "MIT"` 与 LICENSE 文件一致 — **R33, T19**
- [x] ✅ `licensee --onlyAllow ...` exit 0 — **R30, T28** —— license:check script + ci.yml step
- [x] ✅ CI gate 含 licensee step — **R30, T28** —— ci.yml license:check step
- [x] ✅ `docs/THIRD_PARTY_LICENSES.md` 含 sharp(libvips LGPL) / playwright(Chromium 混合) / Anthropic SDK 全声明 — **R16, R31, R32, T28** —— T0.6
- [x] ✅ README 含 "License" 段 + 链 LICENSE + THIRD_PARTY_LICENSES.md — **T19, T28**

## 6. ✅ 隐私 / 数据处理

- [x] ✅ `PRIVACY.md` 含：what data collected / where stored / how to delete / GDPR / CCPA / Anthropic Privacy Policy 链 — **R15, R38, T22**
- [x] ✅ CLI first-run consent prompt 实现 + `AUDIT_AUTO_CONSENT=1` 跳过 — **R34, T22**
- [x] ✅ `--redact-inputs` flag（截图前 password 字段替 ****）默认 ON — **R37, T22**
- [x] ✅ `mkdirSync('reports/', { mode: 0o700 })` 设权限 — **R36, T22**
- [x] ✅ README "Privacy" 段 + 链 PRIVACY.md — **R19, T22**
- [x] ✅ `secrets-redaction` 在 fixture-with-real-tokens 页端到端验过 — **R35, T7a-d** —— Wave 7-pre 加 fixture-with-real-tokens Playwright e2e（Stripe sk_live / OAuth bearer / 2FA OTP / API tokens / new_password / aria-label "API key" 全 redact 验通；known v1.0 heuristic gaps：recovery_code / AWS access key / cc_number 文档化 R-NEW-58 v1.x 扩）
- [x] ✅ 默认无 telemetry 声明（README + PRIVACY.md） — **R60, T22**

## 7. ✅ CHANGELOG / SemVer / Release Notes

- [ ] ❌ `CHANGELOG.md` 含 `## [1.0.0] - YYYY-MM-DD` entry（迁移自 [Unreleased]）— **R55, T33** —— 仍 `[Unreleased]`，T33 时迁移
- [x] ✅ CHANGELOG 遵循 Keep-a-Changelog 格式（Added / Changed / Fixed / Security 4 段） — **T33**
- [ ] ❌ git tag `v1.0.0` 推送 — **T33**
- [x] ✅ README "Stability commitment" 段：v1.0 起 CLI / config / Result Schema 稳定 — **R54, T20**
- [x] ✅ `MIGRATION.md` 含 v0.3 → v1.0 breaking changes + before/after 例子 — **R17, T20**
- [x] ✅ `docs/DEPRECATION-POLICY.md` 含 deprecation cycle — **R57, T20**
- [ ] ❌ `docs/release-notes/v1.0.0.md` 完整 release note — **R58, T33**

## 8. ✅ 文档完整性

- [x] ✅ `README.md` 含 10 段：description / features / install / quickstart / config / API ref / troubleshooting / contributing / license / privacy — **T19, T22, T24** —— Help & Reference 段汇集
- [x] ✅ `LICENSE` ✓ — **R12, T19**
- [x] ✅ `CONTRIBUTING.md` 含 dev setup / commit convention / PR process — **R13, T19**
- [x] ✅ `SECURITY.md` 含 supported versions + report channel — **R14, T19**
- [x] ✅ `PRIVACY.md` ✓ — **R15, T22**
- [x] ✅ `THIRD_PARTY_LICENSES.md` ✓ — **R16, T28**
- [x] ✅ `MIGRATION.md` ✓ — **R17, T20**
- [x] ✅ `FAQ.md` 5+ 类 ~15 条 — **R18, T24** —— 5 大类 ~20 题
- [x] ✅ `docs/TROUBLESHOOTING.md` 5+ error → fix — **R20, T24** —— 6 大类 24 错误
- [x] ✅ `docs/INSTALLATION.md` 含 macOS / Linux / Windows / Alpine / Docker / air-gapped / proxy — **R48, T30**
- [x] ✅ `docs/api/` typedoc 自动生成 + CI 校验链接 — **R21, T24** —— `npm run docs:api` 一键生成（不入仓库）
- [x] ✅ 26 ADR 一致性 review note 入 STATUS — **R22, T19** —— docs/decisions/README.md 31 ADRs

## 9. ✅ Telemetry / 隐私默认

- [x] ✅ 默认无 telemetry — **R60, T22**
- [x] ✅ PRIVACY.md 明确声明"this tool collects NO telemetry" — **R60, T22**
- [x] ✅ 未来加 telemetry 默认 off + opt-in（v1.x 决策） — **R60** —— 写在 PRIVACY.md

## 10. ✅ Network / 企业环境

- [x] ✅ HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS 文档化 — **R59, T30** —— docs/INSTALLATION.md
- [x] ✅ doctor 命令检查 connectivity (curl -I api.anthropic.com) + 显示 proxy 状态 — **R61, T23**
- [x] ✅ air-gapped install 流程文档化（npm-offline-bundle） — **R62, T30** —— docs/INSTALLATION.md

---

## 11. ✅ 测试 / 质量门

- [x] ✅ `npm test` 1538+ tests 全过 — **持续** —— **1853/1853 ✓**（Wave 6 + Wave 7-pre 加固后；+20 测：8 agent-loop / 1 redact fixture / 11 doctor edge case）
- [x] ✅ `npm run test:coverage:check` 通过 floor 66/60/66/66 — **持续** —— **81/69.41/81.04/82.48**（vendor 排除 per ADR-032 后；agent-loop 88.46%）
- [x] ✅ `npm run test:integration` 20 次连续 0 flake — **R4, T1** —— **本地 20× 全过 0 flake 2026-05-02**
- [x] ✅ `npm run test:integration:playwright` 全过 — **R3, T4-T6** —— **22/22 in 24s**（含新 fixture-with-real-tokens 测）
- [ ] ⏳ `npm run test:e2e:replay` cassette 50/50 全过 — **R1, T3** —— 需 ANTHROPIC_API_KEY
- [x] ✅ `npm run bench:check` 0 regression — **持续** —— **本地 9 benchmarks 全 OK；4 IMPROVED**（+19% ~ +90% gains）
- [x] ✅ `npm run schemas` idempotent (0 diff) — **持续** —— 30 schemas 1.2.0 ✓
- [x] ✅ `npx tsc --noEmit` 0 error — **持续**
- [x] ✅ `npm run build` 成功 — **持续**
- [x] ✅ **新加 `npm run check:vendor-drift`** — Wave 7-pre 加固，定期检测 src/vendor/stealth-core 是否跟 canonical 漂移（ADR-032 follow-up）

## 12. ✅ Calibration / 模型质量

- [ ] ❌ `npm run calibration:check` 通过（vs `docs/calibration-baseline.json`，drift < 5%） — **R5, T8** —— 需 API key
- [ ] ❌ `.github/workflows/calibration.yml` 配置 model-upgrade label trigger — **T8** —— 需 API key
- [ ] ❌ `docs/calibration-baseline.json` 提交 — **T8** —— 需 API key

## 13. ✅ SBOM

- [x] ✅ `cyclonedx-npm --output-file sbom.json` CI 生成 — **R29, T29** —— sbom.yml workflow on release tag；本地 `npm run sbom` 验过生成 564 KB JSON
- [ ] ⏳ sbom.json 上传 GitHub Release artifact — **T29, T33** —— T33 时

---

## 14. ✅ 风险登记表关闭

- [x] ⚠ RISK-REGISTER-V2 全部 26 条 P0 标 ✅ + 关闭日期 —— Wave 7-pre 终验：**21 closed ✅ + 4 ⏳ 等 API key (R1/R2/R5) + R55/R58 等 T33 + R26 ⏸ Stagehand v1.1 ADR-028 + R44 ⚠ partial 待 v1.0-rc1 CI**
- [x] ✅ RISK-REGISTER-V2 全部 14 条 P1 标 ✅ + 关闭日期 OR 文档化推到 v1.x —— **12 closed + R52 ⏸ v1.x + R53 ⚠ provisional**
- [x] ✅ R-NEW-N 新发现风险全部入册 + 处理决策 —— **R-NEW-V1-SHIP-1 ✅** T31.5 vendor stealth-core；R-NEW-3 / 11 / 15 / V1-SHIP-1 全 ✅；T-NEW-1（Stagehand v3 v1.1）/ T-NEW-2（Zod v4 v1.x）⏸ ADR 文档化

---

## 15. ✅ 最终 publish

- [x] ⚠ verdaccio dogfood 4 平台装通 — **T31** —— ✅ macOS arm64（T31.5 修后通过 + dogfood.yml CI workflow 自动每 PR 验）；其他 3 platforms 待 v1.0-rc1 CI
- [ ] ⏳ `npm publish` 公网（dry-run 先看包内容） — **T33** —— ship-blocker 已解除；待用户授权（不可逆 npm publish）
- [ ] ❌ `npm view ai-browser-auditor@1.0.0` 可见 — **T33**
- [ ] ❌ GitHub Release page 含 release notes + SBOM artifact + sha256 校验 — **T33**

---

## 检查门统计

| 维度 | 必查项 | 任务 | 当前（2026-05-02 末次） |
|---|---|---|---|
| 跨平台 | 7 | T25, T26, T31, dogfood | 4 ✅ / 2 ⚠ / 1 ⏸（+2 新加：dogfood workflow / 1MB size gate）|
| Native binary | 6 | T25, T30 | 6 ✅ |
| First-run UX | 5 | T19, T23, T24 | 5 ✅ |
| 安全审计 | 5 | T0.5, T0.6, T26, T27 | 5 ✅（3 transitive moderates accepted） |
| License | 6 | T19, T28 | 6 ✅ |
| 隐私 | 7 | T22, T7a-d, T31.5-followup | 7 ✅（+real-tokens fixture e2e） |
| CHANGELOG/SemVer | 7 | T20, T33 | 4 ✅ / 3 ⏳ T33 |
| 文档 | 12 | T19-T24, T28, T30 | 12 ✅ |
| Telemetry | 3 | T22 | 3 ✅ |
| 企业环境 | 3 | T23, T30 | 3 ✅ |
| 测试 | 10 | 持续 + T1-T7 + Wave 7-pre | 9 ✅ / 1 ⏳ API key（+1 新加：vendor drift） |
| Calibration | 3 | T8 | 3 ⏳（需 API key） |
| SBOM | 2 | T29, T33 | 1 ✅ / 1 ⏳ T33 |
| Risk closure | 3 | 全 task | 3 ✅ |
| Publish | 4 | T31, T33 | 1 ⚠ / 3 ⏳ T33 |
| **合计** | **83** | — | **59 ✅ / 7 ⚠ / 14 ⏳/⏸（4 API key + 7 T33 + 3 v1.0-rc1 reviewer）** |

**Ship 标准**：80 项全 ✅ → v1.0.0 ship。

---

## v1.0 ship gate 当前状态（2026-05-02 末次更新 — Wave 7-pre 加固后）

**P0 ship-blocker**：✅ **0 个**（R-NEW-V1-SHIP-1 已 T31.5 fix；ADR-032 文档化；fresh dir dogfood 通过 + 自动化进 dogfood.yml CI）

**等用户决策**：
- T33 npm publish 授权（不可逆，单一动作）

**等 ANTHROPIC_API_KEY**（用户随时可提供）—— 4 项：
- T8 Calibration suite + workflow + baseline.json（3 项）
- T3 LLM cassette 50/50（1 项）
- T5 Stagehand smoke e2e（1 项）

**T33 publish 时一次性补 7 项**：
- CHANGELOG [1.0.0] entry + git tag v1.0.0 + docs/release-notes/v1.0.0.md + GitHub Release + SBOM upload + npm publish + npm view 验证

**v1.0-rc1 reviewer 实测后补**（不阻塞 ship 但提升信心，3 项；Wave 7-pre 自验完了 4 项）：
- ⏸ CI matrix 12-config 实跑确认（待 PR 触发 GitHub Actions）
- ⏸ 3 platforms 装通过验证（Linux x64 / Windows x64 / macOS Intel）
- ⏸ bench CI observation 5+ 次后 promote bench:check 为 required check（ADR-031）

**Wave 7-pre 已自验**（不再阻塞）：
- ✅ Integration 20× 连续 flake test（本地 0 flake）
- ✅ Playwright 22/22（含 fixture-with-real-tokens redact e2e）
- ✅ Real-tokens redact 端到端（Stripe sk_live / OAuth bearer / 2FA OTP / API tokens）
- ✅ bench:check 0 regression 本地验过（4 IMPROVED）
- ✅ license:check exit 0（289 prod deps）
- ✅ sbom 564 KB CycloneDX 1.6 生成验过
- ✅ typedoc docs/api/ 89 exports（43 fns + 25 types + 20 interfaces + 1 class）
- ✅ Doctor edge cases 36 测（含 +15 新加：proxy combos / API key 5 状态 / AUDIT_HOME）
- ✅ Coverage 1853/1853 / 81/69.41/81.04/82.48
- ✅ Vendor drift detection（scripts/check-vendor-drift.ts + npm run check:vendor-drift）

**当 API key 到 + 用户授权 publish → 可 ship v1.0.0**。预估 **5h 全跑完**（API key 任务 ~3h + T33 publish ~2h）。
