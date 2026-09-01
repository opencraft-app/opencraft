import definitions from "./soul-japanese-data.json";

import type { SkillHubSoul, SkillHubSoulDetail } from "@/lib/skillhub-api";
import type { SoulSpec } from "@/lib/soul-interpretations";

const NOW = 0;

type JapaneseSoulDefinition = (typeof definitions)[number];

const JAPANESE_DEFINITIONS: readonly JapaneseSoulDefinition[] = definitions;

export const JAPANESE_SOULS: SkillHubSoul[] = JAPANESE_DEFINITIONS.map((definition) => ({
  id: definition.id,
  slug: definition.slug,
  displayName: definition.displayName,
  summary: definition.summary,
  remark: "",
  version: "1.0.0-ja",
  createdAt: NOW,
  updatedAt: NOW,
}));

export const JAPANESE_SOUL_SPECS: Record<string, SoulSpec> = Object.fromEntries(
  JAPANESE_DEFINITIONS.map((definition) => [definition.slug, {
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

export function getJapaneseSoulSpec(slug: string): SoulSpec | null {
  return JAPANESE_SOUL_SPECS[slug] ?? null;
}

export function getJapaneseSoulDetail(slug: string): SkillHubSoulDetail | null {
  const soul = JAPANESE_SOULS.find((item) => item.slug === slug);
  const spec = getJapaneseSoulSpec(slug);
  if (!soul || !spec) return null;
  return { ...soul, content: buildJapaneseSoulContent(soul, spec) };
}

function buildJapaneseSoulContent(soul: SkillHubSoul, spec: SoulSpec): string {
  return [
    `# ${soul.displayName}`,
    "",
    "## 基本的な個性",
    soul.summary,
    "",
    "## 本質的な気質",
    spec.coreTemperament,
    "",
    "## 外面的なスタイル",
    spec.outerStyle,
    "",
    "## 言語スタイル",
    spec.languageSystem,
    "",
    "## 行動ロジック",
    spec.actionLogic,
    "",
    "## 隠れた特徴",
    spec.hiddenTraits,
    "",
    "## エージェントの実行設定",
    spec.soulMdConfig,
  ].join("\n");
}
