# ADR-004: Worktree-isolated 开发 + Big Bang 切换

- **状态**：Accepted
- **日期**：2026-04-25
- **决策者**：Wayne
- **依赖**：[ADR-001](./ADR-001-AI-first-positioning.md)、[ADR-002](./ADR-002-primitive-first-architecture.md)

---

## Context

PixelCheck v0.3 已经作为 **MCP server 在 Wayne 的 Claude Code 配置里运行**：

```json
// ~/.claude.json
"ai-browser-auditor": {
  "type": "stdio",
  "command": "node",
  "args": ["<repo-root>/dist/mcp/server.js"]
}
```

这意味着：
- 多个 Claude Code 窗口正在调用 v0.3 的 MCP server
- 每个 stdio 会话启动一个独立的 server 进程，从 `dist/mcp/server.js` 加载
- 共享 SQLite 数据库（`~/.ai-browser-auditor/plan-cache.db` 和 `memory.db`）
- 共享浏览器进程（Playwright 自动隔离，问题较小）

v1.0 是架构重写（参考 ADR-002），开发期间会有大量"半成品状态"。如果直接在 main 分支开发：

- 改 src/ 不立即影响运行中的 server（已 load 进内存）
- **但 `npm run build` 会立即写入 `dist/`**，下一个新启动的 Claude 会话就拿到半成品
- 改数据库 schema 会让 v0.3 的 server 读到非预期数据 → 崩溃 / 数据损坏
- 改 result schema 会让 AI 的工程依赖断裂

这些副作用对 Wayne 的日常工作（其他 Claude 窗口正在用 PixelCheck 写代码）会**持续中断 6-12 个月**（v1 整体工时）。不可接受。

---

## Decision

**所有 v1.0 开发在独立 git worktree 进行，main 分支的 `dist/` 在切换前一字不动；4 phase 全部完成后 Big Bang 切换。**

### 物理隔离

```
~/Developer/ai-browser-auditor/                   ← main 分支（v0.3 production）
├─ dist/mcp/server.js                              ← 其他 Claude 窗口加载这个
├─ src/                                            ← v0.3 源码，本轮不动
└─ .claude/worktrees/
   └─ v1-ai-first/                                 ← v1 开发完全在这里
      ├─ src/                                       ← 改这里
      ├─ dist/                                       ← worktree 自己的 build 产物
      └─ ...
```

创建命令：
```bash
cd ~/Developer/ai-browser-auditor
git worktree add .claude/worktrees/v1-ai-first -b worktree-v1-ai-first
```

### 数据库路径分离

通过 env var 切换（代码已支持）：

```bash
# Worktree 启动 server / 跑测试时
export AUDIT_PLAN_CACHE_PATH=~/.ai-browser-auditor-v1/plan-cache.db
export AUDIT_MEMORY_PATH=~/.ai-browser-auditor-v1/memory.db
export AUDIT_REPORTS_DIR=~/.ai-browser-auditor-v1/reports
```

v0.3 server 使用默认路径（`~/.ai-browser-auditor/`），v1 worktree 使用 `~/.ai-browser-auditor-v1/`，互不干扰。

### Big Bang 切换协议

**前提**：4 phase 全部完成 + worktree 内全部测试通过 + manual smoke test 通过。

**步骤**：

```bash
# 1. 暂停所有正在用 ai-browser-auditor MCP 的 Claude Code 窗口
#    （Wayne 手动协调）

# 2. 备份现有 v0.3 数据
cp -R ~/.ai-browser-auditor ~/.ai-browser-auditor.v0.3.backup-$(date +%s)
cd ~/Developer/ai-browser-auditor
git tag v0.3-final-$(date +%Y%m%d)

# 3. v1 worktree 合并到 main
git checkout main
git merge worktree-v1-ai-first --no-ff -m "Merge v1.0 AI-first rewrite"

# 4. 重建 dist
npm install
npm run build

# 5. 跑 migration（v0.3 数据库结构 → v1 schema）
node dist/migrations/v0.3-to-v1.js

# 6. 跑切换后 smoke test
node dist/mcp/server.js  # 启动一次确认无致命错误
# Ctrl+C 关闭

# 7. 通知 Wayne 切换完成，恢复 Claude 窗口

# 8. 删除 worktree（保留 backup）
git worktree remove .claude/worktrees/v1-ai-first
```

