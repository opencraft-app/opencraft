// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { Skill } from "./skill-registries";

type LocalizedText = {
  en: string;
  zh: string;
  id: string;
  es: string;
  ja: string;
  ko: string;
};

export type CuratedSkillEntry = {
  skill: Skill;
};

export type CuratedSkillCategory = {
  id: "market-analysis" | "content-creation" | "research" | "devtools";
  label: LocalizedText;
  skills: readonly CuratedSkillEntry[];
};

// Snapshot from skills.sh on 2026-07-14. Fixed category cards do not refresh this at runtime.
const CURATED_INSTALL_SNAPSHOT: Readonly<Record<string, number>> = {
  "gracefullight/stock-checker/stock-analysis": 10_900,
  "molezzz/openclaw-stock-skill/akshare-stock": 10_600,
  "anthropics/financial-services-plugins/earnings-analysis": 1_800,
  "okx/agent-skills/okx-sentiment-tracker": 5_500,
  "phuryn/pm-skills/sentiment-analysis": 1_800,
  "personamanagmentlayer/pcl/finance-expert": 5_800,
  "coreyhaines31/marketingskills/content-strategy": 106_000,
  "coreyhaines31/marketingskills/social-content": 67_500,
  "composiohq/awesome-claude-skills/content-research-writer": 6_100,
  "googleworkspace/cli/persona-content-creator": 19_900,
  "resciencelab/opc-skills/seo-geo": 34_800,
  "mattpocock/skills/edit-article": 126_300,
  "karpathy/nanochat/read-arxiv-paper": 2_300,
  "googleworkspace/cli/persona-researcher": 20_400,
  "nexscope-ai/amazon-skills/amazon-product-research": 62_100,
  "coreyhaines31/marketingskills/customer-research": 63_400,
  "firecrawl/firecrawl-workflows/firecrawl-market-research": 29_200,
  "firecrawl/firecrawl-workflows/firecrawl-deep-research": 30_200,
  "anthropics/skills/pdf": 156_700,
  "coreyhaines31/marketingskills/image": 43_000,
  "github/awesome-copilot/prd": 20_600,
  "google-labs-code/stitch-skills/enhance-prompt": 49_100,
  "github/awesome-copilot/documentation-writer": 23_000,
  "wshobson/agents/data-storytelling": 12_700,
};

function skill(rawId: string, name: string): Skill {
  const segments = rawId.split("/");
  const slug = segments.at(-1);
  if (!slug) throw new Error(`Invalid curated skills.sh ID: ${rawId}`);

  return {
    registry: "skills-sh",
    rawId,
    slug,
    name,
    sourceOrg: segments.slice(0, -1).join("/"),
    installs: CURATED_INSTALL_SNAPSHOT[rawId],
  };
}

export const CURATED_SKILL_CATEGORIES: readonly CuratedSkillCategory[] = [
  {
    id: "market-analysis",
    label: { en: "Market Analysis", zh: "市场分析", id: "Analisis Pasar", es: "Análisis de mercado", ja: "市場分析", ko: "시장 분석" },
    skills: [
      {
        skill: skill("gracefullight/stock-checker/stock-analysis", "Stock Analysis"),
      },
      {
        skill: skill("molezzz/openclaw-stock-skill/akshare-stock", "AKShare Stock"),
      },
      {
        skill: skill("anthropics/financial-services-plugins/earnings-analysis", "Earnings Analysis"),
      },
      {
        skill: skill("okx/agent-skills/okx-sentiment-tracker", "OKX Sentiment Tracker"),
      },
      {
        skill: skill("phuryn/pm-skills/sentiment-analysis", "Sentiment Analysis"),
      },
      {
        skill: skill("personamanagmentlayer/pcl/finance-expert", "Finance Expert"),
      },
    ],
  },
  {
    id: "content-creation",
    label: { en: "Content Creation", zh: "内容创作", id: "Pembuatan Konten", es: "Creación de contenido", ja: "コンテンツ制作", ko: "콘텐츠 제작" },
    skills: [
      {
        skill: skill("coreyhaines31/marketingskills/content-strategy", "Content Strategy"),
      },
      {
        skill: skill("coreyhaines31/marketingskills/social-content", "Social Content"),
      },
      {
        skill: skill("composiohq/awesome-claude-skills/content-research-writer", "Content Research Writer"),
      },
      {
        skill: skill("googleworkspace/cli/persona-content-creator", "Content Creator"),
      },
      {
        skill: skill("resciencelab/opc-skills/seo-geo", "SEO & GEO"),
      },
      {
        skill: skill("mattpocock/skills/edit-article", "Edit Article"),
      },
    ],
  },
  {
    id: "research",
    label: { en: "Research", zh: "研究", id: "Riset", es: "Investigación", ja: "リサーチ", ko: "리서치" },
    skills: [
      {
        skill: skill("karpathy/nanochat/read-arxiv-paper", "Read arXiv Paper"),
      },
      {
        skill: skill("googleworkspace/cli/persona-researcher", "Researcher"),
      },
      {
        skill: skill("nexscope-ai/amazon-skills/amazon-product-research", "Amazon Product Research"),
      },
      {
        skill: skill("coreyhaines31/marketingskills/customer-research", "Customer Research"),
      },
      {
        skill: skill("firecrawl/firecrawl-workflows/firecrawl-market-research", "Firecrawl Market Research"),
      },
      {
        skill: skill("firecrawl/firecrawl-workflows/firecrawl-deep-research", "Firecrawl Deep Research"),
      },
    ],
  },
  {
    id: "devtools",
    label: { en: "DevTools", zh: "开发工具", id: "Alat Pengembangan", es: "Herramientas de desarrollo", ja: "開発ツール", ko: "개발 도구" },
    skills: [
      {
        skill: skill("anthropics/skills/pdf", "PDF"),
      },
      {
        skill: skill("coreyhaines31/marketingskills/image", "Marketing Image"),
      },
      {
        skill: skill("github/awesome-copilot/prd", "PRD"),
      },
      {
        skill: skill("google-labs-code/stitch-skills/enhance-prompt", "Enhance Prompt"),
      },
      {
        skill: skill("github/awesome-copilot/documentation-writer", "Documentation Writer"),
      },
      {
        skill: skill("wshobson/agents/data-storytelling", "Data Storytelling"),
      },
    ],
  },
] as const;
