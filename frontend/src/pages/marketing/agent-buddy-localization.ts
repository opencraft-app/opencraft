import type { SkillHubSoul, SkillHubSoulDetail } from "@/lib/skillhub-api";
import type { SoulSpec } from "@/lib/soul-interpretations";
import { getSoulSpec } from "@/lib/soul-interpretations";
import { ENGLISH_SOULS, getEnglishSoulDetail, getEnglishSoulSpec } from "@/lib/soul-english-data";
import {
  GLOBAL_CHINESE_SOULS,
  getGlobalChineseSoulDetail,
  getGlobalChineseSoulSpec,
} from "@/lib/soul-global-chinese-data";
import {
  INDONESIAN_SOULS,
  getIndonesianSoulDetail,
  getIndonesianSoulSpec,
} from "@/lib/soul-indonesian-data";
import { JAPANESE_SOULS, getJapaneseSoulDetail, getJapaneseSoulSpec } from "@/lib/soul-japanese-data";
import { KOREAN_SOULS, getKoreanSoulDetail, getKoreanSoulSpec } from "@/lib/soul-korean-data";
import { SPANISH_SOULS, getSpanishSoulDetail, getSpanishSoulSpec } from "@/lib/soul-spanish-data";
import { toCanonicalSlug, toEnglishSlug } from "@/lib/soul-slug-mapping";
import {
  PREF_TAGS,
  generatePersonalityProfile,
  personalityQuestions,
  prefQuestions,
  shuffleArray,
  type PrefTag,
  type SoulTestQuestion,
} from "@/pages/marketing/agent-buddy-soul-test-data";
import {
  ENGLISH_PREF_TAG_LABELS,
  buildEnglishQuestions,
  generateEnglishPersonalityProfile,
} from "@/pages/marketing/agent-buddy-soul-test-data.en";
import {
  SPANISH_PREF_TAG_LABELS,
  buildSpanishQuestions,
  generateSpanishPersonalityProfile,
} from "@/pages/marketing/agent-buddy-soul-test-data.es";
import {
  INDONESIAN_PREF_TAG_LABELS,
  buildIndonesianQuestions,
  generateIndonesianPersonalityProfile,
} from "@/pages/marketing/agent-buddy-soul-test-data.id";
import {
  JAPANESE_PREF_TAG_LABELS,
  buildJapaneseQuestions,
  generateJapanesePersonalityProfile,
} from "@/pages/marketing/agent-buddy-soul-test-data.ja";
import {
  KOREAN_PREF_TAG_LABELS,
  buildKoreanQuestions,
  generateKoreanPersonalityProfile,
} from "@/pages/marketing/agent-buddy-soul-test-data.ko";

export type BuddySoulLocale = "domestic-zh" | "global-zh" | "en" | "id" | "es" | "ja" | "ko";
export type BuddyCategory = "high" | "mid" | "low";

export function resolveBuddySoulLocale(globalSite: boolean, language: string): BuddySoulLocale {
  if (!globalSite) return "domestic-zh";
  const normalized = language.toLowerCase();
  if (normalized.startsWith("zh")) return "global-zh";
  if (normalized.startsWith("id")) return "id";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("ko")) return "ko";
  return "en";
}

export function usesEnglishSoulScoring(locale: BuddySoulLocale): boolean {
  return locale !== "domestic-zh" && locale !== "global-zh";
}

export function usesWesternSoulSlugs(locale: BuddySoulLocale): boolean {
  return locale !== "domestic-zh";
}

export function getBuddySoulPool(locale: BuddySoulLocale): SkillHubSoul[] | null {
  switch (locale) {
    case "global-zh": return GLOBAL_CHINESE_SOULS;
    case "en": return ENGLISH_SOULS;
    case "id": return INDONESIAN_SOULS;
    case "es": return SPANISH_SOULS;
    case "ja": return JAPANESE_SOULS;
    case "ko": return KOREAN_SOULS;
    case "domestic-zh": return null;
  }
}

export function getBuddySoulSpec(locale: BuddySoulLocale, slug: string): SoulSpec | null {
  const westernSlug = toEnglishSlug(slug);
  switch (locale) {
    case "global-zh": return getGlobalChineseSoulSpec(westernSlug);
    case "en": return getEnglishSoulSpec(westernSlug);
    case "id": return getIndonesianSoulSpec(westernSlug);
    case "es": return getSpanishSoulSpec(westernSlug);
    case "ja": return getJapaneseSoulSpec(westernSlug);
    case "ko": return getKoreanSoulSpec(westernSlug);
    case "domestic-zh": return getSoulSpec(toCanonicalSlug(slug));
  }
}

export function getBuddySoulDetail(locale: BuddySoulLocale, slug: string): SkillHubSoulDetail | null {
  const westernSlug = toEnglishSlug(slug);
  switch (locale) {
    case "global-zh": return getGlobalChineseSoulDetail(westernSlug);
    case "en": return getEnglishSoulDetail(westernSlug);
    case "id": return getIndonesianSoulDetail(westernSlug);
    case "es": return getSpanishSoulDetail(westernSlug);
    case "ja": return getJapaneseSoulDetail(westernSlug);
    case "ko": return getKoreanSoulDetail(westernSlug);
    case "domestic-zh": return null;
  }
}

export function buildBuddyQuestions(locale: BuddySoulLocale): SoulTestQuestion[] {
  switch (locale) {
    case "en": return buildEnglishQuestions();
    case "id": return buildIndonesianQuestions();
    case "es": return buildSpanishQuestions();
    case "ja": return buildJapaneseQuestions();
    case "ko": return buildKoreanQuestions();
    case "domestic-zh":
    case "global-zh":
      return [...shuffleArray(personalityQuestions), ...shuffleArray(prefQuestions)];
  }
}

export function generateBuddyPersonalityProfile(
  locale: BuddySoulLocale,
  answers: Record<string, string>,
): string {
  switch (locale) {
    case "en": return generateEnglishPersonalityProfile(answers);
    case "id": return generateIndonesianPersonalityProfile(answers);
    case "es": return generateSpanishPersonalityProfile(answers);
    case "ja": return generateJapanesePersonalityProfile(answers);
    case "ko": return generateKoreanPersonalityProfile(answers);
    case "domestic-zh":
    case "global-zh":
      return generatePersonalityProfile(answers);
  }
}

export function getBuddyPrefTagLabel(locale: BuddySoulLocale, tag: PrefTag): string {
  switch (locale) {
    case "en": return ENGLISH_PREF_TAG_LABELS[tag];
    case "id": return INDONESIAN_PREF_TAG_LABELS[tag];
    case "es": return SPANISH_PREF_TAG_LABELS[tag];
    case "ja": return JAPANESE_PREF_TAG_LABELS[tag];
    case "ko": return KOREAN_PREF_TAG_LABELS[tag];
    case "domestic-zh":
    case "global-zh":
      return tag;
  }
}

export function getBuddyCategoryLabel(locale: BuddySoulLocale, category: BuddyCategory): string {
  if (locale === "es") {
    if (category === "high") return "Alto";
    if (category === "mid") return "Medio";
    return "Bajo";
  }
  if (locale === "domestic-zh" || locale === "global-zh" || locale === "ja") {
    if (category === "high") return "高";
    if (category === "mid") return "中";
    return "低";
  }
  if (locale === "ko") {
    if (category === "high") return "높음";
    if (category === "mid") return "보통";
    return "낮음";
  }
  if (category === "high") return "High";
  if (category === "mid") return "Mid";
  return "Low";
}

export const BUDDY_PREF_TAGS = PREF_TAGS;
