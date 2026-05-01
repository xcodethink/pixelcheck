# ADR-029 — File-lock cross-process race tests in dedicated forks-pool config（M9-3.2 收口）

- **Status**: Accepted
- **Date**: 2026-05-01
- **Task**: T1（Wave 1 baseline）
- **Closes**: RISK-REGISTER-V2 R4

## Context

`tests/file-lock.test.ts` 自 M9-3 ship 起 6 个月一直挂着一个已知 flake：
全套并行 vitest 跑下来 ~10-15% 失败率；单独跑 20/20 全过。每次任务收尾我都
在 STATUS / CHANGELOG 里标"与本次任务无关，M9-3.2 follow-up"——共 18 处。

**根因诊断**：

- 受影响的 2 个测试用例位于 `describe("withFileLock — cross-process race")` —— 它们 `spawn` 真 Node 子进程在共享 lockfile 上 race。
- vitest 4 默认 `pool: "threads"`：所有 test files 跑在一个 Node 进程的不同 worker thread 里，共享 OS-level 调度原语（特别是文件描述符 + 子进程组）。
- 当 sibling worker thread 也在 spawn 子进程（其他 integration test 例如 `agent-loop-e2e.test.ts` / `signals-e2e.test.ts`），这些子进程跟 file-lock-race 子进程互相抢资源 → race 测试的 lock acquire 偶发失败 → 测试期望"两个子进程总和 25×2=50 次成功"实际拿到 49 或更少。
- 这不是 file-lock 实现的 bug —— 是测试环境（vitest workers + child_process spawn）的 contention。

**确认根因**（行业最佳实践调研，2026-05-01 T1 调研子代理）：

- vitest 4+ 官方 migration 文档明确：`pool: "forks"` + `isolate: true` 是 child-process spawn 测试的标准模式。
- better-sqlite3 自家测试套用 `fileParallelism: false` + 单 fork 串行跑 file-lock 类测试。
- vitest GitHub issue #8766 记录：threads pool 下 child_process.spawn flaky 是已知设计 trade-off。

## Decision

精准切分：

- **`tests/file-lock.test.ts`**（保留默认 threads pool）：单进程 + sync 变体测试（lines 1-180 的 `describe("withFileLock — single process")` + `describe("withFileLockSync")`）—— 这些跑得快、从未 flake。
- **`tests/integration/file-lock-race.test.ts`**（新文件，forks pool）：跨进程 race 测试 2 个用例。
- **`vitest.integration.config.ts`**（新 config）：
  - `pool: "forks"` + `forks.isolate: true` + `forks.singleFork: true` + `fileParallelism: false`
  - `include: ["tests/integration/file-lock-race.test.ts"]`（精准指定，不扫整个 integration/，因为 agent-loop / signals e2e 在 threads pool 下也跑得稳定）
  - testTimeout 90s（child spawn + iteration 时间预算）
- **`vitest.config.ts`**：`exclude` 加 `tests/integration/file-lock-race.test.ts`（不影响其他 integration tests）
- **`package.json`**：加 `test:integration: vitest run --config vitest.integration.config.ts`
- 默认 `npm test` 1536/1536 测（少了 race 2 个）；`npm run test:integration` 单独跑 2/2 race 测。

## 验证标准

- [x] `npm run test:integration` 跑通 2/2 measured passed
- [x] **20 次连续 `npm run test:integration` 全过 0/20 fail**（M9-3.2 收口的根本验证）
- [x] 默认 `npm test` 1536/1536 测全过（含 agent-loop-e2e / signals-e2e 仍然在 threads pool 跑通）
- [x] 没有引入新依赖（vitest 内置功能）

## Alternatives rejected

1. **整个 `tests/file-lock.test.ts` 移到 integration/** —— 浪费：单进程 + sync 测试 175 LoC 跑得稳，搬走会让默认套覆盖率掉
2. **改成 `pool: "threads", singleThread: true`** —— singleThread 串行跑所有测试（不只 race），把整套 5s → 60s+，开发反馈循环受不了
3. **用 `vitest workspace`/`projects` config** —— vitest 4 支持 multi-project 但配置复杂；当前只 1 个文件需要 forks，单独 config 更简单
4. **强行 wrapper / mock spawnSync** —— 那就不是测试 cross-process race 了，等于删测试
5. **将 `agent-loop-e2e.test.ts` / `signals-e2e.test.ts` 也搬进 forks 套** —— 它们在 threads pool 下从未 flake；过度反应
6. **`fileParallelism: false` 全局** —— 把整套 npm test 串行化，开发体验暴跌
7. **接受 flake，加 vitest retry** —— retry 会把"已知 flake"变"被掩盖的 bug"，本质上是逃避；本次正面修了

## Consequences

- **6 个月老债关掉了**：18 处 STATUS"与本次无关"标记从此不再续命
- **测试体系信号更清晰**：默认 `npm test` 全绿信号 = 真全绿；新人开发不再被"偶发 fail，再跑一次就好"误导
- **CI gate 设计可以收紧**：T26 写 GitHub Actions 时可以要求 `npm test && npm run test:integration` 双绿不允许 retry
- **多 1 个 vitest config 文件**：`vitest.integration.config.ts` ~30 LoC，配 `vitest.config.ts` 双 config 模式；维护成本可接受
- **未来扩展**：`tests/integration/file-lock-race.test.ts` 是这个 config 的第一个 occupant；后续真 e2e 测试（如 M6-5 T5 Stagehand smoke）如果也碰到 fork-required 场景，可以加进同一 config 的 `include` 数组

## Files added / changed

- `vitest.integration.config.ts` — 新（~30 LoC）
- `tests/integration/file-lock-race.test.ts` — 新（~115 LoC，从原文件 line 181-293 完整迁移 + 加文档头）
- `tests/file-lock.test.ts` — 删 race 段（line 181-293）+ 删未用 `spawnSync` import + 加文档头说明分裂
- `vitest.config.ts` — exclude 加 `tests/integration/file-lock-race.test.ts`
- `package.json` — scripts 加 `test:integration`
