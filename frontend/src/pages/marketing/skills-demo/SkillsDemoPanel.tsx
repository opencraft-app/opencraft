/**
 * SkillsDemoPanel —— 国际站技能浏览 / 安装面板（mono2 自有，不依赖 TEA SDK）。
 *
 * 数据来源：skill-registries.ts（mock 联调样例 / live acli 命令）。
 * 关键能力：
 *  - 同时展示 ClawHub + skills.sh 两个 registry，每条技能标注来源
 *  - 「已安装」区通过双 list 交叉判定来源，修正 SDK 的 Unknown Source
 *  - Popular 排序 + registry 过滤 + 来源组织分类，便于后续做推荐位 / 分类位
 *
 * 仅国际站渲染（见 hermes-agent-skills-panel.tsx 的 isGlobal 分支）。
 */

import {
  ArrowLeft,
  BookOpen,
  Briefcase,
  Check,
  Compass,
  FileText,
  Globe2,
  HeartPulse,
  Hotel,
  Languages,
  Link2,
  Layers3,
  Loader2,
  Package,
  Palette,
  PenLine,
  Plane,
  Repeat2,
  Search,
  Sparkles,
  Trash2,
  Utensils,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n/t";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import type { ExpertsExecDebugCommand } from "../hermes-agent-experts-panel";
import {
  createSkillsDataLayer,
  formatInstalls,
  mergeSkills,
  REGISTRY_LABEL,
  SKILLS_DEMO_LIVE,
  sortByPopular,
  sortByName,
  type InstalledSkill,
  type Registry,
  type Skill,
} from "./skill-registries";

type RegistryFilter = "all" | Registry;
type SortMode = "popular" | "name";
export type SkillsDemoTab = "search" | "create" | "installed";

const CLS = "lv-skills-demo";

type CreateSkillCategoryId = "quick-learn" | "workplace" | "research" | "learning" | "creative" | "personal" | "leisure";

const CREATE_SKILL_CATEGORIES: readonly Array<{
  id: CreateSkillCategoryId;
  icon: LucideIcon;
  iconClassName: string;
  galleryClassName: string;
}> = [
  {
    id: "quick-learn",
    icon: Sparkles,
    iconClassName: "text-[#4C8279]",
    galleryClassName: "",
  },
  {
    id: "workplace",
    icon: Briefcase,
    iconClassName: "text-[#4C8279]",
    galleryClassName: "bg-[linear-gradient(to_bottom,rgba(234,244,241,0.86)_0%,rgba(255,255,255,0.38)_54%,rgba(255,255,255,0)_100%)]",
  },
  {
    id: "research",
    icon: Globe2,
    iconClassName: "text-[#3C6A82]",
    galleryClassName: "bg-[linear-gradient(to_bottom,rgba(232,242,245,0.9)_0%,rgba(255,255,255,0.38)_54%,rgba(255,255,255,0)_100%)]",
  },
  {
    id: "learning",
    icon: BookOpen,
    iconClassName: "text-[#596B97]",
    galleryClassName: "bg-[linear-gradient(to_bottom,rgba(237,240,248,0.9)_0%,rgba(255,255,255,0.38)_54%,rgba(255,255,255,0)_100%)]",
  },
  {
    id: "creative",
    icon: Palette,
    iconClassName: "text-[#A14D70]",
    galleryClassName: "bg-[linear-gradient(to_bottom,rgba(248,232,238,0.86)_0%,rgba(255,255,255,0.38)_54%,rgba(255,255,255,0)_100%)]",
  },
  {
    id: "personal",
    icon: Compass,
    iconClassName: "text-[#657A4D]",
    galleryClassName: "bg-[linear-gradient(to_bottom,rgba(238,243,232,0.9)_0%,rgba(255,255,255,0.38)_54%,rgba(255,255,255,0)_100%)]",
  },
  {
    id: "leisure",
    icon: Plane,
    iconClassName: "text-[#7A668C]",
    galleryClassName: "bg-[linear-gradient(to_bottom,rgba(241,236,246,0.88)_0%,rgba(255,255,255,0.38)_54%,rgba(255,255,255,0)_100%)]",
  },
] as const;

const CREATE_SKILL_SCENARIOS = [
  {
    id: "summarize",
    icon: FileText,
    category: "workplace",
  },
  {
    id: "polish",
    icon: PenLine,
    category: "workplace",
  },
  {
    id: "sop",
    icon: Repeat2,
    category: "workplace",
  },
  {
    id: "web-research",
    icon: Globe2,
    category: "research",
  },
  {
    id: "source-digest",
    icon: BookOpen,
    category: "research",
  },
  {
    id: "competitor-scan",
    icon: Search,
    category: "research",
  },
  {
    id: "study-notes",
    icon: BookOpen,
    category: "learning",
  },
  {
    id: "flash-cards",
    icon: Layers3,
    category: "learning",
  },
  {
    id: "translation-localization",
    icon: Languages,
    category: "learning",
  },
  {
    id: "brand-voice",
    icon: Palette,
    category: "creative",
  },
  {
    id: "campaign-ideas",
    icon: Sparkles,
    category: "creative",
  },
  {
    id: "content-studio",
    icon: PenLine,
    category: "creative",
  },
  {
    id: "career",
    icon: Compass,
    category: "personal",
  },
  {
    id: "finance",
    icon: WalletCards,
    category: "personal",
  },
  {
    id: "health",
    icon: HeartPulse,
    category: "personal",
  },
  {
    id: "travel-planning",
    icon: Plane,
    category: "leisure",
  },
  {
    id: "hotel-airlines",
    icon: Hotel,
    category: "leisure",
  },
  {
    id: "dining-finder",
    icon: Utensils,
    category: "leisure",
  },
] as const satisfies readonly Array<{
  id: string;
  icon: LucideIcon;
  category: CreateSkillCategoryId;
}>;

type CreateSkillField = {
  id: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
};

function getCreateSkillScenarioDetails(t: ReturnType<typeof useT>): Record<string, {
  image: string;
  iconClassName: string;
  overlayClassName: string;
  fields: readonly CreateSkillField[];
  urlLabel: string;
  urlPlaceholder: string;
  workflow: readonly string[];
}> {
  return {
    summarize: {
      image: "https://images.unsplash.com/photo-1456324504439-367cee3b3c32?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#E6F1EF] text-[#34756B]",
      overlayClassName: "bg-[#1D4B45]/68",
      fields: [
        { id: "source", label: t("需要总结什么？"), placeholder: t("粘贴文档、笔记，或描述要读取的资料来源。"), multiline: true },
        { id: "format", label: t("你希望输出什么格式？"), placeholder: t("例如：5 条要点、执行摘要、会议纪要或固定模板。"), multiline: true },
        { id: "preferences", label: t("偏好与验收标准"), placeholder: t("例如：保留数字和链接、标出待确认事项、控制在 300 字内。"), multiline: true },
      ],
      urlLabel: t("参考网页（可选）"),
      urlPlaceholder: "https://example.com/article",
      workflow: [t("读取文档、网页或笔记"), t("提取重点并去除重复内容"), t("按你的模板生成结果"), t("检查遗漏、事实和长度")],
    },
    polish: {
      image: "https://images.unsplash.com/photo-1455390582262-044cdead277a?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#F6EEE3] text-[#A2692B]",
      overlayClassName: "bg-[#61401F]/65",
      fields: [
        { id: "draft", label: t("需要润色什么内容？"), placeholder: t("粘贴草稿、要点或语音转写内容。"), multiline: true },
        { id: "format", label: t("输出类型与受众"), placeholder: t("例如：给客户的邮件、团队周报、LinkedIn 帖子。") },
        { id: "voice", label: t("语气与必须保留的信息"), placeholder: t("例如：简洁、友好、保留产品名和所有数字。"), multiline: true },
      ],
      urlLabel: t("参考范例或语气链接（可选）"),
      urlPlaceholder: "https://example.com/style-guide",
      workflow: [t("识别草稿意图和关键信息"), t("根据受众调整结构和语气"), t("生成可直接使用的成稿"), t("检查事实、语法和必留内容")],
    },
    sop: {
      image: "https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#E9ECF7] text-[#5669A4]",
      overlayClassName: "bg-[#29355E]/68",
      fields: [
        { id: "sop", label: t("要遵循的 SOP 或任务背景"), placeholder: t("粘贴流程、团队规范，或描述这项重复工作的目标。"), multiline: true },
        { id: "trigger", label: t("触发方式与输入"), placeholder: t("例如：每周一 9:00；输入是上周会议记录和项目数据。"), multiline: true },
        { id: "validation", label: t("完成标准与异常情况"), placeholder: t("例如：缺少数据时先提醒我；输出必须包含负责人和下一步。"), multiline: true },
      ],
      urlLabel: t("参考 SOP 文档（可选）"),
      urlPlaceholder: "https://example.com/team-sop",
      workflow: [t("理解 SOP、触发条件和输入"), t("按顺序执行任务步骤"), t("处理缺失信息和边界情况"), t("用验收标准检查结果")],
    },
    "web-research": {
      image: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#E5F0F4] text-[#27647A]",
      overlayClassName: "bg-[#173F4D]/70",
      fields: [
        { id: "question", label: t("你想研究什么？"), placeholder: t("描述研究问题、决策背景或需要回答的核心问题。"), multiline: true },
        { id: "scope", label: t("来源与研究范围"), placeholder: t("例如：优先官方来源；覆盖最近 12 个月；关注欧美市场。"), multiline: true },
        { id: "output", label: t("输出结构与判断标准"), placeholder: t("例如：带引用的研究简报，包含结论、证据、争议点和建议。"), multiline: true },
      ],
      urlLabel: t("起始资料或网页（可选）"),
      urlPlaceholder: "https://example.com/research-brief",
      workflow: [t("明确研究问题与范围"), t("搜索并筛选相关来源"), t("交叉核对关键事实"), t("整理带引用的结论")],
    },
    "source-digest": {
      image: "https://images.unsplash.com/photo-1532012197267-da84d127e765?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#F0EAF7] text-[#76508F]",
      overlayClassName: "bg-[#3D2C4F]/68",
      fields: [
        { id: "materials", label: t("要整理哪些资料？"), placeholder: t("粘贴文章、论文、报告，或描述要持续收集的资料类型。"), multiline: true },
        { id: "format", label: t("你希望如何阅读结果？"), placeholder: t("例如：每篇 5 条要点，再按主题归类并附原文链接。"), multiline: true },
        { id: "focus", label: t("重点与排除项"), placeholder: t("例如：关注方法、数据和局限；跳过背景铺垫和重复观点。"), multiline: true },
      ],
      urlLabel: t("资料入口（可选）"),
      urlPlaceholder: "https://example.com/reading-list",
      workflow: [t("读取并拆分所有来源"), t("提取观点、证据和关键数据"), t("归纳主题与分歧"), t("生成带来源链接的资料摘要")],
    },
    "competitor-scan": {
      image: "https://images.unsplash.com/photo-1556761175-4b46a572b786?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#E8F0F5] text-[#3C6A82]",
      overlayClassName: "bg-[#223D4D]/70",
      fields: [
        { id: "competitors", label: t("要关注哪些对象？"), placeholder: t("列出竞争对手、产品或市场参与者，以及希望追踪的变化。"), multiline: true },
        { id: "signals", label: t("来源与关注信号"), placeholder: t("例如：官网、定价页、招聘、发布日志、社媒和客户评价。"), multiline: true },
        { id: "output", label: t("输出与行动建议"), placeholder: t("例如：每周变化表、影响判断、值得跟进的机会和风险。"), multiline: true },
      ],
      urlLabel: t("监测入口（可选）"),
      urlPlaceholder: "https://example.com/competitor-list",
      workflow: [t("收集各对象的最新变化"), t("按对象和信号统一整理"), t("识别重要趋势与异常"), t("总结影响并给出下一步")],
    },
    "study-notes": {
      image: "https://images.unsplash.com/photo-1456324504439-367cee3b3c32?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#EDF0F7] text-[#596B97]",
      overlayClassName: "bg-[#303B5B]/68",
      fields: [
        { id: "materials", label: t("要整理什么学习资料？"), placeholder: t("粘贴课程笔记、文章、讲义或阅读材料。"), multiline: true },
        { id: "structure", label: t("想要什么笔记结构？"), placeholder: t("例如：概念、关键例子、公式、易错点和一页复习总结。"), multiline: true },
        { id: "focus", label: t("重点与复习要求"), placeholder: t("例如：用简单语言解释；标出不确定内容；最后生成 5 个自测问题。"), multiline: true },
      ],
      urlLabel: t("课程或资料链接（可选）"),
      urlPlaceholder: "https://example.com/learning-material",
      workflow: [t("读取并拆分学习材料"), t("提取概念与关键例子"), t("按复习结构整理笔记"), t("补充自测问题并标出疑点")],
    },
    "flash-cards": {
      image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#EAF2F5] text-[#3C6A82]",
      overlayClassName: "bg-[#25444F]/68",
      fields: [
        { id: "source", label: t("从什么内容制作闪卡？"), placeholder: t("粘贴笔记、术语表、教材章节或需要记忆的内容。"), multiline: true },
        { id: "rules", label: t("闪卡格式与记忆规则"), placeholder: t("例如：正面问问题、背面给答案；一张卡只考一个事实。"), multiline: true },
        { id: "difficulty", label: t("难度与输出要求"), placeholder: t("例如：基础到进阶分层；避免重复；导出为问答列表。"), multiline: true },
      ],
      urlLabel: t("参考教材或资料（可选）"),
      urlPlaceholder: "https://example.com/flash-card-source",
      workflow: [t("识别可独立记忆的知识点"), t("生成清晰的问答闪卡"), t("按难度和主题分组"), t("检查覆盖率、重复和答案准确性")],
    },
    "translation-localization": {
      image: "https://images.unsplash.com/photo-1521295121783-8a321d551ad2?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#F2ECF5] text-[#76508F]",
      overlayClassName: "bg-[#443151]/68",
      fields: [
        { id: "content", label: t("需要翻译或本地化什么？"), placeholder: t("粘贴原文、产品文案、帮助文档或一组待翻译内容。"), multiline: true },
        { id: "languages", label: t("语言、地区与语气"), placeholder: t("例如：中译英；面向新加坡用户；保持专业、自然、有品牌感。"), multiline: true },
        { id: "requirements", label: t("格式与术语要求"), placeholder: t("例如：保留 Markdown；统一产品术语；不要翻译变量名和链接。"), multiline: true },
      ],
      urlLabel: t("术语表或参考页面（可选）"),
      urlPlaceholder: "https://example.com/localization-guide",
      workflow: [t("理解原文意图与使用场景"), t("翻译并保持原文信息完整"), t("适配地区表达、术语和格式"), t("检查语气、准确性和占位符")],
    },
    "brand-voice": {
      image: "https://images.unsplash.com/photo-1558655146-d09347e92766?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#F8E8EE] text-[#A14D70]",
      overlayClassName: "bg-[#5A263F]/68",
      fields: [
        { id: "brand", label: t("品牌与使用场景"), placeholder: t("描述品牌、产品、受众，以及 Agent 会帮助你完成的内容类型。"), multiline: true },
        { id: "voice", label: t("品牌语气规则"), placeholder: t("例如：清晰、可信、有温度；避免夸张承诺和行业黑话。"), multiline: true },
        { id: "input", label: t("输入与输出要求"), placeholder: t("例如：输入产品要点，输出官网文案和社媒短文，并保留功能事实。"), multiline: true },
      ],
      urlLabel: t("品牌指南或范例（可选）"),
      urlPlaceholder: "https://example.com/brand-guide",
      workflow: [t("理解品牌背景与受众"), t("提取语气和表达规律"), t("按品牌声音完成创作"), t("检查禁用表达和事实")],
    },
    "campaign-ideas": {
      image: "https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#F5EDE3] text-[#9A6330]",
      overlayClassName: "bg-[#5B3E25]/68",
      fields: [
        { id: "brief", label: t("这次创意要解决什么？"), placeholder: t("描述活动目标、产品卖点、目标受众和希望改变的行为。"), multiline: true },
        { id: "brand", label: t("品牌边界与灵感方向"), placeholder: t("例如：沿用品牌主色；不要使用竞品对比；希望更年轻或更专业。"), multiline: true },
        { id: "deliverables", label: t("需要哪些创意产出？"), placeholder: t("例如：3 个 campaign 方向、主标题、短文案和适配渠道建议。"), multiline: true },
      ],
      urlLabel: t("参考活动或素材（可选）"),
      urlPlaceholder: "https://example.com/campaign-reference",
      workflow: [t("明确目标、受众和品牌边界"), t("生成多个创意方向"), t("延展到标题和渠道表达"), t("按可行性与差异化筛选")],
    },
    "content-studio": {
      image: "https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#E8EEF7] text-[#4F6899]",
      overlayClassName: "bg-[#293A5D]/68",
      fields: [
        { id: "source", label: t("要扩展的核心内容"), placeholder: t("粘贴一段想法、产品更新、采访记录或已有长文。"), multiline: true },
        { id: "channels", label: t("目标渠道与格式"), placeholder: t("例如：官网文章、邮件、LinkedIn、X；分别说明长度和结构。"), multiline: true },
        { id: "requirements", label: t("品牌与发布要求"), placeholder: t("例如：统一使用品牌术语；每条内容都有明确 CTA；避免重复。"), multiline: true },
      ],
      urlLabel: t("品牌资料或已有内容（可选）"),
      urlPlaceholder: "https://example.com/content-library",
      workflow: [t("提炼一个核心信息"), t("按渠道改写内容结构"), t("统一品牌语气和事实"), t("检查格式、长度与行动号召")],
    },
    career: {
      image: "https://images.unsplash.com/photo-1521737711867-e3b97375f902?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#EEF3E8] text-[#657A4D]",
      overlayClassName: "bg-[#35452A]/68",
      fields: [
        { id: "goal", label: t("你想推进什么职业目标？"), placeholder: t("例如：准备晋升、转行、寻找新工作，或建立一项长期能力。"), multiline: true },
        { id: "context", label: t("你的背景与约束"), placeholder: t("例如：当前职位、经验、时间、地点、薪资或家庭安排。"), multiline: true },
        { id: "output", label: t("希望得到什么结果？"), placeholder: t("例如：90 天行动计划、岗位清单、简历改进方向或面试准备。"), multiline: true },
      ],
      urlLabel: t("参考资料（可选）"),
      urlPlaceholder: "https://example.com/career-notes",
      workflow: [t("明确目标与时间范围"), t("理解背景和现实约束"), t("制定可执行的下一步计划"), t("检查计划是否具体可行")],
    },
    finance: {
      image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#F2F0E5] text-[#8A7540]",
      overlayClassName: "bg-[#51472B]/68",
      fields: [
        { id: "goal", label: t("你的财务目标是什么？"), placeholder: t("例如：规划预算、减少固定支出、准备大额消费或整理现金流。"), multiline: true },
        { id: "situation", label: t("当前情况与规则"), placeholder: t("例如：收入、支出、周期、币种，以及必须遵守的个人规则。"), multiline: true },
        { id: "output", label: t("你希望如何使用结果？"), placeholder: t("例如：月度预算表、选择对比、提醒清单或需要进一步确认的问题。"), multiline: true },
      ],
      urlLabel: t("参考账单或资料（可选）"),
      urlPlaceholder: "https://example.com/finance-notes",
      workflow: [t("确认目标、周期和范围"), t("整理数字与固定规则"), t("比较选项并说明假设"), t("标出风险与需要确认的事项")],
    },
    health: {
      image: "https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#E8F2ED] text-[#4C8279]",
      overlayClassName: "bg-[#28483F]/68",
      fields: [
        { id: "goal", label: t("你想建立什么健康习惯？"), placeholder: t("例如：规律运动、改善睡眠、准备健康饮食或记录每日状态。"), multiline: true },
        { id: "context", label: t("你的日常与限制"), placeholder: t("例如：作息、可用时间、饮食偏好、运动基础或需要避开的事项。"), multiline: true },
        { id: "output", label: t("你希望 Agent 如何帮助？"), placeholder: t("例如：每周计划、每日提醒、复盘问题或习惯追踪格式。"), multiline: true },
      ],
      urlLabel: t("参考计划或资料（可选）"),
      urlPlaceholder: "https://example.com/health-plan",
      workflow: [t("明确目标与可衡量的习惯"), t("了解作息和个人限制"), t("设计循序渐进的行动方案"), t("检查执行情况并提示何时寻求专业帮助")],
    },
    "travel-planning": {
      image: "https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#E8F1F5] text-[#3C6A82]",
      overlayClassName: "bg-[#244454]/68",
      fields: [
        { id: "trip", label: t("这次旅行想怎么安排？"), placeholder: t("描述目的地、同行人、旅行目的，以及最想体验的事情。"), multiline: true },
        { id: "constraints", label: t("日期、预算与偏好"), placeholder: t("例如：出发日期、天数、预算、节奏、交通偏好和必去地点。"), multiline: true },
        { id: "output", label: t("你希望得到什么行程？"), placeholder: t("例如：按天安排、交通建议、备选方案和预订前检查清单。"), multiline: true },
      ],
      urlLabel: t("参考地点或行程（可选）"),
      urlPlaceholder: "https://example.com/travel-inspiration",
      workflow: [t("整理目的地与旅行目标"), t("结合日期、预算和偏好规划路线"), t("安排每天的节奏与活动"), t("检查时间、交通和预算冲突")],
    },
    "hotel-airlines": {
      image: "https://images.unsplash.com/photo-1436491865332-7a61a109cc05?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#EDF0F6] text-[#596B97]",
      overlayClassName: "bg-[#2E3B5D]/68",
      fields: [
        { id: "route", label: t("要查找哪段行程？"), placeholder: t("填写出发地、目的地、日期、人数和是否需要往返。"), multiline: true },
        { id: "preferences", label: t("住宿与航班偏好"), placeholder: t("例如：直飞、行李要求、入住区域、房型、取消政策和预算。"), multiline: true },
        { id: "output", label: t("如何比较结果？"), placeholder: t("例如：按总价、时间、便利性排序，并列出预订前需要确认的条款。"), multiline: true },
      ],
      urlLabel: t("参考订单或目的地资料（可选）"),
      urlPlaceholder: "https://example.com/booking-details",
      workflow: [t("收集路线、日期和人数"), t("筛选符合偏好的航班与住宿"), t("比较价格、时间和政策"), t("整理可预订的候选清单")],
    },
    "dining-finder": {
      image: "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=80",
      iconClassName: "bg-[#F6ECE5] text-[#A2692B]",
      overlayClassName: "bg-[#5A3A25]/68",
      fields: [
        { id: "location", label: t("想在哪里吃什么？"), placeholder: t("填写位置、用餐时间、人数和想吃的菜系或氛围。"), multiline: true },
        { id: "preferences", label: t("饮食、预算与偏好"), placeholder: t("例如：忌口、过敏、预算、是否需要预约或适合拍照。"), multiline: true },
        { id: "output", label: t("希望如何呈现餐厅？"), placeholder: t("例如：推荐 5 家，附距离、招牌菜、价格和适合的用餐场景。"), multiline: true },
      ],
      urlLabel: t("参考餐厅或区域资料（可选）"),
      urlPlaceholder: "https://example.com/dining-list",
      workflow: [t("搜索附近且符合场景的餐厅"), t("按饮食和预算过滤"), t("比较距离、评价和特色"), t("给出清晰的候选清单")],
    },
  };
}

type CreateSkillScenarioId = (typeof CREATE_SKILL_SCENARIOS)[number]["id"];

const CREATE_SKILL_SCENARIO_IDS = CREATE_SKILL_SCENARIOS.map((scenario) => scenario.id) as CreateSkillScenarioId[];

const isCreateSkillScenarioId = (value: string | null): value is CreateSkillScenarioId =>
  value !== null && CREATE_SKILL_SCENARIO_IDS.includes(value as CreateSkillScenarioId);

const CREATE_SKILL_SCENARIO_ICONS: Record<CreateSkillScenarioId, LucideIcon> = CREATE_SKILL_SCENARIOS.reduce(
  (acc, scenario) => {
    acc[scenario.id] = scenario.icon;
    return acc;
  },
  {} as Record<CreateSkillScenarioId, typeof FileText>,
);

export type LearnSkillTriggerOptions = {
  initialSkillName?: string;
  initialUrl?: string;
  initialNotes?: string;
  triggerLabel?: string;
  hideNotes?: boolean;
  hideName?: boolean;
};

function RegistryBadge({ registry }: { registry: Registry }) {
  const isSkillsSh = registry === "skills-sh";
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[5px] px-1.5 text-[10px] font-semibold leading-none",
        isSkillsSh
          ? "bg-[#FFF6E6] text-[#B26A00]"
          : "bg-[#EAF1FF] text-[#2F6BFF]",
      )}
    >
      {REGISTRY_LABEL[registry]}
    </span>
  );
}

