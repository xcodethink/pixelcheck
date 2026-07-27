# Autonomous Explorer + Live Observer: Acceptance Criteria

> Each phase must pass all acceptance tests before proceeding to the next.
> If any test fails, perform full root cause analysis before fixing (no trial-and-error).

---

## Phase 1: Event System Foundation

### 1.1 AgentEventBus (`src/agent/events.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P1-01 | EventBus emits typed events | `emitEvent("session:start", {...})` returns an `AgentEvent` with correct type, timestamp, session_id, auto-incrementing sequence | Unit test: create bus, emit 3 events, assert sequence = 0,1,2 |
| P1-02 | Wildcard listener receives all events | Listener on `"*"` receives every event regardless of type | Unit test: emit 5 different types, wildcard listener count = 5 |
| P1-03 | Specific type listener only receives its type | Listener on `"step:start"` does not receive `"step:complete"` | Unit test: emit both types, specific listener count = 1 |
| P1-04 | Pause/resume works correctly | `pause()` causes `waitIfPaused()` to block; `resume()` unblocks it | Unit test: pause, start waitIfPaused in background, resume after 100ms, measure elapsed |
| P1-05 | Takeover/release works correctly | `startTakeover()` causes `waitForTakeoverEnd()` to block; `endTakeover()` unblocks | Same pattern as P1-04 |
| P1-06 | checkpoint() handles both states | When both paused and takeover, checkpoint() resolves after both are cleared | Unit test: set both, clear in sequence, verify resolution |
| P1-07 | Console logger formats all event types | `attachConsoleLogger()` does not throw for any event type | Unit test: emit all AgentEventType values, no errors thrown |

### 1.2 DOM Summary Extractor (`src/agent/dom-summary.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P1-08 | Extracts interactive elements | Returns buttons, links, inputs with attributes | Integration test: load a test HTML page via Playwright, verify elements list |
| P1-09 | Respects maxElements limit | With maxElements=5, returns at most 5 elements | Integration test: page with 20 buttons, verify 5 returned |
| P1-10 | Skips hidden elements | Elements with `display:none` or zero dimensions excluded | Integration test: page with hidden buttons, verify excluded |
| P1-11 | Includes headings and text content | Returns h1/h2/h3 and visible paragraph text | Integration test: verify headings and textContent not empty |
| P1-12 | formatDomSummary produces readable string | Includes URL, title, elements in structured format | Unit test: call with mock DomSummary, verify format |
| P1-13 | Gracefully handles page errors | Returns fallback if page.evaluate fails (e.g., page closed) | Integration test: close page, then call, verify no throw |

### 1.3 Runner Integration

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P1-14 | Existing scripted runs emit step events | `step:start` and `step:complete` events emitted for each step | Run existing scenario with event listener, count events = 2 * step_count |
| P1-15 | Session lifecycle events emitted | `session:start` at run begin, `session:end` at run end | Run scenario, verify first and last events |
| P1-16 | Console logger output visible | Running with `--observe` flag shows colored event logs in terminal | Manual: `pixelcheck run --project my-app --headed`, verify colored output |
| P1-17 | Existing scenarios unaffected | All existing scripted scenarios produce identical results with/without event bus | Run same scenario twice, compare StepResult arrays |

---

## Phase 2: Live Observer MVP

### 2.1 Observer Server (`src/observer/server.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P2-01 | HTTP server starts on configured port | GET `/` returns 200 with HTML content | `curl http://localhost:3847/` returns HTML |
| P2-02 | Server binds to 127.0.0.1 only | Not accessible from external IPs | Attempt connection from another machine, verify refused |
| P2-03 | WebSocket connection established | Client connects to `/ws`, receives events | JS WebSocket client test script |
| P2-04 | Events broadcast to all WS clients | Multiple connected clients all receive each event | Connect 2 WS clients, emit event, both receive |
| P2-05 | Server graceful shutdown | `stop()` closes all connections and HTTP server | Start, connect client, stop, verify client disconnected |

### 2.2 CDP Screencast (`src/observer/screencast.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P2-06 | Screencast frames received | `startScreencast()` calls onFrame callback with base64 JPEG data | Integration test: navigate a page, verify >= 1 frame received |
| P2-07 | Frame quality/size controlled | Frames are JPEG, ~800x600, quality ~50 | Check frame buffer: verify JPEG header, decode and check dimensions |
| P2-08 | Stop cleans up CDP session | `stopScreencast()` succeeds without errors | Call stop, verify no dangling CDP sessions |
| P2-09 | Non-blocking execution | Screencast does not measurably slow step execution | Benchmark: run 10 steps with/without screencast, <5% overhead |

