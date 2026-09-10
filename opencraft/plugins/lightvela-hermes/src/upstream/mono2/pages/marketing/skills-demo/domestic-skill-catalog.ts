// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { Skill } from "./skill-registries";

type LocalizedLabel = {
  en: string;
  zh: string;
};

export type DomesticSkillCategory = {
  id: string;
  label: LocalizedLabel;
  skills: readonly Skill[];
};

export type DomesticFeaturedSkill = {
  id: string;
  skill: Skill;
  heroImageSrc: string;
  heroClassName: string;
};

// Snapshot from SkillHub on 2026-07-15. Fixed cards do not refresh this at runtime.
const DOMESTIC_DOWNLOAD_SNAPSHOT: Readonly<Record<string, number>> = {
  "find-skill-skillhub": 18_004,
  "image-prompt-skill": 7_852,
  poster: 15_691,
  "ecommerce-product-selector": 8_405,
  "tencent-news": 8_027,
  "valuation-analysis": 20_710,
  "financial-report-analysis": 3_798,
  "stock-selecter": 9_846,
  "xiaohongshu-content-tools": 3_311,
  "quant-backtest-strategy": 3_911,
  topnews: 10_819,
  "unclecheng-reduce-ai-perception-v2": 37_283,
  "douyin-copy-extract": 17_472,
  g113593: 13_681,
  "weixin-article-writer": 10_734,
  "lingyi-wx-viral-script-generator": 10_503,
  "govwriter-pro": 7_434,
  "tencent-docs": 149_853,
  "pdf-image-text-extractor": 30_994,
  "pptx-generator": 20_994,
  "gongwenformat-pro": 12_046,
  "meeting-notes-assistant": 4_577,
  "bid-tender-master": 3_740,
  "k12-smart-teacher": 7_312,
  "interview-simulator": 22_301,
  "academic-learning-assistant": 945,
  "subject-hyn": 1_000,
  "academic-paper-writing-assistant": 949,
  "novel-evaluator": 4_674,
};

const DOMESTIC_ICON_SNAPSHOT: Readonly<Record<string, string>> = {
  "find-skill-skillhub": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a00e31c7-8d6a-4e65-84fc-16a177f95674.png",
  "image-prompt-skill": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/e9a58ede-ead5-43fd-9523-d1ba7f1b78cd.png",
  poster: "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/e9a58ede-ead5-43fd-9523-d1ba7f1b78cd.png",
  "ecommerce-product-selector": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5a1e9830-80e4-4cbb-8d00-cee893ca9555.png",
  "tencent-news": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/2d8152d9-7618-454e-9d87-2487f1b4457f.png",
  weather: "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/81015f94-5620-494e-bbd6-ac3268e7ccd3.png",
  "valuation-analysis": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/401a454b-4b16-4aee-a18c-4e3467ca48f1.png",
  "financial-report-analysis": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/f7fabcfa-0496-4dc7-9258-df9b7c751850.png",
  "stock-selecter": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a78375f1-773e-4817-b4f3-0557b6afd777.png",
  "xiaohongshu-content-tools": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/2d8152d9-7618-454e-9d87-2487f1b4457f.png",
  "quant-backtest-strategy": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/c0bd7863-2689-46f1-941c-e45be1317e90.png",
  topnews: "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a78375f1-773e-4817-b4f3-0557b6afd777.png",
  "unclecheng-reduce-ai-perception-v2": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/81015f94-5620-494e-bbd6-ac3268e7ccd3.png",
  "douyin-copy-extract": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a4e49550-e527-4406-b761-c4f2e607b757.png",
  g113593: "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/0c9b068f-f22e-44e2-96fe-d2b6f5b43b07.png",
  "weixin-article-writer": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5a1e9830-80e4-4cbb-8d00-cee893ca9555.png",
  "lingyi-wx-viral-script-generator": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/f7fabcfa-0496-4dc7-9258-df9b7c751850.png",
  "govwriter-pro": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a4e49550-e527-4406-b761-c4f2e607b757.png",
  "tencent-docs": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a4e49550-e527-4406-b761-c4f2e607b757.png",
  "pdf-image-text-extractor": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5a1e9830-80e4-4cbb-8d00-cee893ca9555.png",
  "pptx-generator": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5a1e9830-80e4-4cbb-8d00-cee893ca9555.png",
  "gongwenformat-pro": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/e9a58ede-ead5-43fd-9523-d1ba7f1b78cd.png",
  "meeting-notes-assistant": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/2d8152d9-7618-454e-9d87-2487f1b4457f.png",
  "bid-tender-master": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/c5e5faab-b8e1-489d-a489-8b56ffc52c07.png",
  "k12-smart-teacher": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/a78375f1-773e-4817-b4f3-0557b6afd777.png",
  "interview-simulator": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/401a454b-4b16-4aee-a18c-4e3467ca48f1.png",
  "academic-learning-assistant": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5a1e9830-80e4-4cbb-8d00-cee893ca9555.png",
  "subject-hyn": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/e9a58ede-ead5-43fd-9523-d1ba7f1b78cd.png",
  "academic-paper-writing-assistant": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/0c9b068f-f22e-44e2-96fe-d2b6f5b43b07.png",
  "novel-evaluator": "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/9bcddb03-161b-42cd-bf2e-cf0159d85bd7.png",
  "lh6-anniversary-blessing": "/assets/skills/featured-domestic-lh6-icon.svg",
};

