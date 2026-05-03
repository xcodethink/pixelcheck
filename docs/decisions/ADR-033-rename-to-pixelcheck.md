# ADR-033 — Rename to PixelCheck + reposition launch narrative as AI-first MCP infrastructure

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: W1 pre-ship-positioning-audit
- **Module**: project-internal optimization plan
- **Depends on**: ADR-001 (AI-first 产品定位), ADR-002 (Primitive-first 架构)
- **Supersedes**: package name `ai-browser-auditor` and "AI Browser Auditor" branding in launch materials

## Context

v1.0 ship 在即（0 P0 blocker / 1853 测试 / 570 KB tarball / dogfood install 通过）。Step 1 调研发现：

- `package.json` 仍叫 `ai-browser-auditor` + 副标题 "AI-driven post-deployment UX audit..."
- README H1 仍是 "AI Browser Auditor"，副标题 "Your AI-powered product experience reviewer"
- 三份 launch 文案（`launch-post.md` / `launch-post-zh.md` / `show-hn.md`）100% 旧"UX audit"叙事
- README body 已含 25 处 MCP + 14 处 primitive 提及，但被旧 H1 框死
- ADR-001 (2026-04-25) 决议产品重新定位为 "AI 用来与可视化网络世界交互的通用基础设施"，主接口 MCP server，99% 调用来自 AI agent
- ADR-002 (2026-04-25) 决议 audit 是 primitive 的预设组合，**不是产品核心**

矛盾：战略文档（ADR-001/002）已经选定 "PixelCheck + AI-first MCP infrastructure"，但外部品牌资产（npm name + README）仍按 v0.x "AI Browser Auditor + UX audit" 写。npm publish 在即，错过对齐时刻 = 用错故事进入市场，且 npm 包名 publish 后改名极痛。

## Research Summary

调研要点：

- 行业景观（2026-Q2）：MCP 已捐 Linux Foundation / AAIF / OAuth 2.1 preview / MCP Dev Summit 1200 人 / 反 vendor lock-in 主流共识（OpenCode 120k stars 验证）
- 直接竞品：browser-use 91k stars（执行 SoTA）/ Skyvern 21k+（表单专项）/ Stagehand v3（44% 加速）/ Baymard UX-Ray 2.0（仅 ecommerce）
- 我们的差异化窗口：MCP-first × 5 primitives × multi-persona × multi-locale × WCAG × 历史趋势的组合在 OSS 空间无人占位
- 名字可用性：`pixelcheck` 在 npm 和 brew 上均空着（5 月 1 日 npm view 验证）；GitHub username `pixelcheck` 已被占（个人账号），repo 继续用现有 `xcodethink/pixelcheck`，跟 facebook/react、microsoft/typescript 同模式（org name ≠ product name）

## Impact Analysis

| 类别 | 文件 / 范围 | 改动量 |
|---|---|---|
| 元数据 | `package.json` (name + description + keywords + bin entries) | ~12 行 |
| README 头部 | `README.md` H1 + tagline + 第 1 段 + 跨 body grep "auditor" | ~80 行 |
| Launch 三套 | `docs/launch-post.md` + `docs/launch-post-zh.md` + `docs/show-hn.md` | 三份完整重写 |
| CHANGELOG | `CHANGELOG.md` v1.0.0 entry 加 "Renamed + Repositioned" 段 | ~25 行 |
| MIGRATION | `MIGRATION.md` 加 v0.x → v1.0 命令对照表 | ~50 行 |
| 新 ADR | `docs/decisions/ADR-033-rename-to-pixelcheck.md`（本文件） | ~150 行 |
| CLI bins | `package.json` `bin` + 公共 API 名字快照（67 → 67 数量不变，bin 名变） | 跨文件 |
| 源代码 ai-audit 字符串 | grep "ai-audit"/"ai_audit"/"ai-browser-auditor"/"AI Browser Auditor" 全清 | 跨文件 |
| 旧文案归档 | `docs/archive/v0.x-launch/` 保留 v0.x 历史 | 3 文件移动 |

