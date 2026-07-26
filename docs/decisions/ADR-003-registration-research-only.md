# ADR-003 — Registration capability is research-only

- **Status**: Accepted
- **Date**: 2026-04-25
- **Builds on**: [ADR-001 — AI-first positioning](./ADR-001-AI-first-positioning.md)

## Context

Once ADR-001 fixed the AI-first positioning, v1 necessarily has to support "the
agent signs up for an account on a third-party site" (the `register(service,
profile)` primitive). The legitimate uses are real:

- Evaluating whether a SaaS signup flow is smooth.
- Writing a competitive report, which requires actually experiencing the
  product.
- Assessing a product on a user's behalf — register once, then look at what it
  actually does.
- Testing code the agent just wrote, by exercising the full user path.

The same capability, abused, enables bulk fake registration, automated
promo/referral farming, mass identity creation behind anti-fraud systems, and
violation of third-party terms of service, which almost universally prohibit
automated signup. The boundary has to be drawn during capability design, not
left to user discretion.

## Decision

**The register primitive supports research-style registration only, and is
constrained so that bulk registration is not expressible.**

1. **One call is one deliberate signup.**
   `service` and `profile` must be given explicitly; no batch parameter exists,
   and no "register N times" loop is provided.

2. **The test identity pool exists to avoid polluting a real account, not to
   fabricate people.**
   Pool entries are the operator's own spare accounts. The tool does not
   generate fictitious identities (invented names, phone numbers, addresses) and
   does not integrate with SMS-verification resale services or virtual number
   providers.

3. **Rate limits, enforced inside the primitive:**
   - Same service, same identity: at most 1 signup per 24 hours.
   - Same service, across identities: at most 5 per 24 hours — enough to study a
     flow, not enough to farm it.
   - Global: at most 50 register calls per instance per 24 hours.

   These are hard-coded rather than exposed as configuration, so they cannot be
   raised from a config file.

4. **Mandatory logging.**
   Every call is written to the local audit log with timestamp, target service,
   which identity was used, success or failure, and the caller (agent or CLI).
   This cannot be disabled.

5. **Mandatory risk disclosure.**
   The README states prominently that registration is for research. The CLI and
   MCP paths print a warning on every call: research use only, bulk registration
   and abuse are prohibited, and the caller accepts the risk of violating
   third-party terms. First use requires explicit opt-in via
   `PIXELCHECK_AGREE_REGISTER_TOS=1`.

6. **Explicitly out of scope, and rejected in review:**
   SMS-verification service integration, automated captcha bypass, bulk
   registration scripts or commands, fabricated identity generation, and large
   proxy-IP pools.

## Consequences

### Positive

- Legal and compliance exposure drops substantially, because abuse is
  unexpressible by design rather than merely discouraged.
- An OSS release is unlikely to be labelled an abuse tool, which matters for
  community reception.
- Compatible with the acceptable-use policies of GitHub, npm and the major
  distribution platforms.
- Gives team and company users something defensible to point at in an enterprise
  environment.

### Negative

- Deliberately forgoes the grey-market segment.
- Rate limits can catch legitimate dense research — evaluating 100 SaaS products
  in one sitting, for example. Mitigated by documenting a batched approach.
- Signup may simply fail against aggressive anti-bot defences. The tool reports
  that the site requires manual assistance rather than attempting to bypass it.

### Neutral

- This is an engineering safety boundary, not legal advice.
- A fork can remove the limits; that is inherent to OSS, and the upstream
  project does not carry that.

## Alternatives considered

**A. Omit register entirely and let callers compose it out of `act`.**
Rejected — composing a signup flow from raw actions is expensive per call, and
it leaves no single place to enforce abuse limits.

**B. Implement register with no constraints.**
Rejected — high legal and compliance exposure, and it would not survive OSS
distribution review.

**C. Ship register only in an enterprise edition.**
Rejected — under the AI-first positioning register is a core capability, and
withholding it degrades the whole proposition.

## Implementation notes

```typescript
// Required interface
async register(opts: {
  service: string;          // target service URL
  profile: TestIdentity;    // from the test identity pool
  intent: string;           // research intent, required, written to the audit log
  agree_to_tos: boolean;    // must be true to proceed
}): Promise<RegisterResult>

// Enforced internally
if (!opts.agree_to_tos) throw new Error("Must accept registration ToS warning");
if (await rateLimitExceeded(...)) throw new Error("Rate limit: research-only mode");
await auditLog.write({ action: 'register', ... });
```

## References

- ADR-001 — [AI-first positioning](./ADR-001-AI-first-positioning.md)
