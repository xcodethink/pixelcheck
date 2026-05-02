# PixelCheck — Real Eyes and Hands on the Web for AI Agents

**Right now, you're a screenshotting middleman.**

Your AI agent is writing 80% of your frontend. It's fast. It's good at code. But it's blind:

- It writes a button. You open Chrome to check it actually rendered. Paste a screenshot back. Ask for the fix.
- It tweaks the OAuth flow. You log in to verify it didn't silently break. Sixth time this month.
- It updates the Japanese strings. A user emails: "half the page is in English." You didn't catch it.
- It rewrites checkout. You walk through it on iPhone, Android, iPad to *feel* whether step 3 is confusing.
- It changes the Arabic layout. RTL didn't propagate. You don't notice for two days.

You become the bridge. The agent has thoughts. You have a browser. **The two never meet.** Hours of your week, every week, indefinitely.

I built [PixelCheck](https://github.com/xcodethink/pixelcheck) to remove that role. It's an open-source MCP server that gives any AI agent five browser primitives — `see` / `act` / `extract` / `judge` / `compare` — so the agent stops describing what it would do and just does it. Local-first, vendor-agnostic, MIT-licensed. Drop it into Claude Desktop, Cursor, Cline, Continue, Zed, or Claude Code via `~/.mcp.json` and your agent gets 17 tools instantly.

---

## The moment I realised what was missing

I run a SaaS product ([ScamLens](https://scamlens.org)) and I write most of its frontend through an AI agent. The agent can write a button, write the OAuth callback, write the i18n strings, write the Stripe checkout — and then it stops, because *it can't actually see what it just built*.

So I'd open Chrome, switch locales, click around, take screenshots, paste them back, ask the agent to fix things. The five bullets above? Those are *literally* my last six months — every week, hours of being the eyes of a brain that never gets to see.

That's what PixelCheck removes.

## What PixelCheck is

PixelCheck is an MCP server that exposes five browser primitives to any AI agent:

```
see(url, opts)              snapshot a page (DOM + screenshot + console + network)
act(url, steps)             execute an action sequence (semantic + selector + Computer Use)
extract(url, schema)        pull structured data matching a Zod / JSON schema
judge(url, rubric)          score a page against a rubric ("is this dark-pattern free?")
compare(a, b, criteria)     A/B comparison of two URLs (incl. blind mode)
```

Each returns a strict JSON Schema response with cost / screenshot / DOM envelope. Composable. Cacheable. Auditable. Each call writes per-run artefacts (screenshot, DOM dump, payload, response) so the AI's behaviour is replayable and reviewable.

You give an AI agent these five verbs, and suddenly it can:

- Verify a UI change actually looks right after a deployment
- Test whether OAuth signin still works after a config change
- Check that the Japanese translation didn't leak English strings
- Compare two SaaS pricing pages to extract competitive intel
- Walk through a real signup flow and judge whether the first-action UX is obvious in 10 seconds
- Catch dark patterns before they ship to customers

## Why MCP-first matters

The [Model Context Protocol](https://modelcontextprotocol.io) is what makes this work. MCP became a Linux Foundation project in December 2025 and shipped OAuth 2.1 + Tasks primitive in 2026 Q2. By H2 2026 it's a checkbox feature in every AI tool.

PixelCheck speaks MCP natively — no proxy server, no glue code, no SaaS sign-up. Drop the binary in, point your `~/.mcp.json` at it, and your agent (Claude Code, Cursor, Cline, Continue, Zed, Claude Desktop) gets 17 tools instantly.

```bash
npm install -g pixelcheck
pixelcheck doctor                # 8-check environment health
pixelcheck-mcp                   # start MCP server (stdio transport)
```

```jsonc
// ~/.mcp.json
{
  "mcpServers": {
    "pixelcheck": {
      "command": "pixelcheck-mcp",
      "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
    }
  }
}
```

That's it. Your agent has eyes.

## Why local-first + vendor-agnostic

Two design choices I made early and would not compromise on:

**Local-first.** PixelCheck runs entirely on your machine. The only outbound call is to the LLM provider you point your agent at. No telemetry. No remote storage. No SaaS sign-up. Your screenshots, your DOMs, your business flows stay on your laptop. (See [PRIVACY.md](../PRIVACY.md) for the full data-flow disclosure.)

**Vendor-agnostic.** PixelCheck doesn't lock you into a model provider. The MCP server is provider-neutral — your agent decides which LLM to use. Multi-provider abstraction (OpenAI, Gemini, Ollama as primary) is on the v1.x roadmap. The reason is simple: AI agents in 2026 are best-of-breed multi-model systems, and tools that lock you to one provider die.

This is the inverse of where most "AI browser" SaaS is going. They're cloud-only, model-locked, and require credit cards. PixelCheck is a single npm package you install, run, and own.

## What's actually in the box (v1.0)

This is not vapor. The v1.0 ship gate has hard numbers:

- **5 primitives** + 17 MCP tools, each with strict JSON Schema responses (30 published schemas, dual Ajv + Zod validation)
- **5-layer reliability stack** lifting Stagehand's ~75% baseline to 98-99% step success: Stability Gate → LLM Rewrite → Selector Hint → Auto Selector Discovery → Computer Use
- **9 anti-detection fingerprints + 15 stealth patches** so your audits look like real users, not bot-flagged Playwright sessions
- **18 personas across 15 countries / 5 script systems** (Latin / CJK / Arabic / Cyrillic / Devanagari) for the audit preset
- **WCAG 2.1 / 2.2 compliance** via integrated axe-core (`assert_a11y` step + 50+ Success Criteria mapped)
- **Cross-session memory** + SQLite plan cache (60-80% hit rate on repeat audits, 30-day TTL)
- **Cost guard** with per-run + per-day USD caps + cross-process advisory lockfile
- **Audit explorer SPA** — single-file HTML report, no build step, no runtime deps, opens behind any firewall
- **Cost-tier modes**: `economy` (Haiku only), `balanced` (Haiku primary + Sonnet escalation, 3-5x cheaper), `max` (always Sonnet)
- **Public API stability**: 67 named exports + 30 published schemas snapshotted; SemVer-locked
- **1853 unit tests + 22 Playwright e2e + 2 integration tests**, coverage 81 / 69 / 81 / 82
- **28 Architecture Decision Records** explaining every design choice
- **CI workflows**: 7 GitHub Actions (CI / coverage / integration / bench / SBOM / dogfood / post-deploy-audit)

## What "real users review your product" looks like (the audit preset)

PixelCheck includes a CLI-first audit preset on top of the primitives — what was the original v0.x scope. It launches real Chromium browsers as 18 different users from 15 countries, walks through your scenarios, and delivers a verdict.

Each persona is a full identity, not just a viewport:

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

```bash
pixelcheck init projects/my-app --name "My App" --url "https://myapp.com"
pixelcheck run --project projects/my-app
```

Output: `audit.json` + `audit.html` (dark-theme dashboard) + `audit.pdf` (stakeholder report) + `audit.sarif` (GitHub Code Scanning) + per-step screenshots + video + HAR + console log.

For CI integration, exit codes `0`/`1`/`2` map to pass/fail/warn. Drop into a GitHub Action with `npx pixelcheck run --min-score 7.0`.

## Why this is different from automation frameworks

The OSS browser-automation landscape is crowded. To be precise:

**This is not browser-use.** browser-use (91k stars) is a Python framework for agents to execute web tasks autonomously. It's brilliant at task completion. PixelCheck is a different layer — primitives that an agent calls to *see and reason about* pages, with strict result schemas and a multi-persona audit preset.

**This is not Stagehand.** Stagehand (22k stars, by Browserbase) is a TypeScript SDK for AI-driven semantic browser actions. We *use* Stagehand internally as one of our reliability layers. Stagehand is your library; PixelCheck is the MCP server above it.

**This is not Skyvern.** Skyvern (21k stars) is a vision-LLM workflow runner with strong form-filling. It's a different shape: workflow-centric, cloud-deployable.

**This is not BrowserOS / Comet / Atlas.** Those are agentic browsers — desktop applications that replace Chrome with an AI-native browser. They're consumer products. PixelCheck is developer infrastructure.

**The differentiation in one line:** No existing OSS combines MCP-first × 5-primitive surface × 18-persona / 15-country simulation × WCAG compliance × stealth fingerprints × historical trend tracking. PixelCheck is the missing layer between AI agents and the visual web.

**And one more thing that matters in 2026:** every alternative above either locks you into a single LLM provider, requires a SaaS sign-up, or has a "Pro" tier behind a credit card. PixelCheck has none of those — MIT license, source-available, no telemetry, no paid edition, no commercial fork, no hosted control plane. The 1853-test repo you see *is* the entire product.

## Cost & control

A common worry with AI tools is runaway cost. PixelCheck has multiple guard rails:

- **Cost-tier modes**: `economy` (Haiku only) is ~3-5x cheaper than `max` (Sonnet only). Default `balanced` uses Haiku primary + Sonnet escalation when confidence drops.
- **Cost guard**: per-run + per-day USD caps in config; refuses to spawn new units when cumulative cost exceeds threshold; cross-process advisory lockfile prevents double-spending.
- **Plan cache**: 60-80% hit rate on repeat runs against the same site (skips Sonnet planning when DOM skeleton matches a cached plan; 7-day TTL).
- **Per-call budgets**: each MCP tool has documented typical-cost ranges; `judge` and `compare` accept a `max_iterations` cap.

A typical full audit (18 personas × 6 scenarios) costs $2-8 in `balanced` mode. A single `see` call: $0.005-0.015.

## What's next (v1.x roadmap)

v1.0 ships with deliberate scope. v1.x is already planned:

- **Wave 2** (30-90 days): Provider abstraction (OpenAI / Gemini / Ollama) · Multi-AI-client compatibility matrix · Public benchmark numbers · MCP public registry submission
- **Wave 3** (90-180 days): Stagehand v3 upgrade · Persona expansion to 30+ countries · A/B context injection · MCP OAuth 2.1 + Tasks primitive · 1M-context multi-step research workflow
- **Wave 4** (180+ days, demand-gated): Mobile native (RN / Flutter / native) · User-flow auto-discovery · Cognitive a11y · Semantic visual diff

## Try it

```bash
npm install -g pixelcheck
pixelcheck doctor
pixelcheck-mcp
```

Or install for a single project:

```bash
npm install pixelcheck --save-dev
npx pixelcheck init projects/my-app --name "My App" --url "https://myapp.com"
npx pixelcheck run --project projects/my-app
```

GitHub: https://github.com/xcodethink/pixelcheck
License: MIT
Docs: README + 13 governance documents (LICENSE / SECURITY / PRIVACY / MIGRATION / CONTRIBUTING / CHANGELOG / FAQ / TROUBLESHOOTING / INSTALLATION / DEPRECATION-POLICY / THIRD_PARTY_LICENSES + ADRs + API ref)

## What I'd love feedback on

If you're building with AI agents and find yourself manually screenshotting your work to show your agent — that's the gap PixelCheck fills. Try the MCP server with your agent and tell me where the seams show.

If you ship a product and get blindsided by post-deploy issues that tests didn't catch — try the audit preset and see if the multi-persona view surfaces things your CI didn't.

If you've been burnt by AI tools that locked you into a single LLM vendor or required cloud upload — try PixelCheck specifically because it does neither.

— Wayne
