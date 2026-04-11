# Writing personas

A persona is a YAML file in `personas/` describing a synthetic user identity. The auditor uses it to:

1. Pick a stealth fingerprint (device + UA + WebGL etc)
2. Configure browser locale, timezone, viewport, language, proxy
3. Inform the vision critic's perspective ("evaluate from this user's viewpoint")
4. Filter which scenarios apply (a Power-tier-only scenario excludes Free personas)

## Schema

```yaml
id: jp-japanese-pro-desktop                  # required, kebab-case, unique
display_name: 田中花子 (35, 東京, 主婦)        # required, human-readable
country: JP                                  # required, ISO 3166-1 alpha-2
language: 日本語                             # required, the language NAME for prompts
locale: ja-JP                                # required, BCP-47
timezone: Asia/Tokyo                         # required, IANA tz
device_class: desktop                        # required: desktop | tablet | mobile
ua_class: macbook                            # optional: macbook | windows | ipad | android-tablet | iphone | android
                                             #   if absent, a random profile from device_class is picked
viewport:                                    # optional, override fingerprint default
  width: 1440
  height: 900
payment_tier: pro                            # required: free | pro | max | power
proxy_env: PROXY_JP                          # optional, name of env var holding proxy URL
mental_model: |                              # required, multi-line; fed to the vision critic
  35-year-old housewife in Tokyo. Suspicious of crypto scams after a friend
  was defrauded. Limited English. Expects Japanese-only experience. Will pay
  for Pro if value is clear but won't tolerate marketing fluff.
critical_concerns:                           # required, list of language-/region-specific concerns
  - All text must be in 日本語
  - Crypto jargon must come with Japanese explanations
  - Prices should display in JPY
test_credentials:                            # optional, all values support ${ENV_VAR}
  google_account: ${TEST_GOOGLE_JP}
  google_password: ${TEST_GOOGLE_JP_PASSWORD}
```

## Best practices

### 1. Make personas distinct, not redundant

If you can't articulate what's *unique* about a persona, you don't need it. Each persona should test a dimension nothing else does:

| Persona | Tests |
|---|---|
| `us-english-free-mobile` | Default mobile UX, free→pro funnel |
| `jp-japanese-pro-desktop` | Asian language, paid tier, desktop polish |
| `de-german-power-tablet` | EU compliance (GDPR), highest tier, tablet landscape |
| `cn-chinese-free-mobile` | Simplified Chinese (not Traditional), Android, slow network |
| `br-portuguese-free-desktop` | LatAm Portuguese, smaller market, regional features |
| `sa-arabic-pro-mobile` | RTL layout (the highest-risk localization vector) |

### 2. Mental model is the most important field

The vision critic is told to "evaluate from the perspective of {mental_model}". A vague model gives vague scores. Be specific:

- **Bad**: "A user wanting to check scams"
- **Good**: "32-year-old NYC paralegal, paranoid after a family member was defrauded, will not pay before seeing free-tier value, mobile-first iPhone user, expects trust signals above the fold"

### 3. critical_concerns drives issue severity

The critic uses these as a checklist. When it finds violations, they become issues. List the things you actually care about for that persona, not generic SaaS truisms.

### 4. proxy_env is opt-in

For most local development, leave it absent. For production audits where you want to validate region-specific content, set it:

```bash
PROXY_JP=http://user:pass@japan-proxy.example.com:8080
```

The persona then uses that proxy. The `--dry-run` will not validate the proxy reachable; the actual run will fail loudly if it's down.

### 5. test_credentials should reference env vars

Never hardcode credentials in YAML. Use `${TEST_GOOGLE_JP}` style placeholders that resolve from `process.env` at runtime. The auditor's secrets layer auto-redacts these from reports.

## Adding a new persona

```bash
cp personas/us-english-free-mobile.yaml personas/in-hindi-free-mobile.yaml
$EDITOR personas/in-hindi-free-mobile.yaml
# Update id, display_name, locale, timezone, mental_model, critical_concerns

# Verify it loads
npm run audit -- --dry-run --persona in-hindi-free-mobile
```

If you want it to run any scenario, add its id to that scenario's `applies_to.personas` list.