**触发硬刹车**（CLAUDE.md + v1.x 优化方案 §5.4）：
- ✅ 修改 5+ 既有文件（非纯新增）
- ✅ 修改公共 API 名字快照（bin name 改）
- ✅ 修改 package.json `name` 字段
- ✅ 触发 npm publish 不可逆操作的前置

**用户已 yes**（2026-05-01 对话）：Q1=A / Q2=自决 / Q3=同意立即执行。

## Decision

**重命名 `ai-browser-auditor` → `pixelcheck`，重写所有外部品牌资产以对齐 ADR-001 AI-first 定位。**

具体执行：

1. **包名**：`package.json` `name` 改 `pixelcheck`
2. **描述**：`description` 改 "MCP-first browser primitives for AI agents — real eyes and hands on the web. Local-first. Vendor-agnostic. Yours to own."
3. **关键字**：`keywords` 加 `mcp` / `mcp-server` / `ai-agent` / `primitive` / `vendor-agnostic` / `local-first`，去 `e2e`（避免被误识为 E2E 测试工具）
4. **Bin**：`ai-audit` → `pixelcheck`，`ai-audit-mcp` → `pixelcheck-mcp`
5. **README H1**：`AI Browser Auditor` → `PixelCheck`
6. **README tagline**：改为 "MCP server giving AI agents real eyes and hands on the web. Vendor-agnostic. Local-first. Yours to own."
7. **README body**：grep 全文 "auditor" / "AI Browser Auditor" 出现处全部按上下文调整（保留 "audit" 作为 primitive 预设组合的功能名 OK，但不再作为产品核心叙事）
8. **三份 launch 文案**：完整重写为 "AI-first MCP infrastructure" 主叙事，强调 5 primitives + MCP-first + 反 vendor lock-in + multi-persona/multi-locale 差异化
9. **CHANGELOG v1.0.0 entry**：新增 "Renamed to PixelCheck" 段 + "Repositioned as AI-first MCP infrastructure" 段
10. **MIGRATION.md**：增 v0.x → v1.0 命令对照表（`ai-audit run` → `pixelcheck run` 等）
11. **公共 API 名字快照**：bin 名变化重新生成 snapshot
12. **旧文案归档**：原三份 launch 文案移动到 `docs/archive/v0.x-launch/`，留作 v0.x 历史参考

## Alternatives Considered

### Option B（已放弃）：保留 `ai-browser-auditor` 名字，仅升级 launch 叙事
- 优势：工程量小（半天），不动 bin / 公共 API

### Option C（已放弃）：现状 publish，后续再调整
- 优势：当下零工程量
- 放弃理由：launch 一次性窗口浪费；与 ADR-001/002 完全不一致，意味着 ADR 体系失效；后续重命名 npm 包成本极高；违反 CLAUDE.md "一次做到位" 铁律

### GitHub org 选项
- **保留 `xcodethink` org，repo 改名 `pixelcheck`**：选用。pragmatic，不引入额外操作。GitHub repo rename 自带 redirect，外部链接不破。
- 备选 `pixelchecksh` / `pixelcheckhq` / `getpixelcheck` 新 org：未选。需要用户手动建 org + 迁 repo + 重新设置 secrets / actions / dependabot，工程量增加，对 v1.0 ship gate 不增价值。

## Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| README body 与新 H1 协调一致性 | 重写后全文 grep "auditor"，按上下文判断保留 / 替换 |
| 67 个公共 API 名字快照失效 | 重新生成快照（`tests/api-snapshots/`）；CI 自动比对 |
| MIGRATION 写不清，v0.x 用户被困 | 逐项写 `ai-audit X` → `pixelcheck X` 命令对照 + 1-line `ln -s` workaround 给坚持用旧 bin 名的用户 |
| 已写好的 launch 文案被弃用浪费 | 旧文案归档到 `docs/archive/v0.x-launch/` 留作 v0.x 历史参考 |
| 全量回归暴露未发现的 ai-audit 字符串遗漏 | grep 全仓库 + 显式打印未替换处供人工 review |
| GitHub `pixelcheck` username 占用引发误访问 | README 顶部 + ADR-033 明文 "GitHub: github.com/xcodethink/pixelcheck"；所有官方链接固定 |
| Schema published JSON 引用旧名 | grep `docs/schemas/` 已发布 30 schema，按需调整 `$id` 字段（向后兼容：旧 `$id` 保留 alias） |

