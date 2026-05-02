# Show HN: PixelCheck -- MCP server giving AI agents real eyes and hands on the web

HN Title:
> Show HN: PixelCheck -- MCP server giving AI agents real eyes and hands on the web

---

HN Comment (first reply, post within 1 min of submission):

---

Hey HN — my AI agent writes 80% of my frontend, but it can't see what it just built. I was the bridge: screenshot, paste, "fix this", repeat. Sixth time the OAuth flow silently broke, I built PixelCheck to remove that role.

**What it does:** Exposes 5 browser primitives (`see` / `act` / `extract` / `judge` / `compare`) as an MCP server. Drop it in `~/.mcp.json` and your agent (Claude Desktop, Cursor, Cline, Continue, Zed, Claude Code) gets 12 tools that let it actually navigate, see, and operate the visual web. Each call returns a strict JSON Schema response with cost / screenshot / DOM envelope. Composable. Cacheable. Auditable.

**Why MCP-first:** MCP became a Linux Foundation project in Dec 2025. By H2 2026 it's table stakes for AI tooling. PixelCheck speaks it natively -- no proxy server, no glue code, no SaaS sign-up.

**Why local-first + vendor-agnostic:** Runs entirely on your machine. The only outbound call is to whatever LLM your agent uses. No telemetry, no remote storage, no SaaS upload. **MIT license, no paid tier, no "Pro" upgrade path, no commercial fork** — the repo you see is the entire product. The whole thing is a single npm package you install and own.

**Bonus -- 18-persona audit preset:** PixelCheck also bundles a CLI-first audit preset (the original v0.x scope). It launches real Chromium as 18 different personas (Japanese housewife, Nigerian entrepreneur, 72-year-old US retiree, Saudi businessman with RTL Arabic...), walks through your scenarios, and scores the experience on 18 dimensions via Claude Vision + axe-core. The audit is now a preset *composition* of see/act/extract/judge across personas.

**v1.0 numbers:**
- 5 primitives + 12 MCP tools (5 primitives + 2 audit presets + 5 meta), 30 published JSON Schemas (Ajv + Zod dual validation)
- 5-layer reliability stack lifting Stagehand baseline ~75% to 98-99%
- 9 fingerprints + 15 stealth patches
- 18 personas across 17 countries / 6 script systems (Latin / CJK / Arabic / Cyrillic / Devanagari / Thai)
- 1853 unit tests + 22 Playwright e2e + 2 integration; coverage 81/69/81/82
- 33 ADRs documenting design decisions
- 7 GitHub Actions workflows (CI / coverage / integration / bench / SBOM / dogfood / post-deploy-audit)
- Cost-tier modes: economy (Haiku, ~3-5x cheaper) / balanced (default) / max (always Sonnet)

**Honest caveats:**
- Currently Claude-only inside the audit critic; multi-provider abstraction (OpenAI / Gemini / Ollama) is on the v1.x Wave 2 roadmap
- Stagehand v3 upgrade deferred to a dedicated task (ADR-028 documents why)
- A typical full 18-persona audit costs $2-8 in balanced mode; single `see` call is $0.005-0.015
- 18-persona audits are heavy; in practice you'd run 3-5 personas per deploy

Repo: https://github.com/xcodethink/pixelcheck — public, MIT, v1.0.0 tagged 2026-05-02, 33 ADRs in `docs/decisions/` if you want the design rationale.

Quick start:
```
npm install -g pixelcheck
pixelcheck doctor
pixelcheck-mcp                # start MCP server
```

For audit preset:
```
pixelcheck init projects/my-app --url "https://your-site.com"
pixelcheck run --project projects/my-app
```

Happy to answer questions about the MCP integration, the 5-primitive design, the reliability stack, or why I built this against the SaaS-only direction the rest of the agentic browser space is going. MIT licensed, contributions welcome -- especially personas for underrepresented regions and multi-provider critic implementations.