function SourceOrgChip({ org }: { org: string }) {
  return (
    <span className="inline-flex items-center rounded bg-black/[0.04] px-1.5 py-0.5 text-[10px] font-medium text-black/55">
      {org}
    </span>
  );
}

function SkillCard({
  skill,
  installed,
  installing,
  onInstall,
}: {
  skill: Skill;
  installed: boolean;
  installing: boolean;
  onInstall: (skill: Skill) => void;
}) {
  const t = useT();
  return (
    <li className="flex items-start gap-3 rounded-md border border-black/[0.06] bg-white px-3.5 py-3 transition-colors hover:border-black/[0.12]">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-black/[0.04] text-black/55">
        <Sparkles className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <RegistryBadge registry={skill.registry} />
          <span className="truncate text-sm font-semibold text-black/90">{skill.name}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-black/45">
          <span className="truncate">{skill.rawId}</span>
          {skill.author ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="text-black/30">·</span> @{skill.author}
            </span>
          ) : null}
          {skill.sourceOrg ? <SourceOrgChip org={skill.sourceOrg} /> : null}
          {typeof skill.installs === "number" ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="text-black/30">·</span>
              {formatInstalls(skill.installs)} {t("安装")}
            </span>
          ) : null}
        </div>
      </div>
      <div className="shrink-0">
        {installed ? (
          <span className="inline-flex h-8 items-center gap-1 rounded-md bg-[#F4FCF9] px-2.5 text-xs font-semibold text-[#82BDAE]">
            <Check className="size-3.5" aria-hidden="true" />
            {t("已安装")}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onInstall(skill)}
            disabled={installing}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-black px-2.5 text-xs font-semibold text-white transition-colors hover:bg-black/85 disabled:opacity-55"
          >
            {installing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Package className="size-3.5" aria-hidden="true" />}
            {installing ? t("安装中...") : `+ ${t("安装")}`}
          </button>
        )}
      </div>
    </li>
  );
}

