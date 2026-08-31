import { describe, expect, it } from "vitest";

import { CURATED_SKILL_CATEGORIES } from "./curated-skill-categories";
import { CURATED_SKILL_OVERVIEWS, getCuratedSkillOverview } from "./curated-skill-overviews";

describe("curated Discover categories", () => {
  it("provides a complete Spanish overview for every curated international skill", () => {
    for (const rawId of Object.keys(CURATED_SKILL_OVERVIEWS)) {
      const english = getCuratedSkillOverview(rawId, "en-US");
      const spanish = getCuratedSkillOverview(rawId, "es" as never);

      expect(spanish, rawId).toBeTruthy();
      expect(spanish.overview, rawId).not.toEqual(english.overview);
      expect(spanish.basicUsage, rawId).not.toBe(english.basicUsage);
      expect(spanish.examplePrompt, rawId).not.toBe(english.examplePrompt);
      expect(JSON.stringify(spanish), rawId).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("provides a complete Japanese overview for every curated international skill", () => {
    for (const rawId of Object.keys(CURATED_SKILL_OVERVIEWS)) {
      const english = getCuratedSkillOverview(rawId, "en-US");
      const japanese = getCuratedSkillOverview(rawId, "ja-JP" as never);

      expect(japanese, rawId).toBeTruthy();
      expect(japanese.overview, rawId).not.toEqual(english.overview);
      expect(japanese.basicUsage, rawId).not.toBe(english.basicUsage);
      expect(japanese.examplePrompt, rawId).not.toBe(english.examplePrompt);
      expect(JSON.stringify(japanese), rawId).toMatch(/[\u3040-\u30ff]/);
    }
  });

  it("provides a complete Korean overview for every curated international skill", () => {
    for (const rawId of Object.keys(CURATED_SKILL_OVERVIEWS)) {
      const english = getCuratedSkillOverview(rawId, "en-US");
      const korean = getCuratedSkillOverview(rawId, "ko-KR" as never);

      expect(korean, rawId).toBeTruthy();
      expect(korean.overview, rawId).not.toEqual(english.overview);
      expect(korean.basicUsage, rawId).not.toBe(english.basicUsage);
      expect(korean.examplePrompt, rawId).not.toBe(english.examplePrompt);
      expect(JSON.stringify(korean), rawId).toMatch(/[가-힣]/);
    }
  });

  it("keeps the four fixed categories and their exact skills.sh IDs", () => {
    expect(CURATED_SKILL_CATEGORIES.map((category) => category.id)).toEqual([
      "market-analysis",
      "content-creation",
      "research",
      "devtools",
    ]);
    expect(CURATED_SKILL_CATEGORIES.every((category) => category.skills.length === 6)).toBe(true);
    expect(CURATED_SKILL_CATEGORIES.flatMap((category) => category.skills.map((entry) => entry.skill.rawId))).toEqual([
      "gracefullight/stock-checker/stock-analysis",
      "molezzz/openclaw-stock-skill/akshare-stock",
      "anthropics/financial-services-plugins/earnings-analysis",
      "okx/agent-skills/okx-sentiment-tracker",
      "phuryn/pm-skills/sentiment-analysis",
      "personamanagmentlayer/pcl/finance-expert",
      "coreyhaines31/marketingskills/content-strategy",
      "coreyhaines31/marketingskills/social-content",
      "composiohq/awesome-claude-skills/content-research-writer",
      "googleworkspace/cli/persona-content-creator",
      "resciencelab/opc-skills/seo-geo",
      "mattpocock/skills/edit-article",
      "karpathy/nanochat/read-arxiv-paper",
      "googleworkspace/cli/persona-researcher",
      "nexscope-ai/amazon-skills/amazon-product-research",
      "coreyhaines31/marketingskills/customer-research",
      "firecrawl/firecrawl-workflows/firecrawl-market-research",
      "firecrawl/firecrawl-workflows/firecrawl-deep-research",
      "anthropics/skills/pdf",
      "coreyhaines31/marketingskills/image",
      "github/awesome-copilot/prd",
      "google-labs-code/stitch-skills/enhance-prompt",
      "github/awesome-copilot/documentation-writer",
      "wshobson/agents/data-storytelling",
    ]);
    expect(CURATED_SKILL_CATEGORIES.flatMap((category) => category.skills).every(
      (entry) => entry.skill.registry === "skills-sh",
    )).toBe(true);
    expect(CURATED_SKILL_CATEGORIES.flatMap((category) => category.skills).every(
      (entry) => typeof entry.skill.installs === "number",
    )).toBe(true);
  });

  it("provides Spanish labels for the four fixed categories", () => {
    expect(CURATED_SKILL_CATEGORIES.map((category) => category.label.es)).toEqual([
      "Análisis de mercado",
      "Creación de contenido",
      "Investigación",
      "Herramientas de desarrollo",
    ]);
  });

  it("provides Japanese labels for the four fixed categories", () => {
    expect(CURATED_SKILL_CATEGORIES.map((category) => category.label.ja)).toEqual([
      "市場分析",
      "コンテンツ制作",
      "リサーチ",
      "開発ツール",
    ]);
  });

  it("provides Korean labels for the four fixed categories", () => {
    expect(CURATED_SKILL_CATEGORIES.map((category) => category.label.ko)).toEqual([
      "시장 분석",
      "콘텐츠 제작",
      "리서치",
      "개발 도구",
    ]);
  });

  it("provides the full recommendation structure for every curated skill", () => {
    CURATED_SKILL_CATEGORIES.flatMap((category) => category.skills).forEach((entry) => {
      const overview = getCuratedSkillOverview(entry.skill.rawId);
      expect(overview.overview).toHaveLength(2);
      expect(overview.whoShouldUse).toHaveLength(3);
      expect(overview.problemsItSolves).toHaveLength(3);
      expect(overview.keyCapabilities).toHaveLength(4);
      expect(overview.basicUsage).not.toHaveLength(0);
      expect(overview.examplePrompt).not.toHaveLength(0);
    });
  });

  it("provides the full recommendation structure for every Featured skill", () => {
    [
      "charon-fan/agent-playbook/self-improving-agent",
      "vercel-labs/skills/find-skills",
      "steipete/clawdis/weather",
      "juliusbrussee/caveman/caveman",
      "mattpocock/skills/to-issues",
      "roin-orca/skills/simple",
    ].forEach((rawId) => {
      const overview = getCuratedSkillOverview(rawId);
      expect(overview.overview).toHaveLength(2);
      expect(overview.whoShouldUse).toHaveLength(3);
      expect(overview.problemsItSolves).toHaveLength(3);
      expect(overview.keyCapabilities).toHaveLength(4);
      expect(overview.basicUsage).not.toHaveLength(0);
      expect(overview.examplePrompt).not.toHaveLength(0);
    });
  });
});