function skill(
  rawId: string,
  name: string,
  description: string,
  installs: number,
): Skill {
  return {
    registry: "skillhub",
    rawId,
    slug: rawId,
    name,
    description,
    installs,
    downloads: DOMESTIC_DOWNLOAD_SNAPSHOT[rawId],
    iconUrl: DOMESTIC_ICON_SNAPSHOT[rawId],
    sourceOrg: "SkillHub",
  };
}

export const DOMESTIC_FEATURED_SKILLS: readonly DomesticFeaturedSkill[] = [
  {
    id: "lh6-anniversary-blessing",
    skill: skill(
      "lh6-anniversary-blessing",
      "轻量云六周年送祝福",
      "为轻量云六周年生成祝福文案与祝福海报，支持多场景、多风格的祝福语定制。",
      0,
    ),
    heroImageSrc: "/assets/skills/featured-domestic-lh6-anniversary.jpg",
    heroClassName: "bg-[#2B2F5C]",
  },
  {
    id: "find-skill-skillhub",
    skill: skill(
      "find-skill-skillhub",
      "find skill",
      "在 SkillHub 平台查找、搜索和推荐 Skill，支持关键词、分类和组合检索。",
      0,
    ),
    heroImageSrc: "/assets/skills/featured-domestic-find-skill.jpg",
    heroClassName: "bg-[#3A6F9B]",
  },
  {
    id: "image-prompt-skill",
    skill: skill(
      "image-prompt-skill",
      "提示词生成大师",
      "统一生成图片和视频提示词，支持多模态输入、风格适配和平台语法。",
      431,
    ),
    heroImageSrc: "/assets/skills/featured-domestic-image-prompt.jpg",
    heroClassName: "bg-[#347566]",
  },
  {
    id: "poster",
    skill: skill(
      "poster",
      "海报设计skill",
      "先构建设计哲学，再生成可渲染的 SVG 海报作品，适用于品牌视觉和海报设计。",
      784,
    ),
    heroImageSrc: "/assets/skills/featured-domestic-poster.jpg",
    heroClassName: "bg-[#B87821]",
  },
  {
    id: "ecommerce-product-selector",
    skill: skill(
      "ecommerce-product-selector",
      "电商选品",
      "基于数据分析筛选电商平台的潜力产品，支持淘宝、京东、拼多多、抖音和亚马逊等平台。",
      680,
    ),
    heroImageSrc: "/assets/skills/featured-domestic-ecommerce.jpg",
    heroClassName: "bg-[#A8472E]",
  },
  {
    id: "tencent-news",
    skill: skill(
      "tencent-news",
      "腾讯新闻",
      "提供 7×24 新闻资讯搜索，覆盖国内信息、国际热点、实时资讯、新闻早晚报和领域新闻。",
      268,
    ),
    heroImageSrc: "/assets/skills/featured-domestic-news.jpg",
    heroClassName: "bg-[#303F9F]",
  },
] as const;

