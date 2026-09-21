import { describe, expect, it } from "vitest";

import {
  DOMESTIC_FEATURED_SKILLS,
  DOMESTIC_SKILL_CATEGORIES,
} from "./domestic-skill-catalog";
import { CURATED_SKILL_OVERVIEWS_ZH } from "./curated-skill-overviews.zh";
import { buildSkillhubInstallCommand, getSkillSourceUrl, skillIdentity } from "./skill-registries";

describe("domestic SkillHub catalog", () => {
  it("keeps the manually curated featured list", () => {
    expect(DOMESTIC_FEATURED_SKILLS.map(({ skill }) => skill.rawId)).toEqual([
      "lh6-anniversary-blessing",
      "find-skill-skillhub",
      "image-prompt-skill",
      "poster",
      "ecommerce-product-selector",
      "tencent-news",
      "suno-lyrics-to-song",
      "@indiv-skill/anti-fraud",
      "chinese-official-writing",
    ]);
    expect(DOMESTIC_FEATURED_SKILLS.every(({ skill }) => skill.registry === "skillhub")).toBe(true);
  });

  it("appends the three requested cards as the third featured page", () => {
    const lastPage = DOMESTIC_FEATURED_SKILLS.slice(-3);

    expect(DOMESTIC_FEATURED_SKILLS).toHaveLength(9);
    expect(lastPage.map(({ id }) => id)).toEqual([
      "suno-lyrics-to-song",
      "anti-fraud-expert",
      "chinese-official-writing",
    ]);
    expect(lastPage.map(({ skill }) => skill)).toMatchObject([
      {
        rawId: "suno-lyrics-to-song",
        name: "Suno歌词成曲",
        downloads: 103_205,
        iconUrl: "https://skillhub-1388575217.cos.accelerate.myqcloud.com/skill-icons/uploads/433053/6700622101e14db9b20152bfa87bae00.png",
      },
      {
        rawId: "@indiv-skill/anti-fraud",
        slug: "anti-fraud",
        name: "防诈专家",
        downloads: 145_418,
        iconUrl: "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/c5e5faab-b8e1-489d-a489-8b56ffc52c07.png",
      },
      {
        rawId: "chinese-official-writing",
        name: "中文公文写作",
        downloads: 149_071,
        iconUrl: "https://skillhub-1388575217.cos.accelerate.myqcloud.com/skill-icons/uploads/437097/fbafa4ddeb204e4584a699f65e06d137.png",
      },
    ]);
    expect(lastPage.map(({ heroImageSrc }) => heroImageSrc)).toEqual([
      "/assets/skills/featured-domestic-suno-lyrics-to-song.jpg",
      "/assets/skills/featured-domestic-anti-fraud-expert.jpg",
      "/assets/skills/featured-domestic-chinese-official-writing.jpg",
    ]);
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

  it("uses the requested SkillHub replacements in the domestic curated categories", () => {
    expect(DOMESTIC_SKILL_CATEGORIES.map((category) => category.skills.map((skill) => skill.rawId))).toEqual([
      ["valuation-analysis", "cnfinancialscraper", "stock-selecter", "finance-advisor", "quant-backtest-strategy", "topnews"],
      [
        "unclecheng-reduce-ai-perception-v2",
        "douyin-copy-extract",
        "g113593",
        "weixin-article-writer",
        "lingyi-wx-viral-script-generator",
        "govwriter-pro",
      ],
      ["tencent-docs", "pdf-image-text-extractor", "@indiv-ebandao/anti-fraud", "gongwenformat-pro", "multi-search-engine", "bid-tender-master"],
      ["k12-smart-teacher", "interview-simulator", "parenting-expert", "subject-hyn", "academic-paper-writing-assistant", "novel-evaluator"],
    ]);

    const replacementSkills = DOMESTIC_SKILL_CATEGORIES
      .flatMap((category) => category.skills)
      .filter((skill) => ["cnfinancialscraper", "multi-search-engine", "@indiv-ebandao/anti-fraud", "parenting-expert"].includes(skill.rawId));

    expect(replacementSkills.map((skill) => skill.name)).toEqual([
      "全能金融爬虫（新增知识库功能）",
      "防骗大师.Skill",
      "搜索引擎",
      "育儿大师.Skill",
    ]);
    expect(replacementSkills.map((skill) => buildSkillhubInstallCommand(skill.rawId))).toEqual([
      "acli skills install 'cnfinancialscraper'",
      "acli skills install '@indiv-ebandao/anti-fraud'",
      "acli skills install 'multi-search-engine'",
      "acli skills install 'parenting-expert'",
    ]);
    expect(replacementSkills.map((skill) => skill.iconUrl)).toEqual([
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/e9a58ede-ead5-43fd-9523-d1ba7f1b78cd.png",
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/c5e5faab-b8e1-489d-a489-8b56ffc52c07.png",
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/0860fda4-ff95-4bbc-b3ad-f6b7ad8e0774.png",
      "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/0c9b068f-f22e-44e2-96fe-d2b6f5b43b07.png",
    ]);
  });

  it("keeps the two SkillHub anti-fraud listings distinct through card, detail, and install identities", () => {
    const featured = DOMESTIC_FEATURED_SKILLS.find(({ id }) => id === "anti-fraud-expert")?.skill;
    const category = DOMESTIC_SKILL_CATEGORIES
      .find(({ id }) => id === "common-tools")?.skills
      .find((skill) => skill.rawId === "@indiv-ebandao/anti-fraud");

    expect(featured).toMatchObject({
      rawId: "@indiv-skill/anti-fraud",
      slug: "anti-fraud",
      name: "防诈专家",
    });
    expect(category).toMatchObject({
      rawId: "@indiv-ebandao/anti-fraud",
      slug: "anti-fraud",
      name: "防骗大师.Skill",
    });
    expect(featured).toBeDefined();
    expect(category).toBeDefined();
    expect(skillIdentity(featured!)).not.toBe(skillIdentity(category!));
    expect(buildSkillhubInstallCommand(featured!.rawId)).toBe("acli skills install '@indiv-skill/anti-fraud'");
    expect(buildSkillhubInstallCommand(category!.rawId)).toBe("acli skills install '@indiv-ebandao/anti-fraud'");
    expect(getSkillSourceUrl(featured!)).toBe("https://skillhub.cn/skills/indiv-skill/anti-fraud");
    expect(getSkillSourceUrl(category!)).toBe("https://skillhub.cn/skills/indiv-ebandao/anti-fraud");
    expect(CURATED_SKILL_OVERVIEWS_ZH[featured!.rawId]?.overview[0]).toContain("防诈专家");
    expect(CURATED_SKILL_OVERVIEWS_ZH[category!.rawId]?.overview[0]).toContain("反诈与防骗");
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
