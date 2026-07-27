# Benchmark & Critic Calibration

Two new commands in v0.3 that let us measure the tool *as a system* rather
than just trusting unit tests.

---

## 1. Benchmark harness (`pixelcheck benchmark`)

**Why:** Claims like "5-layer reliability stack reaches 98–99%" aren't
credible without a public, reproducible score. This command runs the
autonomous agent against a WebArena-compatible task set and emits pass@1
numbers you can put in a README next to Browser Use or Skyvern.

### Task format

Each task is a JSON object matching the WebArena public schema (superset —
our optional extensions are ignored by vanilla WebArena parsers):

```json
{
  "task_id": "0001",
  "intent": "Find the cheapest laptop under $500",
  "start_url": "https://shopping.webarena.com",
  "sites": ["shopping"],
  "difficulty": "medium",
  "tags": ["shopping", "filtering"],
  "eval": {
    "eval_types": ["string_match", "url_match"],
    "reference_answers": {
      "must_include": ["$"],
      "must_exclude": ["error"]
    },
    "reference_url": "https://shopping.webarena.com/checkout",
    "reference_url_match": "prefix"
  }
}
```

Store tasks in a directory (one JSON file per task) or a single `.jsonl`
file. Point `--tasks <path>` at either.

### Evaluation predicates

| predicate | semantics |
|---|---|
| `string_match` | `must_include` / `must_exclude` (case-insensitive) / `exact_match` / `fuzzy_match` (≥ half of keywords) |
| `url_match` | `exact` (ignores trailing `/` + query) / `prefix` / `substring` |
| `exact_match` | string equality after trim |
| `program_html` | per-URL DOM checks — locator existence + `required_contents` text presence |
| `page_image_query` | *not implemented* — requires vision; placeholder for WebArena compatibility |

### Running

```bash
# Full local mini-benchmark
pixelcheck benchmark --tasks benchmarks/local-mini

# Filter by difficulty / tags / limit
pixelcheck benchmark --tasks benchmarks/local-mini \
  --difficulties easy,medium --tags signup --limit 20

# Run each cost mode separately for comparison
for mode in max balanced economy; do
  pixelcheck benchmark --tasks benchmarks/local-mini \
    --cost-mode $mode --tag mode-$mode
done
```

### Outputs

Each run writes `benchmark.json` + `benchmark.md` under the `--out` dir.
Key fields in `benchmark.json`:

```json
{
  "tag": "mode-balanced",
  "total_tasks": 12,
  "passed": 10,
  "pass_at_1": 0.833,
  "by_difficulty": { "easy": { "pass_rate": 1.0 }, "medium": { "pass_rate": 0.67 } },
  "total_cost_usd": 1.24,
  "avg_cost_usd": 0.103,
  "p50_duration_ms": 8400,
  "p95_duration_ms": 22100,
  "config_summary": { "cost_mode": "balanced", "planner": "claude-opus-4-6", ... },
  "tasks": [...]
}
```

### Comparing runs

Save each tagged run. Compare by reading the two JSON files and diffing
metrics you care about. We keep this intentionally lightweight — no
dashboard — so benchmarks work in CI without extra infrastructure.

### Running against the real WebArena

1. Stand up WebArena per their instructions (Docker Compose, ~6 GB)
2. Download their `config_files/*.json` task set
3. Point `--tasks` at that directory

The schema is compatible as-is. Our runner will ignore WebArena's
`storage_state` field (we handle auth differently via personas).

---

## 2. Critic calibration (`pixelcheck calibrate`)

**Why:** The vision critic gives scores between 0 and 10 across 18
dimensions. Without a ground-truth check, we can't detect model drift
(Sonnet 4.6 → Sonnet 4.7 may score differently) or prompt regressions.
This command runs the critic against a frozen set of labeled screenshots
and gates CI on the agreement rate.

### Why ranges, not points

LLM scoring has irreducible variance. Asking for exact score match (e.g.,
"this screenshot must score 7.0") produces noisy failures. We label a
range (e.g., "visual_polish ∈ [5, 9]") and accept any score inside it.
The gate is on:

- **mean_agreement** — fraction of (sample, dimension) pairs that land
  in their labeled range, averaged across samples. Default threshold 0.85.
- **mean_max_distance** — average of the worst-offender distance per
  sample. Default ≤ 1.5. Measures how wrong the critic is when it's wrong.
- **fully_aligned_rate** — fraction of samples where ALL labeled
  dimensions land in range AND issue expectations are met. Default ≥ 0.70.

### Fixture format

```json
{
  "id": "home-happy",
  "description": "Clean home page",
  "screenshot": "home-happy.png",
  "persona_id": "us-desktop",
  "scenario_goal": "Assess UX quality",
  "instruction": "Evaluate visual polish, UI consistency, localization.",
  "labels": [
    { "dimension": "visual_polish", "min_score": 5, "max_score": 9, "rationale": "..." },
    { "dimension": "localization", "min_score": 7, "max_score": 10 }
  ],
  "expected_issues": {
    "max_critical": 0,
    "must_flag_any_of": ["error", "broken"]
  },
  "tags": ["clean", "home"]
}
```

The companion `.png` lives next to the `.json` in the fixtures directory.

### Regenerating screenshots

When the fixture site changes:

```bash
npx tsx tests/calibration/generate-fixtures.ts
```

Commit the new PNGs. Re-label any samples whose visual content changed.

### Running

```bash
# Default gate
pixelcheck calibrate

# Custom gate (stricter)
pixelcheck calibrate --min-agreement 0.9 --max-distance 1.0

# Against a different model (e.g., to evaluate a new release)
pixelcheck calibrate --model claude-sonnet-4-7-2026-08-01 --tag sonnet-4.7-pilot
```

### CI integration

Add a nightly workflow that runs `pixelcheck calibrate` with the default
gate. A failure means the critic drifted; review the `calibration.md`
report to decide whether to:

1. Update the fixture labels (legitimate calibration change), OR
2. Roll back the critic prompt / model pin (true regression).

Typical cost per run: $0.05 for 5 samples, $0.50 for 50 samples.