## Rollback Plan

- **publish 前**（即本 ADR 执行期间）：所有改动可 git revert；包名 `pixelcheck` 没 publish 不会留痕；worktree 保护机制（ADR-004）保证 main 不动
- **publish 后**：极痛，必须避免在该决策不稳的情况下 publish；本 ADR 完成所有改动 + 全量回归通过 + dogfood install 通过 **才进入 publish gate**

具体回滚命令：
```bash
# Worktree 内
cd <repo-root>/.claude/worktrees/v1-ai-first
git log --oneline -10  # 找到本 ADR 第一个 commit 之前的 SHA
git revert <ADR-033-first-commit>^..HEAD --no-commit
git commit -m "revert: roll back ADR-033 PixelCheck rename"
npm run build && npm test
```

## Test Plan

- typecheck（`tsc --noEmit`）
- build（`npm run build`）
- 全量单测（`npm test`）：1853 → 1853（数字不变；mock 中的 bin 名要更新）
- benchmark check（`npm run bench:check`）：0 regression
- 公共 API 名字快照（`tests/api-snapshots/*`）：bin 字段更新；其他 67 unchanged
- Schemas idempotent check：30 schema diff = 0（除非 `$id` 字段变）
- lint:no-console
- npm pack：tarball < 1 MB hard gate
- Fresh-dir dogfood install（参考 T31 流程）：
  ```bash
  npm pack
  cd /tmp/pixelcheck-dogfood-$(date +%s) && mkdir -p $(pwd) && cd $_
  npm install <repo-root>/.claude/worktrees/v1-ai-first/pixelcheck-1.0.0.tgz
  npx pixelcheck --help
  npx pixelcheck doctor --skip-network --verbose
  npx pixelcheck init test-project
  ```
- MCP server self-describe：`pixelcheck-mcp` 启动 + `list_capabilities` 返回 17 工具

## DoD（对照 v3.0 §9.4 + 模块特定）

- [ ] ADR-033 状态 Accepted
- [ ] `package.json` name + description + keywords + bin entries 改完
- [ ] README H1 + tagline + body grep "auditor" 全清（除指 audit primitive 预设组合的功能上下文）
- [ ] 三份 launch 文案（`launch-post.md` / `launch-post-zh.md` / `show-hn.md`）重写
- [ ] CHANGELOG v1.0.0 entry 加 "Renamed + Repositioned" 段
- [ ] MIGRATION.md 加 v0.x → v1.0 命令对照表
- [ ] CLI bin `pixelcheck --help` 跑通（lint:no-console + smoke test）
- [ ] MCP server `pixelcheck-mcp` 跑通 + 17 tools self-describe
- [ ] 公共 API 名字快照重生（67 → 67 数量不变，bin 名条目更新）
- [ ] `npm pack` 包大小 < 1 MB
- [ ] Fresh dir dogfood install 通
- [ ] 全量回归（typecheck / build / test / bench / 0 schemas diff）
- [ ] 旧文案归档到 `docs/archive/v0.x-launch/`
- [ ] progress/STATUS.md 已更新

## Out of Scope

本 ADR **不**处理以下事项（属于 publish gate / 用户操作 / 后续 wave）：
- npm publish 本身（用户决策 + 操作）
- GitHub repo 改名 `xcodethink/ai-browser-auditor` → `xcodethink/pixelcheck`（用户操作；GitHub 自动 redirect）
- 注册 modelcontextprotocol.io 公开 registry（属 Wave 2 W2-2）
- 多 AI client 兼容矩阵（Wave 2 W2-3）
- 多 LLM provider 抽象（Wave 2 W2-5）
