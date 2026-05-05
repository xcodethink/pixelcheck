# Contributing recipes

PixelCheck **recipes** capture durable knowledge about specific products: stable selectors, URL patterns that actually work, gotchas that bit somebody once. They live in `recipes/<host>/<capability>.yaml`. The agent reads them before inventing an approach, and the community PRs them back when an agent learns something new.

This doc is the contribution flow. The format and writing rules live in [`recipes/README.md`](../recipes/README.md). The starter template is [`recipes/_template.yaml`](../recipes/_template.yaml).

## When to write a recipe

Write a recipe when **all three** are true:

1. The agent had to do something non-obvious to make a real product behave — a private API, a stable selector survived a redesign, a hidden URL parameter, a specific wait state, a framework quirk.
2. That non-obvious knowledge is **not** in the product's public docs (or is buried so deep that a future agent won't find it).
3. The site is one a user is likely to audit again — their own product, a major OAuth provider, a top 10K SaaS, a category the agent will see repeatedly.

Do **not** write a recipe for:

- One-off scripts against a specific URL on a specific day.
- Generic Playwright / Stagehand patterns that apply to every site (those belong in the SKILL.md or in core code).
- A site you visited but never actually exercised end-to-end.

## The flow

### 1. Run it

Author the recipe **while** auditing the site. Iterate inside `act` / `extract` / `judge` calls until you have a workflow that completes the user's task. Capture the selectors that worked and the workarounds you needed.

### 2. Strip it down

Remove everything that isn't durable shape. The four writing rules in `recipes/README.md` are not aspirational — every contribution is reviewed against them:

- **Map, not diary.** No first-person narration, no "I noticed", no session-specific state.
- **No pixel coordinates.** Selectors / text matches / role queries only.
- **No secrets, no PII.** Use `${persona.<slot>}` placeholders or document the auth requirement and let the user supply it at run time.
- **Field-tested or labeled untested.** `last_verified.date` is required.

### 3. Place it

```
recipes/
  <host>/                   # e.g. accounts-google-com/, amazon-com/
    <capability>.yaml       # e.g. oauth-signin.yaml, checkout.yaml
```

Capability filename must match the `capability:` field inside the YAML. Hostname is the bare public domain, lowercased, with dots replaced by dashes (`accounts-google-com`, not `accounts.google.com`).

A site can have multiple recipes — `amazon-com/checkout.yaml`, `amazon-com/orders.yaml`, `amazon-com/product-search.yaml`. Each one is one capability, one PR.

### 4. Validate locally

```bash
# Lint YAML syntax.
npx js-yaml recipes/<host>/<capability>.yaml > /dev/null

# Open it next to _template.yaml and confirm every key is present or
# explicitly omitted (don't leave half-filled keys).
diff -u recipes/_template.yaml recipes/<host>/<capability>.yaml | less

# Run the actual capability against the live site once more, in a fresh
# browser, on the persona you're committing it under.
pixelcheck audit \
  --persona <persona-id> \
  --scenario <bundled-or-custom-scenario-that-uses-the-recipe>
```

If the run fails, the recipe is wrong. Fix and re-test before opening the PR — reviewers do not have your auth state and cannot reproduce.

### 5. Open the PR

Title format:

```
recipe(<host>): <capability>
```

Examples:

- `recipe(amazon-com): orders`
- `recipe(accounts-google-com): oauth-signin`
- `recipe(stripe-com): checkout`

PR body must include:

- **What the recipe enables** — one sentence.
- **`last_verified` claim** — date, persona, agent version. Reviewers trust this.
- **The four-rules checklist:**
  - [ ] Map, not diary
  - [ ] No pixel coordinates
  - [ ] No secrets / PII
  - [ ] `last_verified.date` set (or `status: untested` declared)
- **Link to the run** — if you have a public artifact (a `reports/` JSON, a screenshot of the audit), link it.

### 6. Reviewer checks

A reviewer's job is **not** to re-run the recipe (impossible without your auth). It is to verify the four writing rules and that the recipe is generic enough to be useful to a different agent.

Reviewer accepts the recipe if:

- All four rules pass.
- The recipe is genuinely site-specific knowledge, not a generic Playwright pattern.
- The capability name matches an existing convention (or introduces a new one with reason).
- The selectors and URL patterns look plausible (reviewer Google-spot-checks).

Reviewer rejects (or requests changes) if:

- Pixel coordinates, real credentials, real PII, or first-person narration appear.
- The recipe duplicates content that belongs in core code or the SKILL.md.
- `last_verified` is missing.
- The site is too niche to justify shipping in the bundle (in that case, suggest a separate community-recipes repo).

## After merge

Recipes age. Sites change. If you notice a recipe is outdated:

- **Small fix** (one selector changed): open a PR titled `recipe(<host>): refresh selectors` and bump `last_verified.date`.
- **Site rewrote everything**: open a PR titled `recipe(<host>): rewrite for <year>-Q<quarter> redesign`, full replacement.
- **Recipe is permanently broken** (site killed the capability): open a PR titled `recipe(<host>): retire <capability>`, move the file to `recipes/_archived/<host>/<capability>.yaml` with a `retired_on:` date, do not delete it (history is useful).

## Disclosure and ToS

PixelCheck is a tool a user runs against their own products and against products they are authorised to audit. Recipes describe **how** to drive a site programmatically, not **whether** doing so is permitted. Contributors are responsible for ensuring the recipe they ship does not encourage activity that violates the target site's Terms of Service. Reviewers will reject recipes that automate scraping or interaction in clear violation of a published ToS.

When in doubt, prefer recipes that:

- Use a documented public API (REST / GraphQL / RSS / sitemap) over the browser.
- Drive the site at human speed (one request per second is fine; 50 in parallel is not).
- Authenticate with the user's own credentials via a persona, not a shared / scraped session.
