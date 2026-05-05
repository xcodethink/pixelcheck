---
name: pixelcheck
description: Browser eyes-and-hands for AI coding agents. Drop-in MCP server that loads the page, sees rendered HTML, clicks, fills, judges, compares, and audits — without leaving the agent's workflow. Use when the user asks the agent to verify a deployed UI, debug a frontend behaviour they describe, score an onboarding flow, compare A/B variants, or audit a production URL. Local-first; the only outbound destination is the LLM provider the agent already uses.
---

# pixelcheck

A drop-in MCP server with five browser primitives (`see`, `act`, `extract`, `judge`, `compare`), two presets (`audit_url`, `explore_url`), and meta tools. The agent picks the smallest tool that answers the question; it does **not** orchestrate scenarios by hand unless the user asked for one.

For installation, environment variables, and the full env table, run `list_capabilities` (one MCP call, no LLM). For per-site recipes — durable knowledge about specific products and their quirks — see [`recipes/`](recipes/).

## When to use which tool

Pick by what the user is actually asking for. Do not chain primitives by reflex; one preset call usually answers a vague question better than seven primitive calls.

| User asks for… | Tool | Cost band |
|---|---|---|
| "Audit this URL" / "score this page" / "is the onboarding good?" | `audit_url` | $$ |
| "Explore until you find X" / "click around and check Y" / open-ended goal | `explore_url` | $$$ |
| "What does this page look like?" / "load X and tell me Y" | `see` (with `goal`) | $ |
| "Click X then fill Y then check Z" — fixed sequence the user spelled out | `act` | $ + per-step |
| "Pull these fields off the page" — schema known | `extract` | $ |
| "Score this screen on these dimensions" / rubric-style review | `judge` | $ |
| A / B comparison of two URLs or two prior captures | `compare` | $$ |
| "How are you priced?" / "what tools do you have?" / "what env vars matter?" | `list_capabilities` | free |
| "Show me available personas / scenarios" | `list_personas` / `list_scenarios` | free |
| Recall the previous audit's summary | `get_last_report` | free |

`see` / `extract` return a `capture` object. Pass that capture into a subsequent `judge` or `compare` instead of re-navigating — saves one full page load per follow-up question.

## What actually works

- **One preset beats five primitives.** When the user gives a vague goal (`"audit https://x.com"`), call `audit_url` once. The preset already runs see → judge → composes a report. Manually chaining `see` → `judge` → `extract` rebuilds the same machine and burns three browser launches.
- **`see` with `goal=` is free reconnaissance.** One vision call, ~$0.005, returns a structured answer about what's on screen. Use it before deciding whether you need `act` (you might not).
- **Reuse `capture` across calls.** Both `judge` and `compare` accept `{ capture: <prior result> }` instead of `{ url }` — no second navigation, no re-render flake.
- **Pass `persona` for locale-sensitive audits.** Without it, every primitive defaults to 1280×800 / en-US / UTC. Real users aren't on en-US/UTC; bugs that matter often only surface under a specific locale or viewport.
- **`list_capabilities` first when the env is unfamiliar.** It returns the complete env-var table (cost guard caps, cache paths, artifact dirs) without any LLM cost. Faster than reading the README, and never stale relative to the running version.
- **`engine: "playwright"` on `act` is deterministic.** When the user wrote the steps themselves (`click #signin → fill #email → press Enter`), use Playwright steps. Fall back to `engine: "stagehand"` only when the step description is ambiguous (`click the sign in button`).
- **Persona files are YAML, user-editable, and bundled.** If the agent needs a viewport / locale combo not in `personas/`, the user can drop a new file in their project's `personas/` dir — no code change, no PR.

## Design constraints

- **Local-first.** PixelCheck never sends user data anywhere except the LLM provider the user has already configured (Anthropic by default). Don't propose architectures that ship screenshots / DOMs to a third-party SaaS.
- **Don't fabricate persona / scenario IDs.** Always `list_personas` / `list_scenarios` first if unsure; the bundle is finite.
- **One LLM call per primitive, not per step.** `audit_url` is one logical run; do not loop it inside another loop "to be thorough."
- **Cost guard is real.** Per-run defaults to $5 USD, per-day $50. If you propose a 200-page sweep, surface the cost estimate first (`audit_url` × 200 ≈ $$$) and let the user say go.
- **Tabs are not stable identifiers.** When the user has multiple tabs, use the URL or the rendered title to confirm — never "the second tab."

## Recipes (per-site playbooks)

When a user repeatedly audits the same product (their app, a competitor, an OAuth provider) the durable knowledge belongs in [`recipes/<host>/recipe.yaml`](recipes/) — stable selectors, the URL pattern that actually filters, the gotcha that bit them once. Recipes are scenarios with the diary stripped out: site shape only, no pixel coords, no secrets.

The agent reads a recipe before inventing an approach, and contributes back when it discovers something new (a private API that beats the browser, a selector that survived a redesign, a hidden wait state). Recipe writing rules live in [`recipes/README.md`](recipes/README.md); the contribution flow is in [`docs/contributing-recipes.md`](docs/contributing-recipes.md).

If `BH_DOMAIN_SKILLS=1`-style opt-in matters for your harness, recipes follow the same convention: dormant by default, enabled via env (see `recipes/README.md`). Out of the box, only the bundled `personas/` and `scenarios/` are active.

## Gotchas

- **`audit_url` does not retry forever.** A single run is one persona × one scenario. If the user wants a full matrix (5 personas × 3 scenarios), say so and call `audit_url` per pair, or use the CLI (`pixelcheck run`) which supports matrix execution natively.
- **`compare` needs both sides to be capturable.** If side B is behind auth, capture it first via `see`/`extract` while logged-in, then pass `capture: <result>` to `compare`. Don't pass an authenticated URL and hope.
- **`get_last_report` reads the local `reports/` history DB.** It only works if a previous `audit_url` actually ran *in this project root*. If the user is in a fresh project, this returns empty — ask them which run they meant.
- **Vision calls are screenshots, not video.** `see`/`act`/`judge` capture stills. Animations, autoplaying videos, transient toasts, lazy-loaded carousels — pass `wait_for: networkidle` or a CSS selector that proves the thing has actually rendered.
- **`extract` schema must be a strict object.** No `oneOf`, no `$ref`, no `const`. The primitive rejects them with a precise error; don't try to be clever with discriminated unions.
- **Critic calibration drifts.** If `judge` results stop matching the user's intuition after a model bump, run `calibrate_critic` against the bundled `baselines/` fixtures before claiming the score is "right."
- **Reports / artifacts are written to disk every run.** Cost-controlled, but not free of disk space. `~/.pixelcheck/` and `./reports/` grow over time; the user can prune via the artifacts cleanup pruner (`AUDIT_ARTIFACTS_*` env vars).

## When you need more

- Run `list_capabilities` for the live tool catalog, env vars, cache state, and cost estimate bands.
- Read [`README.md`](README.md) for installation, CI integration, and the broader product story.
- Check [`recipes/<host>/`](recipes/) before scripting against a site for the first time.
