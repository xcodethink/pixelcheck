# Third-Party Licenses

`pixelcheck` is licensed under **MIT** (see [LICENSE](../LICENSE)).

This document discloses the licenses of all third-party dependencies bundled
or installed transitively when you `npm install pixelcheck`. The
information below was generated from `license-checker --production` against
the v1.0.0 dependency tree and updated whenever dependencies change.

## Summary

| License | Count |
|---|---|
| MIT | 213 |
| Apache-2.0 | 34 |
| BSD-3-Clause | 19 |
| ISC | 13 |
| BSD-2-Clause | 3 |
| MPL-2.0 | 1 |
| LGPL-3.0-or-later | 1 (binary only — see § Notable Notes) |
| Other permissive (Unlicense, MIT-or-WTFPL, AFL-2.1-or-BSD-3-Clause) | 4 |
| **Total** | **288 packages** |

**Zero GPL / AGPL / SSPL contamination.** All licenses are compatible with
permissive commercial redistribution under MIT.

---

## Notable Notes

### libvips (LGPL-3.0-or-later) — bundled by sharp

`@img/sharp-libvips-<platform>-<arch>@1.2.4` ships a prebuilt **libvips**
binary licensed under **LGPL-3.0-or-later**. The package
`sharp@^0.34.5` itself is Apache-2.0 and dynamically links to libvips at
runtime.

**Compatibility with our MIT distribution**:
- LGPL allows dynamic linking from non-LGPL code without copyleft
  contamination (the LGPL "linking exception").
- We do **not** bundle libvips source into `pixelcheck`. The
  binary is pulled from a separate npm package
  (`@img/sharp-libvips-<platform>-<arch>`) at user's `npm install` time.
- LGPL requires that we (a) disclose the library, (b) provide upstream
  source location, (c) allow users to relink with a modified version.
  This document satisfies (a) and (b); (c) is satisfied automatically
  because users can replace libvips by uninstalling sharp and providing
  their own.

**libvips source**:
- Upstream: https://github.com/libvips/libvips
- License text: https://github.com/libvips/libvips/blob/master/COPYING

### Chromium (mixed BSD + LGPL components) — bundled by playwright

`playwright@^1.49.0` is **Apache-2.0**, but it downloads **Chromium**
binaries as part of its postinstall script. Chromium contains code under
multiple licenses:

- Most code: BSD-3-Clause
- Some components: LGPL-2.1, MPL-2.0, MIT, ISC

**Compatibility**:
- We do not redistribute Chromium binaries with `pixelcheck`. They
  are pulled by Playwright's own postinstall flow.
- Users who run `npx playwright install chromium` accept Google's
  Chromium license terms directly.

**Chromium source + license**:
- Upstream: https://chromium.googlesource.com/chromium/src
- License: https://chromium.googlesource.com/chromium/src/+/main/LICENSE

### axe-core (MPL-2.0)

`axe-core@^4.11.2` is **Mozilla Public License 2.0**. MPL is "weak
copyleft" — only files licensed under MPL must remain MPL when modified
and redistributed. **Using axe-core as a runtime dependency from our MIT
code does not infect our code with MPL**.

**Source**:
- Upstream: https://github.com/dequelabs/axe-core
- License text: https://github.com/dequelabs/axe-core/blob/develop/LICENSE

### Anthropic SDK (Apache-2.0)

`@anthropic-ai/sdk@^0.92.0` is **Apache-2.0**. No special concerns;
Apache-2.0 is fully compatible with MIT redistribution.

### Stagehand (MIT)

`@browserbasehq/stagehand@^2.0.0` is **MIT**. No special concerns.

### Other non-MIT packages (verified safe)

| Package | License | Note |
|---|---|---|
| `@browserbasehq/sdk@2.10.0` | Apache-2.0 (LICENSE file; package.json metadata missing — license-checker reports as `Apache*`) | Verified Apache-2.0 by inspection |
| `expand-template@2.0.3` | MIT or WTFPL | We elect MIT |
| `fetch-cookie@3.2.0` | Unlicense | Public domain |
| `json-schema@0.4.0` | AFL-2.1 or BSD-3-Clause | We elect BSD-3-Clause |

---

## First-Party Vendored Code

`license-checker` only sees packages in `node_modules`, so it cannot see
source that is **vendored** directly into `pixelcheck`'s own tree. One such
copy exists and is disclosed here for completeness:

### stealth-core (`src/vendor/stealth-core/`)

| Field | Value |
|---|---|
| What | First-party anti-detection / fingerprint helper, vendored verbatim |
| Origin | `@xcodethink/stealth-core` — private, same owner as this repo |
| License | **MIT** (same owner / same terms as pixelcheck) |
| Why vendored | Publishing an anti-bot-detection library publicly would let detection vendors fingerprint-match its profiles — see [ADR-032](decisions/ADR-032-vendor-stealth-core.md) |
| Provenance + version pin | [`src/vendor/stealth-core/PROVENANCE.md`](../src/vendor/stealth-core/PROVENANCE.md) + [`integrity.json`](../src/vendor/stealth-core/integrity.json) |
| Integrity gate | `npm run check:vendor-integrity` (CI-enforced SHA-256 manifest) |

Because the vendored library and pixelcheck share one owner and one MIT
license, there is **no third-party copyleft obligation** introduced by it.

---

## Updating This Document

Run `npx license-checker --production --csv --out docs/third-party-licenses.csv` to regenerate the raw inventory. This document is updated when:

- Major dependencies are upgraded (e.g., Stagehand v3 in v1.1)
- A new direct dependency is added
- A license-checker CI run flags a license that wasn't previously catalogued

CI gate (T28 task) enforces:
```bash
npx license-checker --production \
  --onlyAllow "MIT;Apache-2.0;ISC;BSD-2-Clause;BSD-3-Clause;BSD;MPL-2.0;LGPL-3.0-or-later;Unlicense;CC-BY-3.0;CC-BY-4.0;CC0-1.0;0BSD;Apache*;(MIT OR WTFPL);(AFL-2.1 OR BSD-3-Clause);(BSD-2-Clause OR MIT OR Apache-2.0)"
```

Any new license that doesn't fall in this allowlist must be reviewed manually
and either (a) approved + added to the allowlist, or (b) rejected (the
package must be replaced).

---

## License Texts

The full text of each license is available in the corresponding npm package's
`LICENSE` file (`node_modules/<pkg>/LICENSE`) after `npm install`.

For audit purposes, the complete machine-readable inventory (288 packages
with name, version, license, homepage, and repository URL) is available at
`docs/third-party-licenses.csv` (regenerated per release).

---

**Last updated**: 2026-05-01 (T0.6 audit)
**Generated by**: `license-checker@^25.x`
**Audit policy**: see [`SECURITY.md`](../SECURITY.md) and [ADR-027 / ADR-028](decisions/) for license + dependency decisions
