import { describe, expect, it } from "vitest";

import {
  DOMESTIC_FEATURED_SKILLS,
  DOMESTIC_SKILL_CATEGORIES,
} from "./domestic-skill-catalog";
import { CURATED_SKILL_OVERVIEWS_ZH } from "./curated-skill-overviews.zh";

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

  it("provides a Chinese structured overview for every domestic card", () => {
    const ids = [
      ...DOMESTIC_FEATURED_SKILLS.map(({ skill }) => skill.rawId),
      ...DOMESTIC_SKILL_CATEGORIES.flatMap((category) => category.skills.map((skill) => skill.rawId)),
    ];

    expect(ids.every((id) => CURATED_SKILL_OVERVIEWS_ZH[id])).toBe(true);
  });
});
