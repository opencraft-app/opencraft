import { describe, expect, it } from "vitest";

import {
  DOMESTIC_FEATURED_SKILLS,
  DOMESTIC_SKILL_CATEGORIES,
} from "./domestic-skill-catalog";
import { CURATED_SKILL_OVERVIEWS_ZH } from "./curated-skill-overviews.zh";
import { buildSkillhubInstallCommand } from "./skill-registries";

describe("domestic SkillHub catalog", () => {
  it("keeps the manually curated featured list", () => {
    expect(DOMESTIC_FEATURED_SKILLS.map(({ skill }) => skill.rawId)).toEqual([
      "lh6-anniversary-blessing",
      "find-skill-skillhub",
      "image-prompt-skill",
      "poster",
      "ecommerce-product-selector",
      "tencent-news",
    ]);
    expect(DOMESTIC_FEATURED_SKILLS.every(({ skill }) => skill.registry === "skillhub")).toBe(true);
  });

  it("keeps four fixed categories with six skills each", () => {
    expect(DOMESTIC_SKILL_CATEGORIES.map((category) => category.label.zh)).toEqual([
      "理财分析",
      "内容创建",
      "常用工具",
      "教育学习",
    ]);
    expect(DOMESTIC_SKILL_CATEGORIES.every((category) => category.skills.length === 6)).toBe(true);
    expect(DOMESTIC_SKILL_CATEGORIES.flatMap((category) => category.skills).every((skill) => skill.registry === "skillhub")).toBe(true);
  });

  it("uses the verified finance advisor identity for the domestic finance category card, detail, and install action", () => {
    const financeCategory = DOMESTIC_SKILL_CATEGORIES.find((category) => category.id === "finance-analysis");
    const financeAdvisor = financeCategory?.skills[3];

    expect(financeAdvisor).toMatchObject({
      registry: "skillhub",
      rawId: "finance-advisor",
      slug: "finance-advisor",
      name: "金融助手",
      downloads: 2_938,
      installs: 294,
      iconUrl: "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/e9a58ede-ead5-43fd-9523-d1ba7f1b78cd.png",
    });
    expect(buildSkillhubInstallCommand(financeAdvisor?.rawId ?? "")).toBe("acli skills install 'finance-advisor'");
    expect(CURATED_SKILL_OVERVIEWS_ZH["finance-advisor"]?.examplePrompt).toContain("10 万元闲置资金");
  });

  it("provides a Chinese structured overview for every domestic card", () => {
    const ids = [
      ...DOMESTIC_FEATURED_SKILLS.map(({ skill }) => skill.rawId),
      ...DOMESTIC_SKILL_CATEGORIES.flatMap((category) => category.skills.map((skill) => skill.rawId)),
    ];

    expect(ids.every((id) => CURATED_SKILL_OVERVIEWS_ZH[id])).toBe(true);
  });
});
