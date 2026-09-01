import definitions from "./soul-korean-data.json";

import type { SkillHubSoul, SkillHubSoulDetail } from "@/lib/skillhub-api";
import type { SoulSpec } from "@/lib/soul-interpretations";

const NOW = 0;

type KoreanSoulDefinition = (typeof definitions)[number];

const KOREAN_DEFINITIONS: readonly KoreanSoulDefinition[] = definitions;

export const KOREAN_SOULS: SkillHubSoul[] = KOREAN_DEFINITIONS.map((definition) => ({
  id: definition.id,
  slug: definition.slug,
  displayName: definition.displayName,
  summary: definition.summary,
  remark: "",
  version: "1.0.0-ko",
  createdAt: NOW,
  updatedAt: NOW,
}));

export const KOREAN_SOUL_SPECS: Record<string, SoulSpec> = Object.fromEntries(
  KOREAN_DEFINITIONS.map((definition) => [definition.slug, {
    interpretation: definition.interpretation,
    coreTemperament: definition.coreTemperament,
    outerStyle: definition.outerStyle,
    languageSystem: definition.languageSystem,
    actionLogic: definition.actionLogic,
    hiddenTraits: definition.hiddenTraits,
    soulMdConfig: [
      `role: ${definition.role}`,
      `style: ${definition.style}`,
      `approach: ${definition.approach}`,
      `tone: ${definition.tone}`,
    ].join("\n"),
  }]),
);

export function getKoreanSoulSpec(slug: string): SoulSpec | null {
  return KOREAN_SOUL_SPECS[slug] ?? null;
}

export function getKoreanSoulDetail(slug: string): SkillHubSoulDetail | null {
  const soul = KOREAN_SOULS.find((item) => item.slug === slug);
  const spec = getKoreanSoulSpec(slug);
  if (!soul || !spec) return null;
  return { ...soul, content: buildKoreanSoulContent(soul, spec) };
}

function buildKoreanSoulContent(soul: SkillHubSoul, spec: SoulSpec): string {
  return [
    `# ${soul.displayName}`,
    "",
    "## 기본 성격",
    soul.summary,
    "",
    "## 내면의 정서",
    spec.coreTemperament,
    "",
    "## 외적 스타일",
    spec.outerStyle,
    "",
    "## 언어 스타일",
    spec.languageSystem,
    "",
    "## 행동 논리",
    spec.actionLogic,
    "",
    "## 숨은 특징",
    spec.hiddenTraits,
    "",
    "## 에이전트 실행 설정",
    spec.soulMdConfig,
  ].join("\n");
}
