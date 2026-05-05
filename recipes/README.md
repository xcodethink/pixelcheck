# PixelCheck Recipes — per-site playbooks

A **recipe** is durable knowledge about how to audit a specific product or site: stable selectors, URL patterns that actually filter, gotchas that bit somebody once. The agent reads a recipe before inventing an approach, and contributes back when it discovers something new.

Recipes live in `recipes/<host>/recipe.yaml` (and optional sibling YAMLs for additional capabilities on the same host). They are dormant by default — bundled with the package but only loaded when the agent or user explicitly references them. Personas and scenarios remain the primary execution units; recipes are reference material the agent consults *while* running them.

## Writing rules (read before contributing)

These four rules exist because they are how recipes stay useful 18 months from now. Recipes that violate them rot fast and waste the next agent's time.

### 1. The map, not the diary

Capture the **durable shape** of the site — selectors, URL patterns, page structure, framework quirks. Do **not** capture session-specific narrative, intermediate states from one debugging session, or play-by-play of how *you* navigated this morning. If a future contributor can't tell whether a paragraph applies to *every* visit or just *yours*, delete it.

| Map (keep) | Diary (delete) |
|---|---|
| `Order # regex: \d{3}-\d{7}-\d{7}` | "I noticed yesterday that orders had this format" |
| `?search=<q> alone does not filter; you must POST the form` | "After ten minutes I figured out the URL doesn't work" |
| `Compose textbox: [data-testid="tweetTextarea_0"]` | "Tab to the third element from the top-left" |

### 2. No pixel coordinates

Pixel coordinates break on every layout change, every viewport size, every browser zoom level. Use a CSS selector, a text match, or a getBoundingClientRect-based JS snippet. If the only way to hit something is by pixel, the recipe is wrong; describe the JS dance instead.

### 3. No secrets, no PII, no per-user data

Recipes are public. They get bundled into the npm package and published. Do not write API keys, session tokens, real order numbers, real email addresses, real names, or anything that identifies one specific user. Use placeholders (`<your-email>`, `<order-id>`, `${persona.email}`).

### 4. Field-tested or labeled as "untested"

Every recipe must declare when it was last verified to work. Sites change. A six-month-old recipe with no verification timestamp is liability, not asset.

```yaml
last_verified:
  date: "2026-05-06"
  url: "https://example.com/account"
  agent: "pixelcheck@1.1.5"
```

If you're contributing a recipe you haven't actually run, mark it explicitly:

```yaml
last_verified:
  date: null
  status: untested
  notes: "Drafted from public docs; not run end-to-end."
```

## Format

Each recipe is a single YAML file with a stable shape (see [`_template.yaml`](_template.yaml)). The required top-level keys are:

- `id` — kebab-case, must match the directory name (`google-oauth/recipe.yaml` → `id: google-oauth`)
- `host` — the public hostname this applies to (`accounts.google.com`)
- `capability` — what this recipe enables (`oauth-signin`, `checkout`, `scraping`, `posting`, `audit`)
- `last_verified` — see rule 4
- `do_this_first` — short paragraph: the **fastest** path to the result. Often "use the API instead of the browser."
- `stable_selectors` — table of element → selector that survives redesigns
- `gotchas` — list of `{ problem, fix }` pairs, each one a discrete trap

Optional keys:

- `applies_to.personas` — persona IDs this recipe was tested under
- `applies_to.scenarios` — scenario IDs that consume this recipe
- `workflows` — named workflows (each is a list of `act` steps)
- `references` — relevant external docs, ADRs, or GitHub issues

## Discovery

When `audit_url` or `explore_url` navigates to a host that has a recipe, the runner surfaces the recipe filename(s) in its log so the agent can read them. To enable per-host recipe surfacing in the runner, set:

```bash
PIXELCHECK_RECIPES_ENABLED=1
```

Without it, recipes are present on disk but the runner does not auto-surface them — the agent must reference them explicitly. The opt-in mirrors browser-harness's `BH_DOMAIN_SKILLS=1` convention; the goal is the same: don't pollute the agent's context with dormant playbooks until they are actually wanted.

## Naming

- One directory per public host (the bare domain, lowercased, dots replaced with dashes for filesystem-friendly paths: `accounts-google-com/`, `x-com/`, `amazon-com/`).
- One YAML per *capability* under that host. A site can have multiple recipes — `amazon-com/checkout.yaml`, `amazon-com/orders.yaml`, `amazon-com/product-search.yaml`.
- The capability filename must match the `capability:` field inside the YAML.

## Contributing

Read [`docs/contributing-recipes.md`](../docs/contributing-recipes.md) for the full PR flow. The summary:

1. Test your recipe against the live site, on the persona you intend to commit it under.
2. Strip diary, secrets, and pixel coordinates.
3. Set `last_verified.date` to today.
4. Open a PR titled `recipe(<host>): <capability>`.
5. Reviewers verify the four rules above, not the implementation details — they trust your `last_verified` claim.

If your recipe involves an authenticated flow, document the auth requirement in `requires:` but **never** include real credentials. Use the persona's secret-resolution layer (see `src/core/persona.ts`) for any per-user values.