### 2.3 Web Dashboard (`src/observer/dashboard.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P2-10 | Dashboard renders three panels | Live feed (left), thought stream (right-top), action log (right-bottom) | Manual: open browser, verify layout |
| P2-11 | Live browser feed updates | JPEG frames from screencast display in real-time | Manual: navigate pages in headed mode, verify feed updates |
| P2-12 | Event stream scrolls | Plan/thought/action events appear with timestamps | Manual: run scenario, verify events accumulate |
| P2-13 | Action log tracks pass/fail | Steps shown with color-coded status | Manual: run scenario with mixed results |
| P2-14 | No build step required | Dashboard is served as inline HTML/JS/CSS | Verify: no npm build step needed for dashboard |

### 2.4 Session Store (`src/observer/session-store.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P2-15 | Events persisted as NDJSON | `{runDir}/events.ndjson` created with one JSON per line | Run scenario, read file, parse each line as JSON |
| P2-16 | Session state queryable | `getState()` returns current session status, criteria, actions | Call getState() mid-run, verify fields populated |
| P2-17 | NDJSON survives crashes | File flushed on each write, not buffered | Kill process mid-run, verify partial NDJSON readable |

### 2.5 CLI Integration

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P2-18 | `--observe` flag starts dashboard | `pixelcheck run --observe` starts HTTP server, prints URL | Run command, verify "Observer: http://localhost:3847" printed |
| P2-19 | `--observe-port` customizes port | Dashboard accessible on custom port | `pixelcheck run --observe --observe-port 4000`, curl port 4000 |
| P2-20 | Observer works with existing scripted scenarios | No errors or behavior changes in scripted mode | Run existing scenario with `--observe`, verify pass/fail unchanged |

---

## Phase 3: Planner Module

### 3.1 Type Schema Updates (`src/core/types.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P3-01 | SuccessCriterionSchema validates correctly | Valid criteria parse; invalid rejected with clear errors | Unit test: valid + invalid inputs, check parse results |
| P3-02 | HintSchema validates correctly | Hints with condition + suggestion parse | Unit test |
| P3-03 | AgentConfigSchema has correct defaults | Omitted fields use defaults: max_actions=30, replan_threshold=3 | Unit test: parse `{}`, check all defaults |
| P3-04 | ScenarioSchema backward compatible | Existing YAML with `steps[]` still parses with `mode: "scripted"` | Load all existing scenario files, verify no parse errors |
| P3-05 | Autonomous mode requires success_criteria + start_url | Autonomous scenario without criteria or URL fails validation | Unit test: parse autonomous scenario missing fields |
| P3-06 | Scripted mode still requires steps | Scripted scenario without steps fails validation | Unit test |

### 3.2 Planner (`src/agent/planner.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P3-07 | createPlan returns valid PlannedStep[] | Given a goal + screenshot + DOM, returns ordered steps with instructions | Integration test: call with real screenshot of test page |
| P3-08 | Plan steps have reasoning and target criteria | Each step links to >= 1 success criterion | Check output structure |
| P3-09 | revisePlan incorporates failure context | Given failed plan history, produces different strategy | Call with failed_plans array, verify new plan differs |
| P3-10 | Persona context injected into prompts | Plan instructions reflect persona language/concerns | Test with JP persona, verify Japanese-aware instructions |
| P3-11 | Budget awareness in planning | Planner limits plan length when budget is low | Call with remaining_budget = $0.10, verify short plan |
| P3-12 | Cost tracking accurate | planner cost adds to cost accumulator | Check cost.value before/after |

---

## Phase 4: Navigator + Agent Loop

### 4.1 Navigator (`src/agent/navigator.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P4-01 | Navigator produces valid NavigatorDecision | Given a planned step + screenshot, returns action_type + instruction | Integration test |
| P4-02 | needs_replan detected correctly | Navigator returns needs_replan=true when planned step is impossible | Test with mismatched page state |
| P4-03 | Decision maps to existing Step types | buildStepFromDecision creates valid Step objects | Unit test: all action_types produce valid Steps |

### 4.2 Agent Loop (`src/agent/agent-loop.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P4-04 | Full loop execution | Given simple goal (visit + check), agent completes autonomously | Integration test with local test server |
| P4-05 | Replan on failure | After N consecutive failures, planner called with failure context | Set replan_threshold=2, cause 2 failures, verify plan:revised event |
| P4-06 | Budget cap stops execution | Loop stops when cost exceeds budget, emits convergence:budget_exceeded | Set budget=$0.01, verify stop + event |
| P4-07 | max_actions limit respected | Loop stops at max_actions even if criteria unmet | Set max_actions=3, verify 3 actions total |
| P4-08 | Success criteria checked | DOM criteria verified after each action | Set dom criterion, navigate to target page, verify criterion:met |
| P4-09 | Visual criteria checked periodically | Visual criteria not checked every action (interval-based) | Verify visual criteria LLM calls = total_actions / interval |
| P4-10 | Events emitted throughout | session:start, plan:created, action:start/complete, criterion:met, session:end | Collect all events, verify sequence |

