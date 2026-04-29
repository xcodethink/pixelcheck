/**
 * Aesthetic rubric (N-8) — built-in criteria for general visual / UX
 * polish judgements.
 *
 * Eight criteria cover the dimensions a senior product designer would
 * walk through on a first impression: hierarchy, typography, alignment,
 * contrast, spacing, polish, density, and brand cohesion. Each criterion
 * carries a stable `id` (snake_case) so consumers can join verdicts back
 * to the rubric across multiple runs and across `compare` sides.
 *
 * The benchmarks named in the rubric (Stripe / Linear / Vercel / Notion)
 * deliberately mirror the bar already encoded in `runCritic` for parity
 * — but here the criteria are *rubric-scoped*, not persona-scoped, which
 * lets the same engine be applied to any URL without scenario YAML.
 */

import type { JudgeCriterionSpec } from "../result-schema.js";

export const AESTHETIC_CRITERIA: JudgeCriterionSpec[] = [
  {
    id: "visual_hierarchy",
    label: "Visual hierarchy",
    description:
      "Does the layout direct the eye through a clear primary action and supporting context? A 10 means a Stripe-quality primary CTA dominates without crowding; a 5 means competing CTAs dilute the path.",
    kind: "aesthetic",
  },
  {
    id: "typography",
    label: "Typography",
    description:
      "Font choice, size scale, weight contrast, line height, and tracking. A 10 means a coherent type ramp like Linear's; a 5 means inconsistent weights or readability problems at body sizes.",
    kind: "aesthetic",
  },
  {
    id: "alignment_grid",
    label: "Alignment & grid",
    description:
      "Edges align across columns, sections share a baseline, and rhythm feels intentional. A 10 means Vercel-level grid discipline; a 5 means visible drift between sections.",
    kind: "aesthetic",
  },
  {
    id: "color_contrast",
    label: "Color & contrast",
    description:
      "Palette discipline, semantic colour use (success / warn / error), and WCAG-level contrast on body and CTA text. A 10 means a refined palette with strong contrast; a 5 means too many accent colours or low-contrast body copy.",
    kind: "aesthetic",
  },
  {
    id: "spacing_rhythm",
    label: "Spacing & rhythm",
    description:
      "Consistent inner padding, vertical rhythm between sections, and uncrowded touch targets. A 10 means Notion-quality whitespace; a 5 means cramped components or jarring section transitions.",
    kind: "aesthetic",
  },
  {
    id: "polish",
    label: "Polish & finish",
    description:
      "Micro-details — corner radius consistency, shadow / elevation intent, hover/focus affordance, icon stroke parity. A 10 means commercial-grade polish; a 5 means visible mismatches or amateurish details.",
    kind: "aesthetic",
  },
  {
    id: "information_density",
    label: "Information density",
    description:
      "Right amount of information for the page's job — not so sparse it feels empty, not so dense it overwhelms. A 10 means scannable in 5 s; a 5 means user must fight to find the next step.",
    kind: "aesthetic",
  },
  {
    id: "brand_cohesion",
    label: "Brand cohesion",
    description:
      "Voice, illustration style, and component library feel like one product. A 10 means every surface reads as the same brand; a 5 means clashing visual languages between hero, body, and footer.",
    kind: "aesthetic",
  },
];
