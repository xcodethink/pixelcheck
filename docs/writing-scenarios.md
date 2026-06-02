# Writing scenarios

A scenario is a YAML file in `scenarios/` that describes a goal-oriented user journey. Scenarios are **declarative**, **semantic**, and **persona-aware** — they don't hardcode selectors, they describe intent.

## Schema

```yaml
id: 01-google-oauth-signup                   # required, unique
name: Google OAuth Signup End-to-End         # required, human readable
priority: P0                                 # P0 | P1 | P2 | P3
goal: |                                      # required, fed to the critic for context
  Register a new account using Google OAuth, verify dashboard loads,
  and confirm a localized welcome email arrives.

applies_to:                                  # required
  personas:
    - us-english-free-mobile
    - jp-japanese-pro-desktop

scoring_dimensions:                          # canonical dimensions for the critic
  - completion
  - localization
  - visual_polish
  - trust_signals
  - time_to_value

persistent_storage: false                    # set true for extension scenarios

steps:
  - id: open-home                            # every step has a unique id
    type: visit                              # see step types below
    url: https://my-app.com/${persona.locale}
    wait_until: networkidle
```

## Step types

| Type | Purpose | Backend | Needs LLM |
|---|---|---|---|
| `visit` | Open a URL | Playwright | no |
| `act` | Natural-language action ("click signup") | Stagehand | yes |
| `extract` | Pull structured data with optional Zod schema | Stagehand | yes |
| `observe` | List actionable elements ("find submit buttons") | Stagehand | yes |
| `wait_for` | Wait for selector / text / time | Playwright | no |
| `assert_visual` | Vision critic scores screenshot | Claude vision | yes |
| `assert_dom` | Deterministic DOM check | Playwright | no |
| `check_email` | Wait for an email in the temp inbox | mail.tm | no |
| `screenshot` | Explicit checkpoint capture | Playwright | no |
| `computer_use` | Full Computer Use task | Computer Use API | yes |
| `custom` | TypeScript file with default-exported handler | user code | depends |

## Common step fields

```yaml
- id: my-step                       # required
  type: act
  description: Optional human note
  critical: false                   # if true, fail aborts the scenario
  critical_review: false            # if true, escalate critic to Computer Use second pass
  retry: 2                          # 0..5, exponential backoff
  timeout: 15000                    # per-step timeout in ms (overrides default)
  fallback: computer_use            # what to do on terminal failure: computer_use | skip | fail
```

## Template substitution

Strings inside any step value support these placeholders:

| Placeholder | Resolves to |
|---|---|
| `${persona.field}` | persona property by path (e.g. `${persona.locale}`, `${persona.language}`) |
| `${env.VAR_NAME}` | `process.env.VAR_NAME` |
| `${stripe.card_number}` | Stripe test card number from env |
| `${stripe.exp}` | Stripe test card expiration |
| `${stripe.cvc}` | Stripe test card CVC |
| `${stripe.pk_test}` | Stripe test publishable key |

## Example: critical visual assertion with escalation

```yaml
- id: rate-checkout
  type: assert_visual
  critical_review: true             # escalate to Computer Use if score < 8
  dimensions:
    - visual_polish
    - payment_flow_clarity
    - trust_signals
  instruction: |
    Rate this checkout page against Stripe / Linear standards. Look for:
    - Visible security badges and refund policy
    - Three pricing tiers clearly differentiated
    - All copy in ${persona.language}
    - No layout breakage at ${persona.viewport.width}x${persona.viewport.height}
```

## Example: extract with Zod schema

```yaml
- id: extract-pricing
  type: extract
  instruction: Extract the three pricing tiers shown on the page
  schema:
    tiers:
      - name: string
        price: number
        currency: string
        features: string[]
  store_as: pricing_data
```

The `store_as` field stashes the result in `ctx.store.pricing_data` for later steps to reference (e.g. via custom step handlers).

## Example: email verification

```yaml
- id: subscribe
  type: act
  instruction: Submit the newsletter form

- id: check-welcome
  type: check_email
  wait_seconds: 90
  expected_subject_contains: YourApp
```

The auditor automatically creates a mail.tm temp inbox at scenario start if any `check_email` step is present.

## Example: custom handler

```yaml
- id: install-extension
  type: custom
  handler: ../scenarios/handlers/install-extension.js
  inputs:
    extension_path: ../../my-extension/dist
```

Custom handlers are loaded at runtime via `await import(handlerPath)`, so the
file must be runnable JavaScript on your Node (ship `.js`/`.mjs`, not `.ts`,
unless you run pixelcheck under a TS loader). Don't import from pixelcheck's
internal `src/` — only `dist/` is published, so such imports dangle for
installed users; the step/context shapes are duck-typed at runtime. See the
shipped example at `scenarios/handlers/install-extension.js`.

The handler file must default-export an async function `(step, ctx)` returning
a `Partial<StepResult>` (use JSDoc for editor hints):

```javascript
/**
 * @param {{ type: "custom", inputs?: Record<string, unknown> }} step
 * @param {{ store: Record<string, unknown> }} ctx
 * @returns {Promise<{ status: string, output?: Record<string, unknown> }>}
 */
export default async function (step, ctx) {
  // your logic
  return { status: "pass", output: {} };
}
```

## Best practices

### 1. Steps should be coarse and semantic, not fine and mechanical

- **Bad**: `click button.btn-primary > svg.icon`
- **Good**: `Click the "Continue with Google" button`

The point is that Stagehand looks at the accessibility tree and figures out the actual selector. Your YAML should survive UI refactors.

### 2. Use `critical_review` sparingly

Each `critical_review: true` step potentially adds an Opus 4.6 + Computer Use call (~$0.30-1.00). Use it for the 1-2 most important moments per scenario, not every screenshot.

### 3. Use `wait_for` instead of fixed sleeps

`wait_for` with a selector is faster and more reliable than `wait_for: ms: 5000`. Reserve fixed sleeps for "after toast appears" type race conditions.

### 4. Keep `applies_to.personas` honest

If a scenario only makes sense for paid users, list only paid personas. The runner will skip combinations that don't match.

### 5. Mark login steps as `critical: true`

If login fails, every subsequent step is meaningless. Marking it critical aborts the scenario early instead of producing 20 cascading false-positive failures.

### 6. Localization audits should iterate over multiple pages

A localization scenario should visit 4-6 representative pages and run `assert_visual` on each, not just the home page. Different pages are owned by different developers and bug differently.

### 7. Custom handlers go in `scenarios/handlers/`, not `src/handlers/`

`src/handlers/` is the built-in dispatch table — leave it alone. User-defined logic lives next to the scenarios that use it.
