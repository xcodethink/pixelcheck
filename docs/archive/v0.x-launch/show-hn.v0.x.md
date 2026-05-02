# Show HN: AI Browser Auditor -- launches real browsers as 18 personas to audit your product

HN Title:
> Show HN: AI Browser Auditor -- 18 personas from 15 countries audit your site after every deploy

---

HN Comment (first reply, post within 1 min of submission):

---

Hey HN, I built this because my SaaS kept breaking for international users even though CI was always green.

**What it does:** Launches real Chromium browsers as 18 different personas (Japanese housewife, Nigerian entrepreneur, 72-year-old US retiree, Saudi businessman with RTL Arabic...), walks through your product flows, and uses Claude Vision + axe-core to score the experience across 18 dimensions.

**The core insight:** E2E tests verify code works. They don't verify the product works for real humans. A Japanese user seeing half-English strings, an Arabic user with mirrored RTL layout, a budget Android user waiting 12s for your hero image — no Playwright assertion catches these.

**Tech:**
- Stagehand 2.0 for semantic browser automation ("click sign-up" not "click #btn-37")
- 5-layer reliability stack to hit 98%+ success rate (page stability gate -> Haiku instruction rewrite -> auto selector discovery -> Computer Use fallback)
- Claude Vision scores completion, localization, visual polish, trust signals, accessibility
- axe-core for WCAG compliance (complements what vision can't catch)
- SQLite history tracking with trend charts and run-to-run diffs
- 15 anti-detection patches so your site renders as it would for real users, not bots

**Honest caveats:**
- Full 18-persona audit costs $80-300 in API fees (in practice you'd run 3-5 personas per deploy)
- 98-99% reliability is the design target, still validating across more production sites
- Claude-only for now; multi-model support planned
- v0.2.0 -- core is solid, ecosystem is young

Repo: https://github.com/xcodethink/ai-browser-auditor

Quick start:
```
npm install ai-browser-auditor
npx ai-audit init my-app --url "https://your-site.com"
npx ai-audit run --project my-app
```

Happy to answer questions about the architecture, reliability stack, or the persona design. MIT licensed, contributions welcome -- especially personas for underrepresented regions.