export const DOMESTIC_SKILL_CATEGORIES: readonly DomesticSkillCategory[] = [
  {
    id: "finance-analysis",
    label: { en: "Finance Analysis", zh: "理财分析" },
    skills: [
      skill("valuation-analysis", "股票价值投资分析系统", "提供 A 股和港股的护城河、财务健康、DCF 估值、管理层和行业分析。", 1125),
      skill("financial-report-analysis", "财报分析", "自动解析上市公司资产负债表、利润表和现金流量表，生成财务分析报告。", 288),
      skill("stock-selecter", "股票筛选器", "整合多种选股策略，支持单策略或多策略组合筛选股票。", 651),
      skill("xiaohongshu-content-tools", "小红书数据洞察与竞品分析助手", "通过小红书关键词、笔记、评论和博主数据支持爆款挖掘与竞品分析。", 0),
      skill("quant-backtest-strategy", "A股量化回测策略引擎", "提供 A 股策略回测、技术信号、量化选股、模拟交易、风控和数据导出。", 43),
      skill("topnews", "股票舆情智能AI助手", "汇总实时行情、财经快讯、宏观国际新闻和资金面，形成市场环境判断。", 858),
    ],
  },
  {
    id: "content-creation",
    label: { en: "Content Creation", zh: "内容创建" },
    skills: [
      skill("unclecheng-reduce-ai-perception-v2", "文章去AI味工具", "检测并修复高频词、机械连接词、过度结构化等 AI 写作痕迹，让文字更自然。", 650),
      skill("douyin-copy-extract", "抖音文案一键提取", "从短视频分享链接提取标题、简介和口播文案，并提供优化、精简和敏感词提醒。", 1066),
      skill("g113593", "番茄小说写作助手（单章2200-2800字）", "面向番茄小说的分章节长篇创作助手，支持悬念、情绪节奏和连续剧情。", 970),
      skill("weixin-article-writer", "微信公众号写作工具", "按照财经公众号写作规范生成不超过 2500 字的专业文章，并优化移动端阅读。", 465),
      skill("lingyi-wx-viral-script-generator", "视频号爆款文案生成（体验版）【零一数科·出品】", "根据创作目的、行业、受众和选题生成带 Hook、中段和 CTA 的视频号口播脚本。", 0),
      skill("govwriter-pro", "体制内写作·灵析", "创作或重构政府公文，输出符合 GB/T 9704-2012 格式的 Word 文档。", 184),
    ],
  },
  {
    id: "common-tools",
    label: { en: "Common Tools", zh: "常用工具" },
    skills: [
      skill("tencent-docs", "腾讯文档 TENCENT DOCS", "创建、编辑、搜索和管理腾讯文档、表格、幻灯片、知识库和云端文件。", 8107),
      skill("pdf-image-text-extractor", "PDF和图片文字提取", "从图片和 PDF 中识别、提取文字，并保留结构化结果。", 378),
      skill("pptx-generator", "PPT Generator", "使用多种幻灯片类型、配色、图表和图片生成标准可编辑 PPTX。", 1621),
      skill("gongwenformat-pro", "公文排版", "将 Markdown、TXT 或 DOCX 转换为符合 GB/T 9704-2012 的 Word 文档。", 239),
      skill("meeting-notes-assistant", "Meeting Notes Assistant", "从会议录音生成结构化会议纪要，提取结论、待办和关键词，并支持多种输出格式。", 24),
      skill("bid-tender-master", "标书大师｜全行业AI标书生成助手", "根据项目名称和预算生成覆盖货物、服务和工程行业的投标文件。", 0),
    ],
  },
  {
    id: "education-learning",
    label: { en: "Education & Learning", zh: "教育学习" },
    skills: [
      skill("k12-smart-teacher", "K12智能老师", "支持作业批改、错题分析和基础/提高/挑战三层练习生成，覆盖多个学段和学科。", 207),
      skill("interview-simulator", "Interview Simulator", "模拟不同职位和经验水平的面试，提供技术、行为和案例问题以及反馈评分。", 981),
      skill("academic-learning-assistant", "学科专家生成", "提供覆盖多学段、多学科的个性化学习辅导、作业批改和薄弱点练习支持。", 64),
      skill("subject-hyn", "课题小助手", "辅助教师修改、优化和规范课题申请评审书及课题申报材料。", 36),
      skill("academic-paper-writing-assistant", "学术论文全能写作助手", "根据提纲和研究材料辅助生成实证或定性案例论文，并整理数据、图表和文献内容。", 0),
      skill("novel-evaluator", "小说评分系统", "从情节、人物、文笔、世界观、情感和创新六个维度量化评估小说。", 614),
    ],
  },
] as const;