### 4.3 Convergence Detector (`src/agent/convergence.ts`)

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P4-11 | Loop detection works | Same (url, dom_hash, instruction) 3x triggers loop_detected | Unit test: feed 3 identical action records |
| P4-12 | Different actions don't trigger loop | Varied actions don't falsely trigger | Unit test: feed 10 different actions |
| P4-13 | Stuck detection tracks consecutive failures | N consecutive failures triggers stuck signal | Unit test: feed N failures in a row |
| P4-14 | Recovery resets counters | Successful action after failures resets consecutive count | Unit test: 2 failures, 1 success, 2 more failures, verify no stuck |

### 4.4 Runner Integration

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P4-15 | runner.ts branches on mode | `scenario.mode === "autonomous"` calls runAutonomous | Code inspection + integration test |
| P4-16 | Autonomous results include agent_summary | ScenarioRunResult has agent_summary with plan_count, total_actions, criteria_met | Run autonomous scenario, check result |
| P4-17 | Scripted mode completely unchanged | No regressions in existing step-based execution | Run all existing scenarios, compare results |

---

## Phase 5: CLI + Schema Integration

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P5-01 | Scenario loader handles autonomous mode | `mode: autonomous` YAML loads correctly | Load test autonomous YAML |
| P5-02 | `--mode autonomous` filter works | Only autonomous scenarios run | Create mixed set, verify filtered |
| P5-03 | `--mode scripted` filter works | Only scripted scenarios run | Same mixed set, verify filtered |
| P5-04 | `explore` command works | `pixelcheck explore --url X --goal Y --criteria Z` runs successfully | Manual test with real URL |
| P5-05 | `replay` command works | `pixelcheck replay <dir>` serves dashboard with historical events | Run then replay, verify dashboard loads |
| P5-06 | Config schema accepts new model fields | `planner`, `navigator`, `replan` model overrides work | Update config YAML, verify parsed |
| P5-07 | Config schema accepts agent/observer sections | New sections parsed with defaults | Parse config with/without new sections |

---

## Phase 6: Pause/Takeover + Polish

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| P6-01 | Pause button in dashboard works | Click pause, agent stops at next checkpoint | Manual: click pause, verify no new actions |
| P6-02 | Resume button works | Click resume after pause, agent continues | Manual: pause, wait, resume, verify continuation |
| P6-03 | Take Over in headed mode | User controls browser, agent waits | Manual: takeover, click around, release |
| P6-04 | Release triggers replan | After takeover, agent re-observes and adjusts plan | Verify plan:revised event after release |
| P6-05 | Event replay accurate | Replay shows events at original timestamps with correct ordering | Run, replay, compare event counts |
| P6-06 | Reporter shows agent_summary | HTML report has "Agent Summary" section for autonomous runs | Generate report, open HTML, verify section |
| P6-07 | Crash recovery | Page crash mid-loop doesn't kill the process | Force page crash, verify graceful error in results |
| P6-08 | Budget exhaustion mid-plan | Clean exit with partial results when budget runs out | Set low budget, verify partial results saved |

---

## Cross-Cutting Acceptance Criteria

| ID | Test | Expected Result | How to Verify |
|----|------|----------------|---------------|
| CC-01 | TypeScript compiles clean | `npx tsc --noEmit` passes with zero errors | Run command |
| CC-02 | No regressions in existing tests | All existing tests pass after each phase | `npm test` after each phase |
| CC-03 | Cost tracking end-to-end | Total cost in AuditRun.summary matches sum of all LLM calls | Compare summary.total_cost_usd with sum(result.cost_usd) |
| CC-04 | NDJSON event log complete | Every AgentEvent emitted appears in persisted file | Count events in-memory vs on-disk after run |
| CC-05 | No sensitive data in events | API keys, passwords not present in event data | Grep events.ndjson for known patterns |

---

## Test Execution Protocol

1. After completing each phase, run **all acceptance tests for that phase**
2. If any test fails:
   - **Stop implementing** — do not proceed to next phase
   - **Read the full error** — understand what actually failed
   - **Trace data flow** — from error back to root cause
   - **grep globally** — find all related code
   - **One-shot fix** — identify root cause, fix once, verify
3. Cross-cutting tests (CC-01 through CC-05) run after **every phase**
4. Only proceed to next phase when all tests pass
