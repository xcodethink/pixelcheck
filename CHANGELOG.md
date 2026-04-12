# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-04-11

### Fixed

- Vision audit pipeline hardened: 3 root-cause framework bugs resolved
  - Critic scoring no longer fails silently when screenshot capture times out
  - Recorder correctly handles concurrent video + HAR streams without race condition
  - Reporter gracefully degrades when partial step data is missing

## [0.1.0] - 2026-04-11

### Added

- **Core engine**: Stagehand 2.0 + Claude vision hybrid execution pipeline
- **6 personas**: US/JP/DE/CN/BR/SA spanning mobile/desktop/tablet, Free/Pro/Power tiers
- **9 scenarios**: infra smoke, OAuth signup, domain check, admin audit, localization sweep, crypto trace, investigation v2, email opt-in, Chrome extension
- **Claude vision critic**: 5-dimension scoring (completion, localization, visual_polish, trust_signals, time_to_value)
- **Computer Use escalation**: Playwright-backed pixel-level review for critical steps
- **Recording**: video (WebM), HAR network log, console errors, SHA-256 hashed screenshots
- **Reporting**: JSON (machine) + HTML (dark theme dashboard) + Markdown (terminal)
- **Concurrency control**: parallel persona x scenario matrix with same-origin throttling via p-limit
- **Budget cap**: stops new audit units when cumulative LLM cost exceeds threshold
- **Retry strategies**: per-step exponential backoff with fingerprint rotation fallback
- **Visual regression**: odiff-bin pixel diff with baseline management
- **Email verification**: mail.tm temporary inbox integration for signup flows
- **Notifications**: Slack webhook + Telegram bot on completion
- **CI workflow**: GitHub Actions post-deploy-audit.yml (artifact upload, PR comment, exit codes)
- **Stripe safety**: refuses to start if `pk_live_` keys detected in env
- **Documentation**: architecture guide, scenario authoring guide, persona design guide, CI integration guide

[0.1.1]: https://github.com/xcodethink/ai-browser-auditor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xcodethink/ai-browser-auditor/releases/tag/v0.1.0