function InstalledRow({
  skill,
  uninstalling,
  onUninstall,
}: {
  skill: InstalledSkill;
  uninstalling: boolean;
  onUninstall: (skill: InstalledSkill) => void;
}) {
  const t = useT();
  const showSlug = skill.name !== skill.slug;
  return (
    <li className="flex items-center gap-3 border-b border-black/[0.05] px-1 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-black/90">{skill.name}</span>
          {skill.registries.map((reg) => (
            <RegistryBadge key={reg} registry={reg} />
          ))}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-black/45">
          {showSlug ? skill.slug : skill.rawId}
          {skill.version ? ` · v${skill.version}` : ""}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-black/40">{t("已安装")}</span>
        <button
          type="button"
          onClick={() => onUninstall(skill)}
          disabled={uninstalling}
          aria-label={t("删除技能 {{name}}", { name: skill.name })}
          title={t("删除")}
          className="inline-flex size-7 items-center justify-center rounded-md text-black/40 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-55"
        >
          {uninstalling ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
    </li>
  );
}

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-black/85">
      {children}
      {typeof count === "number" ? <span className="text-xs font-normal text-black/40">({count})</span> : null}
    </div>
  );
}

function CreateSkillPanel({
  learnSkillTrigger,
  learnSkillPanel,
  learnSkillTriggerFactory,
}: {
  learnSkillTrigger?: ReactNode;
  learnSkillPanel?: ReactNode;
  learnSkillTriggerFactory?: (options: LearnSkillTriggerOptions) => ReactNode;
}) {
  const t = useT();
  const [selectedCategoryId, setSelectedCategoryId] = useState<CreateSkillCategoryId>("quick-learn");
  const [selectedScenarioId, setSelectedScenarioId] = useState<CreateSkillScenarioId | null>(null);
  const [scenarioValues, setScenarioValues] = useState<Record<string, string>>({});
  const scenarioDetails = getCreateSkillScenarioDetails(t);
  const scenarioTitles: Record<CreateSkillScenarioId, string> = {
    summarize: t("智能总结"),
    polish: t("内容润色"),
    sop: t("SOP 任务"),
    "web-research": t("网页研究"),
    "source-digest": t("资料摘要"),
    "competitor-scan": t("竞品扫描"),
    "study-notes": t("学习笔记"),
    "flash-cards": t("闪卡"),
    "translation-localization": t("翻译本地化"),
    "brand-voice": t("品牌语气"),
    "campaign-ideas": t("活动创意"),
    "content-studio": t("内容工作室"),
    career: t("职业规划"),
    finance: t("财务规划"),
    health: t("健康习惯"),
    "travel-planning": t("旅行规划"),
    "hotel-airlines": t("住宿航班"),
    "dining-finder": t("餐厅查找"),
  };
  const scenarioDescriptions: Record<CreateSkillScenarioId, string> = {
    summarize: t("总结文档、网页或笔记为偏好的格式"),
    polish: t("将粗糙内容打磨成邮件、报告或社媒帖子"),
    sop: t("遵循个人或团队 SOP 处理周期性任务，例如会议准备或周报"),
    "web-research": t("搜索网页并将分散来源整理成清晰、带引用的研究简报"),
    "source-digest": t("将文章、论文或报告整理成结构化资料摘要"),
    "competitor-scan": t("追踪竞品动态并整理成可行动的市场洞察"),
    "study-notes": t("将课程、文章或讲义整理成清晰、方便复习的学习笔记"),
    "flash-cards": t("把学习资料转换成适合主动回忆的重点闪卡"),
    "translation-localization": t("跨语言改写内容，同时保留含义、语气和本地语境"),
    "brand-voice": t("根据品牌指南和范例，持续写出符合品牌声音的内容"),
    "campaign-ideas": t("把创意简报转化为适合品牌的活动方向"),
    "content-studio": t("将一个核心想法扩展成一组统一品牌内容"),
    career: t("把职业目标、经验和现实约束转化为可执行的下一步计划"),
    finance: t("根据你的目标和规则整理个人财务，并形成清晰的行动方案"),
    health: t("围绕日常限制建立可持续的健康习惯与复盘流程"),
    "travel-planning": t("把目的地、日期和偏好整理成轻松可执行的旅行计划"),
    "hotel-airlines": t("比较符合你偏好的航班和住宿，整理预订候选清单"),
    "dining-finder": t("根据位置、口味和预算找到适合当下场景的餐厅"),
  };
  const categoryTitles: Record<CreateSkillCategoryId, string> = {
    "quick-learn": t("速学"),
    workplace: t("办公"),
    research: t("研究"),
    learning: t("学习"),
    creative: t("创意"),
    personal: t("个人"),
    leisure: t("休闲"),
  };
  const categoryScenarios = CREATE_SKILL_SCENARIOS.filter(
    (scenario) => scenario.category === selectedCategoryId,
  );
  const selectedCategory = CREATE_SKILL_CATEGORIES.find((category) => category.id === selectedCategoryId);

  if (selectedScenarioId && isCreateSkillScenarioId(selectedScenarioId)) {
    const Icon = CREATE_SKILL_SCENARIO_ICONS[selectedScenarioId];
    const detail = scenarioDetails[selectedScenarioId];
    const updateScenarioValue = (fieldId: string, value: string) => {
      setScenarioValues((current) => ({ ...current, [fieldId]: value }));
    };
    const notes = [
      `Scenario: ${scenarioTitles[selectedScenarioId]}`,
      `Description: ${scenarioDescriptions[selectedScenarioId]}`,
      ...detail.fields.map((field) => `${field.label}: ${scenarioValues[field.id]?.trim() || "Not provided"}`),
      `Workflow: ${detail.workflow.join(" -> ")}`,
      "Create a reusable Hermes skill that follows this scenario, asks for missing inputs when needed, and validates the final output against the user's preferences.",
    ].join("\n");
    const scenarioSkillName = scenarioValues.skillName?.trim() || "";
    const learnTrigger = learnSkillTriggerFactory ? (
      <span key={`${selectedScenarioId}-${notes}-${scenarioSkillName}`}>
        {learnSkillTriggerFactory({
          initialSkillName: scenarioSkillName,
          initialUrl: scenarioValues.url ?? "",
          initialNotes: notes,
          triggerLabel: t("学习"),
          hideNotes: true,
          hideName: true,
        })}
      </span>
    ) : learnSkillTrigger;

    return (
      <div className="min-h-[calc(100dvh-220px)] space-y-6 pb-16">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setSelectedScenarioId(null);
              setScenarioValues({});
            }}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-black/[0.08] bg-white px-3 text-sm font-semibold text-black/70 transition-colors hover:bg-black/[0.035] hover:text-black/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("返回")}
          </button>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase text-black/35">
            <BookOpen className="size-3.5" aria-hidden="true" />
            {t("场景工作流")}
          </span>
        </div>

        <section
          className="relative overflow-hidden rounded-md px-5 py-7 text-white sm:px-8"
          style={{ backgroundImage: `url(${detail.image})`, backgroundPosition: "center" }}
        >
          <div className={cn("absolute inset-0", detail.overlayClassName)} aria-hidden="true" />
          <div className="relative z-10 max-w-[720px]">
            <span className={cn("flex size-12 items-center justify-center rounded-full", detail.iconClassName)}>
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <h3 className="mt-4 text-2xl font-semibold leading-8 text-balance">
              {scenarioTitles[selectedScenarioId]}
            </h3>
            <p className="mt-1 max-w-[680px] text-sm font-medium leading-6 text-white/80 text-pretty">
              {scenarioDescriptions[selectedScenarioId]}
            </p>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-5">
            <div>
              <p className="text-sm font-semibold text-black/85">{t("先告诉 Agent 这些")}</p>
              <p className="mt-1 text-sm leading-6 text-black/50 text-pretty">
                {t("这些信息会作为 /learn 的场景简报，并可在技能运行时继续追问。")}
              </p>
            </div>
            <div className="space-y-4">
              {detail.fields.map((field, index) => {
                const fieldId = `create-skill-${selectedScenarioId}-${field.id}`;
                return (
                  <div key={field.id} className="space-y-2">
                    <Label htmlFor={fieldId} className="flex items-center gap-2 text-sm font-semibold text-black/75">
                      <span className="flex size-5 items-center justify-center rounded-full bg-black/[0.05] text-[11px] text-black/45">
                        {index + 1}
                      </span>
                      {field.label}
                      {index > 0 ? <span className="font-normal text-black/40">({t("可选")})</span> : null}
                    </Label>
                    {field.multiline ? (
                      <Textarea
                        id={fieldId}
                        value={scenarioValues[field.id] ?? ""}
                        onChange={(event) => updateScenarioValue(field.id, event.target.value)}
                        placeholder={field.placeholder}
                        className="min-h-24 resize-y rounded-md border-black/[0.1] bg-white text-sm leading-6"
                      />
                    ) : (
                      <Input
                        id={fieldId}
                        value={scenarioValues[field.id] ?? ""}
                        onChange={(event) => updateScenarioValue(field.id, event.target.value)}
                        placeholder={field.placeholder}
                        className="rounded-md border-black/[0.1] bg-white text-sm"
                      />
                    )}
                  </div>
                );
              })}
              <div className="space-y-2">
                <Label htmlFor={`create-skill-${selectedScenarioId}-url`} className="flex items-center gap-2 text-sm font-semibold text-black/75">
                  <Link2 className="size-4 text-black/40" aria-hidden="true" />
                  {detail.urlLabel}
                  <span className="font-normal text-black/40">({t("可选")})</span>
                </Label>
                <Input
                  id={`create-skill-${selectedScenarioId}-url`}
                  type="url"
                  value={scenarioValues.url ?? ""}
                  onChange={(event) => updateScenarioValue("url", event.target.value)}
                  placeholder={detail.urlPlaceholder}
                  className="rounded-md border-black/[0.1] bg-white text-sm"
                />
              </div>
            </div>
          </div>

          <div className="flex h-full min-w-0 flex-col">
            <aside className="h-fit rounded-md border border-black/[0.06] bg-[#F8FAF9] p-4 pb-7">
              <div className="flex items-center gap-2 text-sm font-semibold text-black/80">
                <Layers3 className="size-4 text-[#4C8279]" aria-hidden="true" />
                {t("Hermes 将这样处理")}
              </div>
              <ol className="mt-4 space-y-3">
                {detail.workflow.map((step, index) => (
                  <li key={step} className="flex items-start gap-2.5 text-sm leading-5 text-black/60">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-[#4C8279] shadow-sm">
                      {index + 1}
                    </span>
                    <span className="text-pretty">{step}</span>
                  </li>
                ))}
              </ol>
            </aside>
            <div className="mt-auto flex w-full flex-nowrap items-center justify-end gap-3 pt-4">
              <div className="w-40 shrink-0 border-b border-black/20 sm:w-44">
                <Label htmlFor={`create-skill-${selectedScenarioId}-name`} className="sr-only">
                  {t("命名你的技能")}
                </Label>
                <Input
                  id={`create-skill-${selectedScenarioId}-name`}
                  value={scenarioValues.skillName ?? ""}
                  onChange={(event) => updateScenarioValue("skillName", event.target.value)}
                  placeholder={t("命名你的技能")}
                  className="h-9 rounded-none border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                />
              </div>
              {learnTrigger ?? (
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <Sparkles className="size-4" aria-hidden="true" />
                  {t("学习")}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-7">
        <aside className="min-w-0">
          <nav
            aria-label={t("技能创建类别")}
            className="flex gap-1 overflow-x-auto border-b border-black/[0.06] pb-1 lg:block lg:space-y-1 lg:border-b-0 lg:pb-0"
          >
            {CREATE_SKILL_CATEGORIES.map((category, index) => {
              const Icon = category.icon;
              const isActive = selectedCategoryId === category.id;
              return (
                <Fragment key={category.id}>
                  <button
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => {
                      setSelectedCategoryId(category.id);
                      setSelectedScenarioId(null);
                      setScenarioValues({});
                    }}
                    className={cn(
                      "inline-flex min-h-10 shrink-0 items-center gap-2 border-l-2 px-3 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] lg:flex lg:w-full",
                      isActive
                        ? "border-[#4C8279] bg-black/[0.025] text-black/90"
                        : "border-transparent text-black/45 hover:border-black/15 hover:text-black/75",
                    )}
                  >
                    <Icon className={cn("size-4", category.iconClassName)} aria-hidden="true" />
                    {categoryTitles[category.id]}
                  </button>
                  {index === 0 ? <div className="my-2 hidden h-px w-full bg-black/[0.08] lg:block" aria-hidden="true" /> : null}
                </Fragment>
              );
            })}
          </nav>
        </aside>

        <section
          className={cn(
            "min-w-0",
            selectedCategoryId !== "quick-learn" && "-mt-4 min-h-[760px] px-4 pb-10 pt-4 sm:px-5",
            selectedCategory?.galleryClassName,
          )}
        >
          {selectedCategoryId === "quick-learn" ? (
            learnSkillPanel ?? (
              <div className="rounded-md border border-black/[0.08] bg-white p-5 text-sm text-black/50">
                {t("学习表单暂不可用")}
              </div>
            )
          ) : (
            <>
          <div className="mb-3 flex min-h-10 items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-black/85">{categoryTitles[selectedCategoryId]}</h4>
            <span className="text-xs text-black/35">{t("选择一个场景开始")}</span>
          </div>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {categoryScenarios.map((scenario) => {
                const Icon = scenario.icon;
                const detail = scenarioDetails[scenario.id];
                return (
                  <li key={scenario.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedScenarioId(scenario.id);
                        setScenarioValues({});
                      }}
                      className="group relative flex min-h-[176px] w-full flex-col items-center justify-center overflow-hidden rounded-md border border-black/[0.06] bg-black px-5 py-6 text-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      style={{ backgroundImage: `url(${detail.image})`, backgroundPosition: "center" }}
                    >
                      <span className={cn("absolute inset-0 group-hover:opacity-75", detail.overlayClassName)} aria-hidden="true" />
                      <span className="relative z-10 flex flex-col items-center justify-center">
                        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-full", detail.iconClassName)}>
                          <Icon className="size-5" aria-hidden="true" />
                        </span>
                        <span className="mt-3 max-w-[220px] text-sm font-semibold leading-5 text-white text-pretty">
                          {scenarioTitles[scenario.id]}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
            </>
          )}
        </section>
      </div>

    </div>
  );
}

export function SkillsDemoPanel({
  botId,
  execDebugCommand,
  learnSkillTrigger,
  learnSkillPanel,
  learnSkillTriggerFactory,
  onTabChange,
}: {
  botId: string;
  execDebugCommand: ExpertsExecDebugCommand;
  learnSkillTrigger?: ReactNode;
  learnSkillPanel?: ReactNode;
  learnSkillTriggerFactory?: (options: LearnSkillTriggerOptions) => ReactNode;
  onTabChange?: (value: SkillsDemoTab) => void;
}) {
  const t = useT();
  const dataLayer = useMemo(
    () => createSkillsDataLayer(botId, execDebugCommand),
    [botId, execDebugCommand],
  );

  const [keyword, setKeyword] = useState("");
  const [activeTab, setActiveTab] = useState<SkillsDemoTab>("search");
  const [debounced, setDebounced] = useState("");
  const [registryFilter, setRegistryFilter] = useState<RegistryFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("popular");
  const [orgFilter, setOrgFilter] = useState<string | null>(null);

  const [clawhubResults, setClawhubResults] = useState<Skill[]>([]);
  const [skillsshResults, setSkillsshResults] = useState<Skill[]>([]);
  const [searching, setSearching] = useState(false);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [installedLoading, setInstalledLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [uninstallingKey, setUninstallingKey] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const refreshInstalled = useCallback(async () => {
    setInstalledLoading(true);
    try {
      const list = await dataLayer.listInstalled();
      setInstalled(list);
    } catch {
      setInstalled([]);
    } finally {
      setInstalledLoading(false);
    }
  }, [dataLayer]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // 加载默认页 Popular（无搜索时展示）
  useEffect(() => {
    let cancelled = false;
    dataLayer
      .getPopular()
      .then((res) => {
        if (!cancelled) setPopular(res);
      })
      .catch(() => {
        /* 忽略：Popular 失败不影响搜索 / 已安装 */
      });
    return () => {
      cancelled = true;
    };
  }, [dataLayer]);

  // 防抖搜索
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebounced(keyword);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [keyword]);

  useEffect(() => {
    let cancelled = false;
    const kw = debounced.trim();
    if (!kw) {
      setClawhubResults([]);
      setSkillsshResults([]);
      return;
    }
    setSearching(true);
    setOrgFilter(null);
    dataLayer
      .search(kw)
      .then((res) => {
        if (cancelled) return;
        setClawhubResults(res.clawhub);
        setSkillsshResults(res.skillssh);
      })
      .catch(() => {
        if (cancelled) return;
        setClawhubResults([]);
        setSkillsshResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataLayer, debounced]);

  const installedSlugSet = useMemo(() => {
    const set = new Set<string>();
    installed.forEach((s) => set.add(s.slug.toLowerCase()));
    return set;
  }, [installed]);

  const isInstalled = useCallback(
    (skill: Skill) => installedSlugSet.has(skill.slug.toLowerCase()),
    [installedSlugSet],
  );

  // 当前结果集（按 registry 过滤）
  const visibleResults = useMemo(() => {
    const pool =
      registryFilter === "all"
        ? mergeSkills(clawhubResults, skillsshResults)
        : registryFilter === "clawhub"
          ? clawhubResults
          : skillsshResults;
    const orgFiltered = orgFilter
      ? pool.filter((s) => (s.sourceOrg ?? s.author ?? "").toLowerCase() === orgFilter)
      : pool;
    return sortMode === "popular" ? sortByPopular(orgFiltered) : sortByName(orgFiltered);
  }, [clawhubResults, skillsshResults, registryFilter, orgFilter, sortMode]);

  // Popular 默认页（无搜索时）：通过 dataLayer.getPopular() 获取，避免跨模块直连 fixtures。
  const [popular, setPopular] = useState<{ clawhub: Skill[]; skillssh: Skill[] }>({
    clawhub: [],
    skillssh: [],
  });
  const popularClawhub = popular.clawhub.slice(0, 6);
  const popularSkillssh = popular.skillssh.slice(0, 6);
  const hasSearch = debounced.trim().length > 0;

  // 当前结果集来源组织分类项（用于「按来源分类」筛选）
  const orgOptions = useMemo(() => {
    const counts = new Map<string, number>();
    visibleResults.forEach((s) => {
      const key = (s.sourceOrg ?? s.author ?? "").trim();
      if (!key) return;
      counts.set(key.toLowerCase(), (counts.get(key.toLowerCase()) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [visibleResults]);

  const handleInstall = useCallback(
    async (skill: Skill) => {
      if (installingId) return;
      const id = `${skill.registry}:${skill.slug}`;
      setInstallingId(id);
      try {
        const result = await dataLayer.install(skill);
        if (result.ok) {
          toast.success({ content: t("已安装技能 {{name}}", { name: skill.name }) });
          await refreshInstalled();
        } else {
          toast.error({ content: result.message || t("安装失败") });
        }
      } catch (error) {
        toast.error({ content: error instanceof Error ? error.message : t("安装失败") });
      } finally {
        setInstallingId(null);
      }
    },
    [dataLayer, installingId, refreshInstalled, t],
  );

  const handleUninstall = useCallback(
    async (skill: InstalledSkill) => {
      if (uninstallingKey) return;
      // 双来源归属时按主 registry（InstalledSkill.registry）卸载；如需要可扩展为两个都卸载。
      const key = `${skill.registry}:${skill.slug}`;
      setUninstallingKey(key);
      try {
        const result = await dataLayer.uninstall(skill);
        if (result.ok) {
          toast.success({ content: t("已删除技能 {{name}}", { name: skill.name }) });
          await refreshInstalled();
        } else {
          toast.error({ content: result.message || t("删除失败") });
        }
      } catch (error) {
        toast.error({ content: error instanceof Error ? error.message : t("删除失败") });
      } finally {
        setUninstallingKey(null);
      }
    },
    [dataLayer, refreshInstalled, t, uninstallingKey],
  );

  const registryFilters: Array<{ value: RegistryFilter; label: string }> = [
    { value: "all", label: t("全部") },
    { value: "clawhub", label: "ClawHub" },
    { value: "skills-sh", label: "skills.sh" },
  ];

  return (
    <div className={CLS}>
      {/* 数据通道提示（仅 demo 期） */}
      {!SKILLS_DEMO_LIVE ? (
        <div className="mb-3 rounded-md border border-[#FFE7BA] bg-[#FFF7E6] px-3 py-2 text-[11px] leading-5 text-[#8A5A00]">
          {t("演示模式：使用联调样例数据。切换 SKILLS_DEMO_LIVE=true 即走 acli 真实联调。")}
        </div>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value !== "search" && value !== "create" && value !== "installed") return;
          const nextTab = value as SkillsDemoTab;
          setActiveTab(nextTab);
          onTabChange?.(nextTab);
        }}
        className="min-w-0"
      >
        <TabsList
          aria-label={t("技能市场页面切换")}
          className="mb-4 !h-9 w-full !justify-start gap-7 !rounded-none !border-0 !border-b !border-black/[0.08] !bg-transparent !p-0 !shadow-none"
        >
          <TabsTrigger
            value="search"
            className="relative !h-9 !min-w-0 !rounded-none !bg-transparent !px-0 !py-0 pb-2 text-sm font-medium text-black/55 !shadow-none transition-colors after:absolute after:bottom-[-1px] after:left-0 after:h-0.5 after:w-full after:bg-transparent hover:text-black/80 data-[state=active]:!bg-transparent data-[state=active]:text-black/90 data-[state=active]:!shadow-none data-[state=active]:after:bg-black"
          >
            {t("搜索")}
          </TabsTrigger>
          <TabsTrigger
            value="create"
            className="relative !h-9 !min-w-0 !rounded-none !bg-transparent !px-0 !py-0 pb-2 text-sm font-medium text-black/55 !shadow-none transition-colors after:absolute after:bottom-[-1px] after:left-0 after:h-0.5 after:w-full after:bg-transparent hover:text-black/80 data-[state=active]:!bg-transparent data-[state=active]:text-black/90 data-[state=active]:!shadow-none data-[state=active]:after:bg-black"
          >
            {t("创建技能")}
          </TabsTrigger>
          <TabsTrigger
            value="installed"
            className="relative !h-9 !min-w-0 !rounded-none !bg-transparent !px-0 !py-0 pb-2 text-sm font-medium text-black/55 !shadow-none transition-colors after:absolute after:bottom-[-1px] after:left-0 after:h-0.5 after:w-full after:bg-transparent hover:text-black/80 data-[state=active]:!bg-transparent data-[state=active]:text-black/90 data-[state=active]:!shadow-none data-[state=active]:after:bg-black"
          >
            {t("我的技能")}
            {!installedLoading ? (
              <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-black/[0.06] px-1.5 text-[11px] font-medium text-black/45 tabular-nums">
                {installed.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="search" className="mt-0">
          {/* 搜索 + 过滤 */}
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-black/35" aria-hidden="true" />
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={t("搜索 ClawHub / skills.sh 中的技能")}
                className="h-10 w-full rounded-md border border-black/10 bg-white pl-9 pr-9 text-sm text-black/90 outline-none transition-colors placeholder:text-black/35 focus:border-[#2F6BFF]"
              />
              {keyword ? (
                <button
                  type="button"
                  onClick={() => setKeyword("")}
                  aria-label={t("清除搜索")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-black/35 hover:text-black/60"
                >
                  {searching ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <X className="size-4" aria-hidden="true" />}
                </button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-md bg-black/[0.04] p-0.5">
              {registryFilters.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRegistryFilter(opt.value)}
                  className={cn(
                    "h-9 rounded-[6px] px-2.5 text-xs font-semibold transition-all",
                    registryFilter === opt.value
                      ? "bg-white text-black/85 shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                      : "text-black/45 hover:text-black/70",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-md bg-black/[0.04] p-0.5">
              <button
                type="button"
                onClick={() => setSortMode("popular")}
                className={cn(
                  "h-9 rounded-[6px] px-2.5 text-xs font-semibold transition-all",
                  sortMode === "popular"
                    ? "bg-white text-black/85 shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                    : "text-black/45 hover:text-black/70",
                )}
              >
                {t("热门")}
              </button>
              <button
                type="button"
                onClick={() => setSortMode("name")}
                className={cn(
                  "h-9 rounded-[6px] px-2.5 text-xs font-semibold transition-all",
                  sortMode === "name"
                    ? "bg-white text-black/85 shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                    : "text-black/45 hover:text-black/70",
                )}
              >
                {t("名称")}
              </button>
            </div>
          </div>

          {/* 搜索结果 / Popular */}
          {hasSearch ? (
            <div>
              {orgOptions.length > 1 ? (
                <div className="mb-2.5 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOrgFilter(null)}
                    className={cn(
                      "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-colors",
                      orgFilter === null
                        ? "border-black/32 bg-black/[0.055] text-black/90"
                        : "border-black/[0.08] bg-white text-black/60 hover:border-black/18",
                    )}
                  >
                    {t("全部来源")}
                  </button>
                  {orgOptions.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setOrgFilter((current) => (current === opt.key ? null : opt.key))}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors",
                        orgFilter === opt.key
                          ? "border-black/32 bg-black/[0.055] text-black/90"
                          : "border-black/[0.08] bg-white text-black/60 hover:border-black/18",
                      )}
                    >
                      {opt.label}
                      <span className="text-[10px] text-black/35">{opt.count}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              <SectionTitle count={visibleResults.length}>{t("搜索结果")}</SectionTitle>
              {searching ? (
                <div className="flex items-center gap-2 rounded-md bg-white px-4 py-6 text-sm text-black/45">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t("搜索中...")}
                </div>
              ) : visibleResults.length === 0 ? (
                <div className="rounded-md bg-white px-4 py-8 text-center text-sm text-black/40">
                  {t("没有找到匹配的技能")}
                </div>
              ) : (
                <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {visibleResults.map((skill) => (
                    <SkillCard
                      key={`${skill.registry}:${skill.rawId}`}
                      skill={skill}
                      installed={isInstalled(skill)}
                      installing={installingId === `${skill.registry}:${skill.slug}`}
                      onInstall={handleInstall}
                    />
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              {popularSkillssh.length > 0 ? (
                <div>
                  <SectionTitle>{t("skills.sh 热门")}</SectionTitle>
                  <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {popularSkillssh.map((skill) => (
                      <SkillCard
                        key={`popular-ss:${skill.registry}:${skill.rawId}`}
                        skill={skill}
                        installed={isInstalled(skill)}
                        installing={installingId === `${skill.registry}:${skill.slug}`}
                        onInstall={handleInstall}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
              {popularClawhub.length > 0 ? (
                <div>
                  <SectionTitle>{t("ClawHub 热门")}</SectionTitle>
                  <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {popularClawhub.map((skill) => (
                      <SkillCard
                        key={`popular-ch:${skill.registry}:${skill.rawId}`}
                        skill={skill}
                        installed={isInstalled(skill)}
                        installing={installingId === `${skill.registry}:${skill.slug}`}
                        onInstall={handleInstall}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
              {popularClawhub.length === 0 && popularSkillssh.length === 0 ? (
                <div className="rounded-md bg-white px-4 py-8 text-center text-sm text-black/40">
                  {t("输入关键词搜索 ClawHub 与 skills.sh 中的技能")}
                </div>
              ) : null}
            </div>
          )}
        </TabsContent>

        <TabsContent value="create" className="mt-0">
          <CreateSkillPanel
            learnSkillTrigger={learnSkillTrigger}
            learnSkillPanel={learnSkillPanel}
            learnSkillTriggerFactory={learnSkillTriggerFactory}
          />
        </TabsContent>

        <TabsContent value="installed" className="mt-0">
          <SectionTitle count={installedLoading ? undefined : installed.length}>{t("我的技能")}</SectionTitle>
          <div className="rounded-md border border-black/[0.06] bg-white">
            {installedLoading ? (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-black/45">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("加载中...")}
              </div>
            ) : installed.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-black/40">{t("还没有已安装的技能")}</div>
            ) : (
              <ul className="px-3 py-1">
                {installed.map((skill) => (
                  <InstalledRow
                    key={`${skill.registries.join(",")}-${skill.slug}`}
                    skill={skill}
                    uninstalling={uninstallingKey === `${skill.registry}:${skill.slug}`}
                    onUninstall={handleUninstall}
                  />
                ))}
              </ul>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-5 text-black/40">
            {t("来源通过 ClawHub + skills.sh 已安装列表交叉判定，避免显示为「未知来源」。")}
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