### 回滚预案

如果 v1 上线后出致命问题（MCP server 启动失败 / 数据损坏 / 核心 primitive 崩溃）：

```bash
# 暂停所有 Claude 窗口
cd ~/Developer/ai-browser-auditor
git revert HEAD  # 撤销 merge commit
npm run build

# 恢复数据
mv ~/.ai-browser-auditor ~/.ai-browser-auditor.v1.broken-$(date +%s)
mv ~/.ai-browser-auditor.v0.3.backup-* ~/.ai-browser-auditor

# 恢复 Claude 窗口 → 回到 v0.3
```

回滚后：
- 在新 worktree 修复问题
- 修好后再次走 Big Bang 切换

---

## Consequences

### 正面

- v1 开发期间 Wayne 的其他 Claude 窗口**零中断**
- v0.3 → v1 切换是**确定性事件**（备份 + 测试 + 切换），不是"逐步降级"
- 数据库分路径 = v1 测试不污染 v0.3 数据
- Worktree 隔离 = git 历史清晰，方便 review 整体重写

### 负面

- 一次切换前的窗口期：v1 全部完成才能上线（~150-220 工日）。在此期间 Wayne 用不上 v1 新 primitives（只能在 worktree 里手动跑）
- 切换瞬间需要 Wayne 协调"暂停所有 Claude 窗口"（5-10 分钟操作窗口）
- 数据 migration 脚本必须在切换前充分测试（v0.3 → v1 数据格式不兼容时风险高）

### 中性

- 选项 A（每 phase 切换一次）虽然能更早用上新能力，但需要 4 次切换 / 4 次 migration / 4 次中断窗口 → Wayne 选择了 Big Bang（选项 B）
- 此 ADR 仅适用于 v0.3 → v1.0 的大重写。后续 v1.x 内的小升级回归正常滚动开发

---

## Alternatives Considered

### A. 每个 Phase 完成后切换一次（滚动升级）

**不选**。4 次中断窗口，每次都要数据 migration，错峰协调成本高。Wayne 选择 Big Bang。

### B. 直接在 main 开发，靠 feature flag 切换

**不选**。Feature flag 在 dist 已 load 进内存的 server 里效果有限，且代码会同时存在 v0.3 + v1 两套抽象，污染严重。

### C. 把 v1 做成新 npm 包（`ai-browser-auditor-v2`）

**不选**。两套 MCP server 同时存在 + Wayne 手动维护两份配置，比 worktree 更复杂。

### D. 暂停 Wayne 的所有 Claude 工作直到 v1 完成

**不选**。Wayne 仍要用其他项目（sibling projects），其他 Claude 窗口需要 PixelCheck 服务。

---

## Implementation Checklist

执行 v1 开发前，以下事项必须完成（在本 ADR commit 之后）：

- [ ] 创建 worktree：`git worktree add .claude/worktrees/v1-ai-first -b worktree-v1-ai-first`
- [ ] 在 worktree 内创建 `.env.development` 含 `AUDIT_*_PATH` 指向 `~/.ai-browser-auditor-v1/`
- [ ] 创建数据目录：`mkdir -p ~/.ai-browser-auditor-v1/`
- [ ] 第一次 worktree 内 `npm install && npm run build` 验证基线能跑
- [ ] STATUS.md 标注"开发位置：worktree v1-ai-first"

每个执行对话开始前必须确认：**当前 cwd 是 worktree 而不是 main**。

---

## References

- ADR-001：[AI-first 定位](./ADR-001-AI-first-positioning.md)
- ADR-002：[Primitive-first 架构](./ADR-002-primitive-first-architecture.md)
- 主方案 v3.0 第 6 部分：[Worktree 隔离开发协议](../../../project-internal planning)
- 现有 worktree 模式参考：`.claude/worktrees/v0.3-upgrade/`（已存在）
