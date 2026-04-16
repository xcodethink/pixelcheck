# Scenario Recorder

Chrome extension (Manifest V3) that records your clicks, form fills, and
navigations on any page and exports them as an AI Browser Auditor scenario
YAML. Drops the scenario-authoring time from minutes to seconds.

## Install (unpacked / dev mode)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Choose the `extensions/scenario-recorder/` directory

The extension icon appears in the toolbar. Pin it for easy access.

## Usage

1. Click the extension icon
2. Fill in **Scenario id**, **Goal / intent**, and **Persona id**
3. Click **Start** — recording begins
4. Navigate your app: click, fill forms, submit, follow links
5. Click **Stop** when the flow is done
6. Click **Export YAML** — downloads `{scenario_id}.yaml`
7. Move the file to your project's `scenarios/` directory
8. Run: `ai-audit run --scenario {scenario_id}`

## What it captures

| Event | Captured as |
|---|---|
| Navigation / first visit | `visit` step |
| Click on link / button / anything | `act` step with natural-language instruction + `selector_hint` |
| Form field change | `act` step "Type ... into the ... field" + `selector_hint` |
| Form submit | `act` step "Submit the form" |
| Enter / Escape key | `act` step "Press Enter" |

A final `assert_visual` step is auto-appended so the scenario actually
scores the resulting page.

## Selector priority

The recorder derives a selector for every action in this order:

1. `[data-testid="…"]` — if present (most stable; test-tool convention)
2. `#id` — if the id is short + looks stable (no long digit runs)
3. `[aria-label="…"]`
4. `tag:has-text("…")` — text-based fallback
5. `parentTag > tag:nth-child(n)` — last resort

The selectors are included as `selector_hint` on each step, feeding the
auditor's 5-layer reliability stack (Layer 3). The agent still drives via
natural-language instructions; hints are a fallback.

## Privacy

- **Password fields are never recorded.** The content script explicitly
  ignores any `<input type="password">` change event.
- **Long input values are truncated** to 40 characters in storage.
- **Nothing leaves your browser.** The extension uses `chrome.storage.local`
  only — no background fetches, no analytics.

## Known limitations

- Dynamic SPAs with heavy virtual-DOM churn may produce noisy selectors;
  prefer `data-testid` on interactive elements.
- Iframes are not currently recorded (main-frame only).
- File uploads are captured as clicks; the actual uploaded file is not
  persisted (by design — large / sensitive).

## Relationship to `recorder-core.ts`

The authoritative compile logic lives at
`extensions/scenario-recorder/src/recorder-core.ts` and is covered by
`tests/recorder-core.test.ts` (round-tripped through the auditor's
`ScenarioSchema`). The `popup.js` inlines a simplified version so the
extension runs without a bundler — when changing either, keep the two
in sync or run a build step.
