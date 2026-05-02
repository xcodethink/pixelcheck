# Your Tests Pass. Your CI Is Green. But What Does a Real User Actually See?

**I built an open-source tool that launches real browsers as 18 different users from 15 countries and tells you whether your product actually works — not whether your code runs.**

---

## The moment I realized E2E tests weren't enough

I run a SaaS product ([ScamLens](https://scamlens.org)) that serves users across multiple countries and languages. After every deployment, our CI pipeline was green. Unit tests passed. Integration tests passed. Playwright E2E tests passed.

And then a Japanese user emailed us: half the page was in English. An Arabic user sent a screenshot — the entire layout was mirrored wrong. Our Google OAuth login silently broke for the 6th time in 10 deployments.

None of these were "bugs" in the traditional sense. The code was correct. The feature worked. But the *experience* was broken for real humans in real contexts.

I spent weeks hunting these issues manually — opening Chrome, switching locales, testing on different viewports, checking RTL layouts, squinting at screenshots to verify translations. It was the most tedious part of shipping, and I was still missing things.

So I built a tool to do it automatically.

## What is AI Browser Auditor?

It's an open-source CLI that:

1. Launches real Chromium browsers with accurate device fingerprints (locale, timezone, viewport, user-agent)
2. Walks through your product's core flows as 18 different personas from 15 countries
3. Uses Claude Vision to *look at the page* and evaluate it like a human reviewer would
4. Runs axe-core WCAG analysis for accessibility compliance
5. Generates structured reports with screenshots, video, network logs, and dimensional scores

Think of it as having a senior PM, QA engineer, and accessibility auditor review every deployment, in every language, on every device class — automatically.

```bash
npm install ai-browser-auditor
npx ai-audit init my-app --url "https://myapp.com"
npx ai-audit run --project my-app
```

## How it works (technical details)

For each **(persona x scenario)** combination, the tool:

**Launches a fingerprinted browser.** Not just changing the viewport — it sets locale, timezone, language headers, user-agent, and applies 15 anti-detection patches so your site renders the same way it would for a real user (not a bot-flagged Playwright session).

**Executes steps semantically.** Scenarios are declarative YAML. Steps say *"click the sign-up button"*, not *"click #btn-signup-v3"*. Powered by [Stagehand](https://github.com/browserbase/stagehand), which uses Claude to understand the page and act on natural language instructions.

**5-layer reliability stack.** Semantic browser automation is inherently flaky (~75% baseline success rate). We engineered five fallback layers to reach 98-99%:

```
L1: Page Stability Gate       — wait for network idle + DOM settled + hydration
L2: LLM Instruction Rewrite   — Haiku rewrites the failed instruction using DOM context
L3a: Selector Hint            — optional CSS selector fallback from YAML
L3b: Auto Selector Discovery  — Stagehand observe() extracts candidate selectors
L4: Computer Use              — Claude sees the pixels and operates the browser directly
```

Each layer only fires if the previous one failed. Cost impact: L1-L3 are essentially free; L4 costs ~$0.01-0.15 per invocation.

**Claude Vision scores the result.** At visual checkpoints, screenshots are segmented and sent to Claude Vision, which evaluates the page across dimensions like:

- **completion** — did the flow actually complete?
- **localization** — is everything in the right language?
- **visual_polish** — does this look like a professional product?
- **trust_signals** — would a user trust this page?
- **accessibility** — can everyone use this? (complemented by axe-core WCAG analysis)

Scores are 0-10 with justifications. Not pass/fail — a nuanced evaluation.

**axe-core for WCAG compliance.** A dedicated `assert_a11y` step injects axe-core into the page and runs rule-based WCAG analysis. This catches what AI vision can't (missing ARIA labels, contrast ratios, keyboard navigation) while the vision critic catches what rules can't (confusing layouts, unreadable text, poor visual hierarchy).

## The 18 personas

This is the part that makes the tool actually useful rather than just cool.

Each persona isn't just a viewport size. It's a full identity:

| | Country | Language | Device | Mental model |
|---|---|---|---|---|
| College student | US | English | iPhone | "Show me value in 10 seconds or I leave" |
| Retired teacher, 72yo | US | English | iPad | "Is this safe? Will I get scammed?" |
| Housewife | JP | Japanese | MacBook | "Any English string means this isn't for me" |
| Security analyst | DE | German | iPad Pro | "Show me the methodology, not marketing" |
| Gig worker | ID | Bahasa | Budget Android | "Will this load on my data plan?" |
| Businessman | SA | Arabic (RTL) | iPhone 15 | "If the layout is mirrored, I can't navigate" |
| Student | CN | Chinese | Xiaomi | "I need to bypass censorship to use this" |

...and 11 more covering Hindi, Korean, Vietnamese, Russian, Yoruba/English, Spanish LATAM, Thai, Traditional Chinese, French.

The AI reviewer judges your product *through their eyes*. When the Japanese persona sees an English string in your nav, that's flagged as a localization issue — but the same string seen by the US persona is fine.

## What the output looks like

Every audit produces:

```
reports/2026-04-12_post-deploy/
  audit.json              # Machine-readable: every score, issue, step result
  audit.html              # Dark-theme dashboard with SVG trend sparklines
  summary.md              # Terminal-friendly for CI logs

  jp-japanese-pro__signup-flow/
    01-homepage.png        # Timestamped + SHA-256 hashed
    02-localization.png
    network.har            # Full network log
    console.log            # Browser console errors
    video/recording.webm   # Session recording
```

The HTML report includes historical trend charts (backed by a local SQLite database), so you can see how your product quality changes over time. You can diff any two runs:

```bash
ai-audit history                          # score trends
ai-audit diff run_0411 run_0412           # what changed
ai-audit run --min-score 7.5              # CI quality gate
```

## An honest look at limitations

- **Cost.** A full 18-persona audit costs $80-300 in Claude API fees. In practice, you'd run P0 scenarios on every deploy (3-5 personas, ~$5-15) and the full matrix weekly.

- **Reliability.** The 98-99% target is an architectural estimate, not a measured figure across hundreds of real runs yet. I'm actively running it against multiple production sites to validate.

- **Not a replacement for E2E tests.** This is the layer *after* E2E. Your tests verify code correctness. This tool verifies product quality.

- **Claude-dependent.** Currently requires an Anthropic API key. Multi-model support (GPT-4o, Gemini) is on the roadmap but not implemented.

- **New project.** This is v0.2.0. The core engine is solid and battle-tested on one production site, but the ecosystem (scenario templates, community personas, integrations) is just beginning.

## Why open source?

Three reasons:

1. **The persona library should be a community effort.** No single team can represent all the world's users. I want people from every country contributing personas with authentic mental models and concerns.

2. **Scenario templates should be shared.** "OAuth signup flow", "checkout flow", "dashboard load" — these patterns are universal. We shouldn't all reinvent them.

3. **This category doesn't exist yet.** There are browser automation frameworks (browser-use, 87K stars). There are accessibility engines (axe-core, 7K stars). There are visual regression tools (Applitools, $20-100K/year). But "AI product experience auditing" as a category has zero established open-source tools. I'd rather seed the category as open source than try to build it alone behind a paywall.

## Try it

```bash
npm install ai-browser-auditor
npx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...

npx ai-audit init my-app --url "https://your-site.com"
npx ai-audit run --project my-app --headed   # visible browser for first run
```

The repo: **[github.com/xcodethink/ai-browser-auditor](https://github.com/xcodethink/ai-browser-auditor)**

If you've ever deployed something that was "green" but broken for real users, I built this for you. Stars, issues, and persona contributions are all welcome.

---

## Links

- GitHub: [xcodethink/ai-browser-auditor](https://github.com/xcodethink/ai-browser-auditor)
- Changelog: [CHANGELOG.md](https://github.com/xcodethink/ai-browser-auditor/blob/main/CHANGELOG.md)
- Architecture: [docs/architecture.md](https://github.com/xcodethink/ai-browser-auditor/blob/main/docs/architecture.md)

**Stack:** TypeScript, Playwright, Stagehand 2.0, Claude (Vision + Computer Use), axe-core, better-sqlite3

**License:** MIT
