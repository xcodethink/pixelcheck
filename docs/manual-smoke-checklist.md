# Manual Smoke Checklist — v0.3

Automated tests cover unit + integration logic with stubbed LLMs. These checks
exercise the full stack against the live Anthropic API and a real target site.
Run before any merge to main.

## Preconditions

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm install
npm run build
```

## Hermetic smoke (fixture site, ~$0.20)

```bash
# Start fixture server
npx tsx -e "import { startFixtureServer } from './tests/fixtures/test-site/server.js'; \
  startFixtureServer().then(s => console.log('Fixture up on', s.url));" &
FIXTURE_PID=$!

# Run the autonomous smoke scenario against the fixture
ai-audit run --scenario 10-autonomous-smoke --budget 0.5

kill $FIXTURE_PID
```

Check the produced `reports/<runId>/audit.html`:
- [ ] Overall status is `pass` or `pass_with_issues`
- [ ] `agent_summary.convergence_reason` is `goal_met`
- [ ] At least one step's `signals.network.status_counts["2xx"]` is ≥ 1
- [ ] No `critical` issues in the report

## Cost-mode comparison (~$0.50)

Run the same scenario in all three cost modes and compare outcomes:

```bash
AUDIT_COST_MODE=max      ai-audit run --scenario 10-autonomous-smoke --tag smoke-max
AUDIT_COST_MODE=balanced ai-audit run --scenario 10-autonomous-smoke --tag smoke-balanced
AUDIT_COST_MODE=economy  ai-audit run --scenario 10-autonomous-smoke --tag smoke-economy
```

Check `reports/`:
- [ ] All three complete with status `pass` or `pass_with_issues`
- [ ] `balanced` total cost < `max` (should be 2–3× cheaper)
- [ ] `economy` total cost < `balanced` (should be further 1.5–2× cheaper)
- [ ] Score delta max→balanced is ≤ 5 points; balanced→economy ≤ 10 points

## Plan cache verification (~$0.30)

```bash
# First run — cache miss, Opus planner invoked
rm -f ~/.ai-browser-auditor/plan-cache.db
ai-audit run --scenario 10-autonomous-smoke --tag cache-first
# Note total cost

# Second run — should hit cache, skip Opus planner
ai-audit run --scenario 10-autonomous-smoke --tag cache-second
# Total cost should be meaningfully lower
```

- [ ] Second run cost < first run cost
- [ ] Second run's `audit.json` contains event `plan:created` with `from_cache: true`
- [ ] `plan-cache.db` size remains < 1 MB

## Live-site sanity (one persona, one scenario, ~$0.30)

Point at a real deployed URL you control:

```bash
export BASE_URL=https://your-staging-site.example
ai-audit run --scenario smoke --personas us-chatgpt-pro-macbook --budget 0.5
```

- [ ] Browser launches, reaches target URL
- [ ] Critic score ≥ 6/10
- [ ] No stealth-core warnings in stderr
- [ ] `reports/<runId>/audit.html` renders correctly in a browser
- [ ] Video is playable in `reports/<runId>/<unit>/video.webm`

## Benchmark smoke (local mini, ~$0.30)

```bash
ai-audit benchmark --tasks benchmarks/local-mini \
  --cost-mode balanced --per-task-budget 0.15
```

- [ ] All 3 tasks run to completion (pass or fail, not crash)
- [ ] `benchmark.md` emitted with `pass@1` header
- [ ] `benchmark.json` parses as valid JSON
- [ ] At least 1/3 tasks passes (the signup task should be reliable)

## Critic calibration smoke (~$0.20)

```bash
ai-audit calibrate --fixtures tests/fixtures/critic-calibration \
  --model claude-sonnet-4-6
```

- [ ] Exits 0 (gate passes) OR exits 1 with specific violation list
- [ ] `calibration.md` shows per-sample + per-dimension breakdown
- [ ] Mean agreement ≥ 0.85 on the shipped fixture set
- [ ] No sample errors (all 5 complete)

## Rollback check

- [ ] `git diff main..HEAD -- src/core/types.ts` shows only additive schema changes
- [ ] Existing v0.2 scenarios still parse (run `ai-audit validate` on a v0.2 project)
- [ ] `tsc --noEmit` clean
- [ ] `npm test` full suite passes
