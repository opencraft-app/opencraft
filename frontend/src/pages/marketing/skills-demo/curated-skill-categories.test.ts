import { describe, expect, it } from "vitest";

import { CURATED_SKILL_CATEGORIES } from "./curated-skill-categories";
import { getCuratedSkillOverview } from "./curated-skill-overviews";

describe("curated Discover categories", () => {
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
