/**
 * Soul slug translation between the canonical (SkillHub / CN) namespace and the
 * westernized English namespace.
 *
 * Why this exists: the international (EN) personas were renamed (YYDS → GOAT,
 * HHHH → LOL, …) while the CN catalog keeps the original slugs. Drawn cards are
 * persisted by slug, so a card drawn as "GOAT" under EN must resolve back to the
 * "YYDS" entry when the user switches to ZH (and vice-versa). This module is the
 * single source of truth for that mapping.
 *
 * The 6 personas whose slugs are identical in both namespaces (OH-NO, WHY,
 * MONK, SOLO, LOVE-R, ZZZZ) map to themselves.
 */

/** Canonical (CN / SkillHub) slug → westernized EN slug. */
const CANONICAL_TO_ENGLISH: Record<string, string> = {
  YYDS: "GOAT",
  HHHH: "LOL",
  MIAO: "MEOW",
  "OH-NO": "OH-NO",
  WHY: "WHY",
  GRASS: "NO-FILTER",
  MONK: "MONK",
  MUM: "MOMMY",
  SOLO: "SOLO",
  GOOD: "STEADY",
  MALO: "LIVEWIRE",
  FAKE: "CHAMELEON",
  "LOVE-R": "LOVE-R",
  ZZZZ: "ZZZZ",
  "WORK-er": "GRINDER",
  GOGO: "GO-MODE",
};

/** Westernized EN slug → canonical (CN / SkillHub) slug. */
const ENGLISH_TO_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TO_ENGLISH).map(([canonical, english]) => [english, canonical]),
);

/**
 * Normalize an arbitrary soul slug to its westernized EN slug.
 * Falls back to the input slug when no mapping is known (e.g. already-EN slug,
 * or a slug introduced after this table was last updated).
 */
export function toEnglishSlug(slug: string): string {
  // Already an EN slug?
  if (ENGLISH_TO_CANONICAL[slug]) return slug;
  // Canonical slug → EN.
  return CANONICAL_TO_ENGLISH[slug] ?? slug;
}

/**
 * Normalize an arbitrary soul slug to its canonical (CN / SkillHub) slug.
 * Falls back to the input slug when no mapping is known.
 */
export function toCanonicalSlug(slug: string): string {
  // Already canonical?
  if (CANONICAL_TO_ENGLISH[slug]) return slug;
  // EN slug → canonical.
  return ENGLISH_TO_CANONICAL[slug] ?? slug;
}
