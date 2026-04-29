/**
 * Dark-pattern rubric (N-8) — built-in criteria for known deceptive UX
 * patterns.
 *
 * Twelve criteria cover the canonical dark-pattern categories from
 * deceptive.design / Brignull's taxonomy + the Norwegian Consumer
 * Council's 2018 deceived-by-design report. We chose the subset that is
 * (a) reliably visible from a single screenshot + DOM snapshot, and
 * (b) actionable — i.e. fixable without product-team interviews.
 *
 * Scoring convention: higher score = LESS dark pattern. A 10 means
 * "no dark pattern of this kind detected"; a 0 means "egregious
 * instance, blatantly user-hostile". This keeps direction consistent
 * with aesthetic criteria so an aggregate `overall_score` is
 * monotonic.
 */

import type { JudgeCriterionSpec } from "../result-schema.js";

export const DARK_PATTERN_CRITERIA: JudgeCriterionSpec[] = [
  {
    id: "forced_continuity",
    label: "Forced continuity",
    description:
      "Auto-renew or charge after a free trial without prominent disclosure. A 10 means renewal terms appear next to the CTA in the same visual weight; a 0 means renewal terms hidden in 8px footer microcopy.",
    kind: "dark_pattern",
  },
  {
    id: "hidden_costs",
    label: "Hidden costs",
    description:
      "Fees, taxes, or shipping revealed only at checkout or buried in microcopy. A 10 means total cost is shown next to the price; a 0 means a 'starting at $X' price with no disclosure of mandatory add-ons.",
    kind: "dark_pattern",
  },
  {
    id: "preselected_options",
    label: "Pre-selected options",
    description:
      "Add-ons / upsells / mailing-list opt-ins pre-checked by default. A 10 means defaults are user-favourable (opt-in for paid extras); a 0 means costly defaults the user must hunt to disable.",
    kind: "dark_pattern",
  },
  {
    id: "fake_urgency",
    label: "Fake urgency / scarcity",
    description:
      "'Only 2 left!', countdown timers, or 'X people viewing' that are unverifiable or contrived. A 10 means no urgency claims OR claims tied to verifiable inventory; a 0 means a manipulative ticking timer with no real deadline.",
    kind: "dark_pattern",
  },
  {
    id: "confirmshaming",
    label: "Confirmshaming",
    description:
      "Decline / cancel buttons worded to shame the user ('No, I don't want to save money'). A 10 means neutral wording on both choices; a 0 means guilt-tripping decline buttons.",
    kind: "dark_pattern",
  },
  {
    id: "obstruction",
    label: "Obstruction (roach motel)",
    description:
      "Easy to sign up but hard to cancel / unsubscribe / delete account. A 10 means symmetric flow visibility; a 0 means cancel buried under 5+ navigations or behind support email only.",
    kind: "dark_pattern",
  },
  {
    id: "misdirection",
    label: "Misdirection",
    description:
      "Visual emphasis steers users toward the seller-favourable choice (large green Accept vs tiny grey Decline). A 10 means decline is equally discoverable; a 0 means decline is camouflaged or below-the-fold.",
    kind: "dark_pattern",
  },
  {
    id: "trick_questions",
    label: "Trick questions",
    description:
      "Double negatives, opt-in/opt-out wording inverted from convention, or ambiguous checkbox labels. A 10 means wording is unambiguous; a 0 means a checkbox where 'check to opt out' inverts user expectation.",
    kind: "dark_pattern",
  },
  {
    id: "disguised_ads",
    label: "Disguised ads",
    description:
      "Sponsored content presented as editorial / system UI. A 10 means clear 'Ad' / 'Sponsored' labels; a 0 means ads styled identically to organic content with no marker.",
    kind: "dark_pattern",
  },
  {
    id: "bait_and_switch",
    label: "Bait and switch",
    description:
      "CTA text promises one outcome but the action delivers another (e.g. 'Save now' triggers a paid upgrade flow). A 10 means CTA text and behaviour match; a 0 means deceptive CTA copy.",
    kind: "dark_pattern",
  },
  {
    id: "privacy_zuckering",
    label: "Privacy zuckering",
    description:
      "Default settings share more personal data than necessary; opt-outs require navigating multiple screens. A 10 means privacy-favourable defaults are visible on this surface; a 0 means consent banner with all toggles pre-enabled and 'Reject all' hidden behind 'Customize'.",
    kind: "dark_pattern",
  },
  {
    id: "nagging",
    label: "Nagging",
    description:
      "Repeated interruptions to push a behaviour after the user has already declined (e.g. 'Are you sure? Subscribe now' modals). A 10 means a single ask, one decline = silence; a 0 means persistent overlays despite prior dismissal.",
    kind: "dark_pattern",
  },
];
