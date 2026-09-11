// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * SkillsDemoPanel —— 国际站技能浏览 / 安装面板（mono2 自有，不依赖 TEA SDK）。
 *
 * 数据来源：skill-registries.ts（mock 联调样例 / live acli 命令）。
 * 关键能力：
 *  - 同时展示 ClawHub + skills.sh 两个 registry，每条技能标注来源
 *  - 「已安装」区通过双 list 交叉判定来源，修正 SDK 的 Unknown Source
 *  - Popular 排序 + registry 过滤 + 来源组织分类，便于后续做推荐位 / 分类位
 *
 * 仅国际站渲染（见 agent-skills-panel.tsx 的 isGlobal 分支）。
 */

import {
  ArrowLeft,
  BookOpen,
  Briefcase,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Compass,
  Flame,
  FileText,
  Globe2,
  HeartPulse,
  Hotel,
  Languages,
  Link2,
  Layers3,
  Loader2,
  Palette,
  PenLine,
  Plane,
  Plus,
  Repeat2,
  Search,
  Sparkles,
  Trash2,
  Utensils,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { useT } from "../../../i18n/t";
import { toast } from "../../../lib/toast";
import { cn } from "../../../lib/utils";

import type { ExpertsExecDebugCommand } from "../agent-experts-panel";
import {
  getSkillSourceUrl,
  getPopularityTier,
  installSkillsInBatch,
  mergeSkills,
  REGISTRY_LABEL,
  SKILLS_DEMO_LIVE,
  skillIdentity,
  sortByPopular,
  sortByName,
  type InstalledSkill,
  type Registry,
  type SearchRegistry,
  type Skill,
  type SkillsDataLayer,
  type SkillsExecDebugCommandStream,
} from "./skill-registries";
import {
  CURATED_SKILL_CATEGORIES,
} from "./curated-skill-categories";
import {
  DOMESTIC_FEATURED_SKILLS,
  DOMESTIC_SKILL_CATEGORIES,
} from "./domestic-skill-catalog";
import {
  getCuratedSkillOverview,
  type CuratedSkillBullet,
  type CuratedSkillOverview,
  type CuratedSkillOverviewLocale,
} from "./curated-skill-overviews";

type RegistryFilter = "all" | Exclude<Registry, "hermes">;
type InstalledSourceFilter = "all" | `registry:${Registry}` | `native:${string}`;
type InstalledCategoryFilter = "all" | `category:${string}`;

type InstalledSourceDescriptor = {
  key: Exclude<InstalledSourceFilter, "all">;
  label: string;
  registry?: Registry;
  sourceUrl?: string;
};

type Translate = ReturnType<typeof useT>;
type SortMode = "popular" | "name";
type SkillCategoryLabel = {
  zh: string;
  en: string;
  id?: string; es?: string; ja?: string; ko?: string;
};
type SearchInstallRowStatus = {
  status: "pending" | "installing" | "retrying" | "done" | "failed" | "skipped";
  message?: string;
};
type BatchInstallProgress = { index: number; total: number; currentName: string };
export type SkillsDemoTab = "discover" | "experts" | "create" | "installed";

const SEARCH_RESULTS_PREVIEW_LIMIT = 12;
const INSTALLED_PAGE_SIZE = 10;
const UNCATEGORIZED_INSTALLED_CATEGORY = "__uncategorized__";
const INSTALLED_SOURCE_ORDER: Partial<Record<Exclude<InstalledSourceFilter, "all">, number>> = {
  "registry:skillhub": 0,
  "native:builtin": 1,
  "native:local": 2,
};
const FEATURED_BATCH_SIZE = 3;
const SKILL_ICON_FALLBACK = "/assets/skills/gemini.svg";
const KNOWN_INSTALLED_IDS_STORAGE_PREFIX = "lightvela-skills-demo-known-installed";

function knownInstalledIdsStorageKey(botId: string): string {
  return `${KNOWN_INSTALLED_IDS_STORAGE_PREFIX}:${botId}`;
}

function readKnownInstalledIds(botId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(knownInstalledIdsStorageKey(botId));
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeKnownInstalledIds(botId: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(knownInstalledIdsStorageKey(botId), JSON.stringify([...ids]));
  } catch {
    // Ignore storage failures; the live installed list remains authoritative when it contains full IDs.
  }
}

function rememberedIdMatchesSkill(id: string, skill: Pick<Skill, "registry" | "rawId" | "slug">): boolean {
  const prefix = `${skill.registry}:`;
  if (!id.startsWith(prefix)) return false;
  const rawId = id.slice(prefix.length);
  return rawId === skill.rawId.trim().toLowerCase() || rawId.split("/").pop() === skill.slug.trim().toLowerCase();
}

function rememberedIdExistsInInstalledList(id: string, skills: InstalledSkill[]): boolean {
  const separatorIndex = id.indexOf(":");
  if (separatorIndex <= 0) return false;
  const registry = id.slice(0, separatorIndex);
  if (registry !== "clawhub" && registry !== "skills-sh" && registry !== "skillhub" && registry !== "hermes") {
    return false;
  }
  const rawId = id.slice(separatorIndex + 1).trim().toLowerCase();
  const shortSlug = rawId.split("/").pop();
  const matchesIdentity = (skill: InstalledSkill) => {
    const candidates = [skill.rawId, skill.slug, ...(skill.nativeAliases ?? [])]
      .map((value) => value.trim().toLowerCase());
    return candidates.includes(rawId) || (shortSlug ? candidates.includes(shortSlug) : false);
  };

  if (skills.some((skill) => skill.registries.includes(registry) && matchesIdentity(skill))) return true;

  const matchingMarketplaceSkills = skills.filter((skill) => (
    skill.registry !== "hermes" && matchesIdentity(skill)
  ));
  if (matchingMarketplaceSkills.length > 0) return false;

  return skills.filter((skill) => skill.registry === "hermes" && matchesIdentity(skill)).length === 1;
}

function getSearchInstallRowStatus(message?: string): SearchInstallRowStatus {
  return /skip|跳过/i.test(message ?? "")
    ? { status: "skipped", message }
    : { status: "failed", message };
}

type FeaturedSkillId =
  | "self-improving-agent"
  | "find-skills"
  | "weather"
  | "caveman"
  | "to-issues"
  | "simple";

const FEATURED_SKILLS: ReadonlyArray<{
  id: FeaturedSkillId;
  skill: Skill;
  heroImageSrc: string;
  heroClassName: string;
}> = [
  {
    id: "self-improving-agent",
    skill: {
      registry: "skills-sh",
      rawId: "charon-fan/agent-playbook/self-improving-agent",
      slug: "self-improving-agent",
      name: "Self-Improving Agent",
      sourceOrg: "charon-fan/agent-playbook",
    },
    heroImageSrc: "/assets/skills/featured-self-improving-agent.jpg",
    heroClassName: "bg-[#347566]",
  },
  {
    id: "find-skills",
    skill: {
      registry: "skills-sh",
      rawId: "vercel-labs/skills/find-skills",
      slug: "find-skills",
      name: "Find Skills",
      sourceOrg: "vercel-labs/skills",
    },
    heroImageSrc: "/assets/skills/featured-find-skills.jpg",
    heroClassName: "bg-[#3A6F9B]",
  },
  {
    id: "weather",
    skill: {
      registry: "skills-sh",
      rawId: "steipete/clawdis/weather",
      slug: "weather",
      name: "Weather",
      sourceOrg: "steipete/clawdis",
    },
    heroImageSrc: "/assets/skills/featured-weather.jpg",
    heroClassName: "bg-[#B87821]",
  },
  {
    id: "caveman",
    skill: {
      registry: "skills-sh",
      rawId: "juliusbrussee/caveman/caveman",
      slug: "caveman",
      name: "Caveman",
      sourceOrg: "juliusbrussee/caveman",
    },
    heroImageSrc: "/assets/skills/featured-caveman.jpg",
    heroClassName: "bg-[#2D3036]",
  },
  {
    id: "to-issues",
    skill: {
      registry: "skills-sh",
      rawId: "mattpocock/skills/to-issues",
      slug: "to-issues",
      name: "To Issues",
      sourceOrg: "mattpocock/skills",
    },
    heroImageSrc: "/assets/skills/featured-to-issues.jpg",
    heroClassName: "bg-[#5E59A6]",
  },
  {
    id: "simple",
    skill: {
      registry: "skills-sh",
      rawId: "roin-orca/skills/simple",
      slug: "simple",
      name: "Simple",
      sourceOrg: "roin-orca/skills",
    },
    heroImageSrc: "/assets/skills/featured-simple.jpg",
    heroClassName: "bg-[#65B9A8]",
  },
] as const;

type FeaturedSkillEntry = {
  id: string;
  skill: Skill;
  heroImageSrc: string;
  heroClassName: string;
};

type SkillDetailsEntry = {
  skill: Skill;
  overview: CuratedSkillOverview;
};

export type SkillsDemoMode = "global" | "domestic";

/**
 * 未被 curated 数据集收录的 Skill 走这套兜底概览。
 *
 * 文案统一走 `t()` 而非中英二元字面量 —— 否则印尼语等语言会落到英文。
 * 因为本函数在模块作用域，`t` 由调用方（组件内）注入。
 */
function getSkillOverview(
  skill: Skill,
  overviewLocale: CuratedSkillOverviewLocale,
  t: (zh: string, options?: Record<string, unknown>) => string,
): CuratedSkillOverview {
  try {
    return getCuratedSkillOverview(skill.rawId, overviewLocale);
  } catch {
    const description = skill.description?.trim()
      || t("该技能来自 SkillHub，可根据名称和描述帮助智能体完成对应任务。");
    const bullet = (title: string, text: string): CuratedSkillBullet => ({ title, description: text });
    return {
      overview: [description, t("安装后，智能体可以在对话中按需调用该技能。")],
      whoShouldUse: [
        bullet(t("需要这项能力的用户"), t("希望把这类任务交给智能体处理。")),
        bullet(t("团队成员"), t("需要可复用、统一的工作方式。")),
      ],
      problemsItSolves: [
        bullet(t("重复查找"), t("减少每次重新说明任务背景的成本。")),
        bullet(t("流程不统一"), t("让相似任务更容易按同一套步骤完成。")),
      ],
      keyCapabilities: [
        bullet(t("任务理解"), description),
        bullet(t("结构化处理"), t("根据输入整理并执行相关步骤。")),
        bullet(t("结果输出"), t("生成适合当前任务的结果。")),
      ],
      basicUsage: t("安装技能后，直接描述目标并提供必要的资料或约束。"),
      examplePrompt: t("请使用“{{name}}”完成这项任务，并先说明需要哪些输入。", { name: skill.name }),
    };
  }
}

function getCategoryLabel(label: SkillCategoryLabel, overviewLocale: CuratedSkillOverviewLocale): string {
  const labelByLocale: Partial<Record<CuratedSkillOverviewLocale, string>> = {
    "zh-CN": label.zh,
    "id-ID": label.id, es: label.es, "ja-JP": label.ja, "ko-KR": label.ko ?? label.en,
    "en-US": label.en,
  };

  return labelByLocale[overviewLocale] ?? label.en;
}

const CLS = "lv-skills-demo";
const SKILLS_SEARCH_BOX_CLASS = "lv-agent-search-box";
const SKILLS_SEARCH_ICON_CLASS = "lv-agent-search-box-icon";
const SKILLS_SEARCH_INPUT_CLASS = "lv-skills-search-input lv-agent-search-box-input";
const SEARCH_INPUT_NATIVE_CLEAR_CLASS = "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none";

type CreateSkillCategoryId = "quick-learn" | "workplace" | "research" | "learning" | "creative" | "personal" | "leisure";

const CREATE_SKILL_CATEGORIES: ReadonlyArray<{
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
] as const satisfies ReadonlyArray<{
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

function getCreateSkillScenarioDetails(t: ReturnType<typeof useT>): Record<CreateSkillScenarioId, {
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

function RegistryBadge({ registry, href }: { registry: Registry; href?: string }) {
  const isSkillsSh = registry === "skills-sh";
  const isSkillHub = registry === "skillhub";
  const isHermes = registry === "hermes";
  const className = cn(
    "inline-flex h-5 items-center rounded-[5px] px-1.5 text-[10px] font-semibold leading-none",
    isSkillsSh
      ? "bg-[#FFF6E6] text-[#B26A00]"
      : isSkillHub
        ? "bg-[#EAF6F1] text-[#287458]"
        : isHermes
          ? "bg-black/[0.06] text-black/60"
          : "bg-[#EAF1FF] text-[#2F6BFF]",
  );
  if (!href) return <span className={className}>{REGISTRY_LABEL[registry]}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(className, "underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]")}
    >
      {REGISTRY_LABEL[registry]}
    </a>
  );
}

function getInstalledSources(skill: InstalledSkill): InstalledSourceDescriptor[] {
  const registries = Array.from(new Set(skill.registries));
  const marketplaceRegistries = registries.filter((registry) => registry !== "hermes");
  if (marketplaceRegistries.length > 0) {
    return marketplaceRegistries.map((registry) => ({
      key: `registry:${registry}`,
      label: REGISTRY_LABEL[registry],
      registry,
      sourceUrl: skill.sourceUrls?.[registry],
    }));
  }
  const nativeSource = skill.nativeSource?.trim().toLowerCase() || "other";
  return [{
    key: `native:${nativeSource}`,
    label: skill.sourceLabel || "其他",
  }];
}

function translateInstalledSourceLabel(t: Translate, label: string): string {
  if (label === "系统预置") return t("系统预置");
  if (label === "本地安装") return t("本地安装");
  if (label === "其他") return t("其他");
  if (label === "未知来源") return t("未知来源");
  if (label === "来源暂不可用") return t("来源暂不可用");
  return label;
}

function getInstalledCategoryKey(category?: string): InstalledCategoryFilter {
  return `category:${category?.trim().toLowerCase() || UNCATEGORIZED_INSTALLED_CATEGORY}`;
}

function InstalledSourceBadge({ source }: { source: InstalledSourceDescriptor }) {
  const t = useT();
  if (source.registry) return <RegistryBadge registry={source.registry} href={source.sourceUrl} />;
  return (
    <span className="inline-flex h-5 items-center rounded-[5px] bg-black/[0.06] px-1.5 text-[10px] font-semibold leading-none text-black/60">
      {translateInstalledSourceLabel(t, source.label)}
    </span>
  );
}

function getInstalledCategoryLabel(t: Translate, category?: string): string {
  const normalized = category?.trim().toLowerCase();
  if (!normalized) return t("未分类");
  switch (normalized) {
    case "autonomous-ai-agents": return t("自主智能体");
    case "creative": return t("创意");
    case "data-science": return t("数据科学");
    case "devops": return t("运维");
    case "email": return t("邮件");
    case "gaming": return t("游戏");
    case "github": return "GitHub";
    case "mcp": return "MCP";
    case "media": return t("媒体");
    case "mlops": return t("机器学习运维");
    case "note-taking": return t("笔记");
    case "productivity": return t("效率工具");
    case "red-teaming": return t("红队测试");
    case "research": return t("研究");
    case "smart-home": return t("智能家居");
    case "social-media": return t("社交媒体");
    case "software-development": return t("软件开发");
    default: return category?.trim() || t("未分类");
  }
}

function getInstalledStatusLabel(t: Translate, status?: string): string | null {
  const normalized = status?.trim().toLowerCase();
  if (!normalized || normalized === "installed" || normalized === "enabled") return null;
  if (normalized === "disabled") return t("已禁用");
  if (normalized === "failed") return t("失败");
  return status?.trim() || null;
}

function getInstalledDisplayId(skill: InstalledSkill): string {
  return skill.slug.trim() || skill.rawId;
}

function SkillIcon({
  skill,
  className,
  loading = "lazy",
}: {
  skill: Skill;
  className: string;
  loading?: "eager" | "lazy";
}) {
  const src = skill.registry === "skillhub" && skill.iconUrl ? skill.iconUrl : SKILL_ICON_FALLBACK;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={36}
      height={36}
      loading={loading}
      className={className}
      onError={(event) => {
        event.currentTarget.onerror = null;
        event.currentTarget.src = SKILL_ICON_FALLBACK;
      }}
    />
  );
}

function BatchSelectButton({
  skill,
  selected,
  disabled,
  onToggle,
}: {
  skill: Skill;
  selected: boolean;
  disabled: boolean;
  onToggle: (skill: Skill) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => onToggle(skill)}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={selected
        ? t("取消批量安装 {{name}}", { name: skill.name })
        : t("选择批量安装 {{name}}", { name: skill.name })}
      title={selected ? t("取消选择") : t("选择")}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded-[4px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:opacity-55",
        selected
          ? "border-black bg-black text-white"
          : "border-black/20 bg-white text-transparent hover:border-black/40",
      )}
    >
      <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
    </button>
  );
}

function SkillCard({
  skill,
  installed,
  installing,
  onInstall,
  onOpenDetails,
  description,
  selected = false,
  disabled = false,
  onToggleSelected,
}: {
  skill: Skill;
  installed: boolean;
  installing: boolean;
  onInstall: (skill: Skill) => void;
  onOpenDetails?: (skill: Skill) => void;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  onToggleSelected?: (skill: Skill) => void;
}) {
  const t = useT();
  const popularityTier = getPopularityTier(skill);
  const content = (
    <>
      <SkillIcon skill={skill} className="mt-0.5 size-9 shrink-0 object-contain" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-black/90">{skill.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-black/45">
          <span className={cn(description ? "line-clamp-1 text-xs leading-4" : "truncate")}>
            {description ?? skill.rawId}
          </span>
          {skill.author ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="text-black/30">·</span> @{skill.author}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-black/55">
          <RegistryBadge registry={skill.registry} />
          {popularityTier ? (
            <span className="inline-flex items-center gap-1 text-[#C66A1A]" aria-label={t("热门")} title={t("热门")}>
              <Flame className="size-3.5" aria-hidden="true" />
              <span>{t("热门")}</span>
            </span>
          ) : null}
        </div>
      </div>
    </>
  );

  return (
    <li className="relative flex items-start gap-3 rounded-md border border-black/[0.06] bg-white px-3.5 py-3 transition-colors hover:border-black/[0.12] hover:bg-black/[0.025]">
      {onOpenDetails ? (
        <button
          type="button"
          onClick={() => onOpenDetails(skill)}
          className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
          aria-label={t("查看{{name}}详情", { name: skill.name })}
        />
      ) : null}
      <div className="pointer-events-none flex min-w-0 flex-1 items-start gap-3">{content}</div>
      <div className="relative z-10 flex shrink-0 items-center gap-1 self-center">
        {installed ? (
          <span
            className="inline-flex size-9 items-center justify-center text-[#82BDAE]"
            aria-label={t("已安装")}
            title={t("已安装")}
          >
            <Check className="size-5" aria-hidden="true" />
          </span>
        ) : (
          <>
            {onToggleSelected ? (
              <BatchSelectButton
                skill={skill}
                selected={selected}
                disabled={disabled || installing}
                onToggle={onToggleSelected}
              />
            ) : null}
            <button
              type="button"
              onClick={() => onInstall(skill)}
              disabled={disabled || installing}
              aria-label={t("安装")}
              title={t("安装")}
              className="inline-flex size-9 items-center justify-center border-0 bg-transparent text-[#4B5563] shadow-none transition-colors hover:text-[#374151] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-55"
            >
              {installing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-5" strokeWidth={2.25} aria-hidden="true" />}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function SearchSkillRow({
  skill,
  installed,
  installing,
  selected,
  disabled,
  rowStatus,
  showSourceLink,
  onInstall,
  onToggleSelected,
}: {
  skill: Skill;
  installed: boolean;
  installing: boolean;
  selected: boolean;
  disabled: boolean;
  rowStatus?: SearchInstallRowStatus;
  showSourceLink: boolean;
  onInstall: (skill: Skill) => void;
  onToggleSelected: (skill: Skill) => void;
}) {
  const t = useT();
  const statusLabel = rowStatus ? {
    pending: t("等待中"),
    installing: t("安装中..."),
    retrying: t("重试中..."),
    done: t("已安装"),
    failed: t("失败"),
    skipped: t("已跳过"),
  }[rowStatus.status] : null;
  const statusInProgress = rowStatus?.status === "installing" || rowStatus?.status === "retrying";
  const statusRetryable = rowStatus?.status === "failed" || rowStatus?.status === "skipped";
  const sourceUrl = showSourceLink
    ? skill.registry === "clawhub"
      ? "https://clawhub.ai/"
      : getSkillSourceUrl(skill)
    : undefined;

  return (
    <li className="flex min-w-0 items-start gap-3 border-b border-black/[0.07] bg-white px-4 py-3.5 transition-colors last:border-b-0 hover:bg-black/[0.02]">
      {installed ? (
        <span className="mt-2 size-5 shrink-0" aria-hidden="true" />
      ) : (
        <span className="mt-2 shrink-0">
          <BatchSelectButton
            skill={skill}
            selected={selected}
            disabled={disabled || installing}
            onToggle={onToggleSelected}
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold text-black/90">{skill.name}</span>
          <span className="max-w-full truncate rounded-sm border border-black/[0.07] bg-black/[0.025] px-1.5 py-0.5 font-mono text-[10px] text-black/40">
            {skill.rawId}
          </span>
        </div>
        {sourceUrl ? (
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-black/45">
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate text-[#2563EB] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              {t("来源")}
            </a>
          </div>
        ) : null}
        {skill.description ? (
          <p className="mt-1 line-clamp-1 text-pretty text-xs leading-5 text-black/45">{skill.description}</p>
        ) : null}
      </div>
      <div className="flex min-h-9 shrink-0 self-center items-center justify-center">
        {installed ? (
          <span className="inline-flex size-9 items-center justify-center text-[#82BDAE]" aria-label={t("已安装")} title={t("已安装")}>
            <Check className="size-5" aria-hidden="true" />
          </span>
        ) : rowStatus ? (
          <div className="flex shrink-0 items-center gap-2">
            <span
              aria-label={statusLabel ?? undefined}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium",
                rowStatus.status === "failed"
                  ? "bg-red-50 text-red-600"
                  : rowStatus.status === "done"
                    ? "bg-[#EAF6F1] text-[#237A64]"
                    : statusInProgress
                      ? "bg-blue-50 text-blue-600"
                      : "bg-black/[0.04] text-black/50",
              )}
              title={rowStatus.message}
            >
              {statusInProgress ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
              {statusLabel}
            </span>
            {statusRetryable ? (
              <button
                type="button"
                onClick={() => onInstall(skill)}
                disabled={disabled || installing}
                className="inline-flex h-7 items-center justify-center rounded-sm border border-black/10 px-2 text-xs font-medium text-black/60 transition-colors hover:border-black/20 hover:text-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-55"
              >
                {t("重试")}
              </button>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onInstall(skill)}
            disabled={disabled || installing}
            aria-label={t("安装")}
            title={t("安装")}
            className="inline-flex size-9 items-center justify-center border-0 bg-transparent text-[#4B5563] shadow-none transition-colors hover:text-[#374151] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-55"
          >
            {installing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-5" strokeWidth={2.25} aria-hidden="true" />}
          </button>
        )}
      </div>
    </li>
  );
}

function CuratedSkillDetailsDialog({
  entry,
  installed,
  installing,
  onInstall,
  onClose,
}: {
  entry: SkillDetailsEntry | null;
  installed: boolean;
  installing: boolean;
  onInstall: (skill: Skill) => void;
  onClose: () => void;
}) {
  const t = useT();
  if (!entry) return null;
  const { overview } = entry;
  const sourceUrl = getSkillSourceUrl(entry.skill);

  return (
    <div className="fixed inset-0 z-[100] flex overscroll-contain items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        aria-label={t("关闭")}
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
      />
      <div className="relative z-10 max-h-[calc(100dvh-24px)] w-full max-w-[820px] overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-xl sm:max-h-[calc(100dvh-48px)]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="curated-skill-dialog-title"
        className="lv-curated-skill-dialog-scroll relative max-h-[calc(100dvh-24px)] overflow-y-auto p-5 sm:max-h-[calc(100dvh-48px)] sm:p-6"
      >
        <button
          type="button"
          aria-label={t("关闭")}
          title={t("关闭")}
          className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md text-black/45 transition-colors hover:bg-black/[0.05] hover:text-black/75"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </button>

        <div className="pr-8">
          <h2 id="curated-skill-dialog-title" className="text-lg font-semibold text-black/90">{entry.skill.name}</h2>
          <p className="mt-1 break-all font-mono text-xs leading-5 text-black/45">{entry.skill.rawId}</p>
          {sourceUrl ? (
            <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-black/45">
              <a
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="truncate text-[#2563EB] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {t("来源")}
              </a>
            </div>
          ) : null}
        </div>

        <div className="mt-5 space-y-6 border-t border-black/[0.07] pt-5">
          <section>
            <h3 className="text-base font-semibold text-black/90">{t("这是什么？")}</h3>
            <h4 className="mt-3 text-sm font-semibold text-black/75">{t("概览")}</h4>
            <p className="mt-2 text-sm leading-6 text-black/65">{overview.overview[0]}</p>
            <p className="mt-3 text-sm leading-6 text-black/65">{overview.overview[1]}</p>
          </section>

          <SkillOverviewBullets heading={t("谁适合使用")} bullets={overview.whoShouldUse} />

          <section>
            <h3 className="text-base font-semibold text-black/90">{t("为什么使用它？")}</h3>
            <SkillOverviewBullets heading={t("它解决什么问题")} bullets={overview.problemsItSolves} nested />
            <SkillOverviewBullets heading={t("核心能力")} bullets={overview.keyCapabilities} nested />
          </section>

          <section>
            <h3 className="text-base font-semibold text-black/90">{t("如何使用它？")}</h3>
            <h4 className="mt-3 text-sm font-semibold text-black/75">{t("基本用法")}</h4>
            <p className="mt-2 whitespace-pre-line text-sm leading-6 text-black/65">{overview.basicUsage}</p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-black/[0.04] px-3 py-3 font-mono text-xs leading-5 text-black/75">
              <code>{overview.examplePrompt}</code>
            </pre>
          </section>
        </div>

        <div className="mt-5 flex justify-end">
          {installed ? (
            <span className="inline-flex h-10 items-center justify-center gap-2 rounded-md text-sm font-semibold text-[#5C9A8B]">
              <Check className="size-4" aria-hidden="true" />
              {t("已安装")}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onInstall(entry.skill)}
              disabled={installing}
              className="inline-flex h-10 min-w-[112px] items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition-colors hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {installing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
              {t("安装")}
            </button>
          )}
        </div>
      </section>
      </div>
    </div>
  );
}

function SkillOverviewBullets({
  heading,
  bullets,
  nested = false,
}: {
  heading: string;
  bullets: readonly CuratedSkillBullet[];
  nested?: boolean;
}) {
  return (
    <section className={nested ? "mt-5" : undefined}>
      <h3 className={nested ? "text-sm font-semibold text-black/75" : "text-base font-semibold text-black/90"}>{heading}</h3>
      <ul className="mt-3 space-y-2.5">
        {bullets.map((bullet) => (
          <li key={bullet.title} className="text-sm leading-6 text-black/65">
            <strong className="font-semibold text-black/80">{bullet.title}:</strong>{" "}
            {bullet.description}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FeaturedSkillCard({
  entry,
  title,
  subtitle,
  description,
  installed,
  installing,
  onInstall,
  onOpenDetails,
  disabled,
}: {
  entry: FeaturedSkillEntry;
  title: string;
  subtitle: string;
  description: string;
  installed: boolean;
  installing: boolean;
  onInstall: (skill: Skill) => void;
  onOpenDetails: (skill: Skill) => void;
  disabled: boolean;
}) {
  const t = useT();

  return (
    <li className="group relative grid h-[202px] grid-rows-[2fr_1fr] overflow-hidden rounded-lg border border-black/[0.06] bg-white transition-colors hover:border-black/[0.12] hover:bg-black/[0.025]">
      <button
        type="button"
        onClick={() => onOpenDetails(entry.skill)}
        aria-label={t("查看{{name}}详情", { name: entry.skill.name })}
        className="absolute inset-0 z-0 appearance-none rounded-lg border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
      />
      <div className={cn("pointer-events-none relative z-10 flex min-h-0 items-center overflow-hidden px-3.5 py-3", entry.heroClassName)}>
        <img
          src={entry.heroImageSrc}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
        />
        <div
          className={cn("absolute inset-0", entry.id !== "lh6-anniversary-blessing" && "bg-[linear-gradient(90deg,rgba(0,0,0,0.34)_0%,rgba(0,0,0,0.16)_55%,rgba(0,0,0,0.04)_100%)]")}
          aria-hidden="true"
        />
        <div className="relative z-10 max-w-[64%]">
          <h3 className="text-balance text-base font-bold leading-5 text-white">
            {title}
          </h3>
          <p className="mt-1 text-pretty text-[11px] leading-4 text-white/80">
            {subtitle}
          </p>
        </div>
      </div>
      <div className="pointer-events-none relative z-10 flex min-h-0 items-center gap-3 px-3.5 py-2 transition-colors group-hover:bg-black/[0.025]">
        <SkillIcon skill={entry.skill} className="size-9 shrink-0 object-contain" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-black/90">
            {entry.skill.name}
          </div>
          <p className="mt-1 line-clamp-1 text-pretty text-xs leading-4 text-black/50">
            {description}
          </p>
        </div>
        {installed ? (
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center text-[#82BDAE]"
            aria-label={t("已安装")}
            title={t("已安装")}
          >
            <Check className="size-5" aria-hidden="true" />
          </span>
        ) : (
          <div className="pointer-events-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onInstall(entry.skill)}
              disabled={disabled || installing}
              aria-label={t("安装")}
              title={t("安装")}
              className="inline-flex size-8 items-center justify-center border-0 bg-transparent text-[#4B5563] shadow-none transition-colors hover:text-[#374151] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/25 disabled:opacity-55"
            >
              {installing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-5" strokeWidth={2.25} aria-hidden="true" />
              )}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function InstalledSkillRow({
  skill,
  disabled,
  uninstalling,
  onUninstall,
}: {
  skill: InstalledSkill;
  disabled: boolean;
  uninstalling: boolean;
  onUninstall: (skill: InstalledSkill) => void;
}) {
  const t = useT();
  const sources = getInstalledSources(skill);
  const statusLabel = getInstalledStatusLabel(t, skill.status);
  const displayId = getInstalledDisplayId(skill);
  const canUninstall = skill.uninstallable !== false && !skill.sourceUncertain;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-3 gap-y-2 bg-white px-3.5 py-3 transition-colors hover:bg-black/[0.025] md:grid-cols-[minmax(0,1.3fr)_minmax(110px,0.65fr)_minmax(120px,0.7fr)_minmax(64px,0.35fr)_2.25rem]">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-black/90">{skill.name}</span>
          {statusLabel ? (
            <span className="shrink-0 rounded-[5px] bg-[#FFF3F2] px-1.5 py-0.5 text-[10px] font-semibold text-[#B42318]">
              {statusLabel}
            </span>
          ) : null}
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-black/45">{displayId}</div>
      </div>
      <div className="col-start-1 row-start-2 min-w-0 truncate text-xs text-black/55 md:col-start-2 md:row-start-1">
        <span className="mr-1 text-[11px] text-black/40 md:hidden">{t("分类")}</span>
        {getInstalledCategoryLabel(t, skill.category)}
      </div>
      <div className="col-start-1 row-start-3 flex min-w-0 flex-wrap items-center gap-1.5 md:col-start-3 md:row-start-1">
        <span className="mr-0.5 text-[11px] text-black/40 md:hidden">{t("技能来源")}</span>
        {sources.map((source) => (
          <InstalledSourceBadge key={source.key} source={source} />
        ))}
      </div>
      <div className="col-start-1 row-start-4 text-xs tabular-nums text-black/50 md:col-start-4 md:row-start-1">
        <span className="mr-1 text-[11px] text-black/40 md:hidden">{t("版本")}</span>
        {skill.version ? `v${skill.version}` : "—"}
      </div>
      <div className="col-start-2 row-span-4 row-start-1 shrink-0 self-center md:col-start-5 md:row-span-1 md:row-start-1">
        {canUninstall ? (
          <button
            type="button"
            onClick={() => onUninstall(skill)}
            disabled={disabled}
            aria-label={t("删除技能 {{name}}", { name: skill.name })}
            title={t("删除")}
            className="inline-flex size-9 items-center justify-center rounded-md text-black/40 transition-colors hover:bg-black/[0.04] hover:text-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-55"
          >
            {uninstalling ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : (
          <span
            className="inline-flex size-9 items-center justify-center text-xs text-black/30"
            title={skill.sourceUncertain ? t("来源确认后才能删除") : t("系统预置技能不可删除")}
          >
            —
          </span>
        )}
      </div>
    </li>
  );
}

function SectionTitle({
  children,
  count,
  className,
}: {
  children: React.ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("mb-2 flex items-center gap-1.5 text-sm font-semibold text-black/85", className)}>
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
                            {t("Hermes Agent 将这样处理")}
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
  profileId,
  execDebugCommand,
  execDebugCommandStream,
  mode = "global",
  expertsPanel,
  initialTab = "discover",
  onTabChange,
  dataLayer,
}: {
  botId: string;
  profileId?: string;
  execDebugCommand: ExpertsExecDebugCommand;
  execDebugCommandStream?: SkillsExecDebugCommandStream;
  mode?: SkillsDemoMode;
  learnSkillTrigger?: ReactNode;
  learnSkillPanel?: ReactNode;
  learnSkillTriggerFactory?: (options: LearnSkillTriggerOptions) => ReactNode;
  expertsPanel?: ReactNode;
  initialTab?: SkillsDemoTab;
  onTabChange?: (value: SkillsDemoTab) => void;
  dataLayer: SkillsDataLayer;
}) {
  const t = useT();
  const { i18n } = useTranslation();
  const shouldReduceMotion = useReducedMotion();
  const isChinese = i18n.resolvedLanguage?.startsWith("zh") ?? false;
  // Skill 概览数据集按语言分流：中文（含繁体，繁体再由 OpenCC 就地转字形）、
  // 印尼语、西班牙语、日语、韩语，其余回退英文。未收录条目回退英文。
  const overviewLocale: CuratedSkillOverviewLocale = isChinese
    ? "zh-CN"
    : i18n.resolvedLanguage === "id-ID"
      ? "id-ID"
      : i18n.resolvedLanguage?.startsWith("es")
        ? "es"
        : i18n.resolvedLanguage?.startsWith("ja")
          ? "ja-JP"
          : i18n.resolvedLanguage?.startsWith("ko")
            ? "ko-KR"
            : "en-US";
  const isDomestic = mode === "domestic";
  const featuredSkillCopy: Record<string, { title: string; subtitle: string; description: string }> = {
    "lh6-anniversary-blessing": {
      title: t("精选技能：轻量云六周年送祝福"),
      subtitle: t("送祝福，赢实例"),
      description: t("为轻量云六周年生成祝福文案与海报，支持多场景风格定制"),
    },
    "self-improving-agent": {
      title: t("精选技能：Self-Improving Agent"),
      subtitle: t("从每次执行中学习"),
      description: t("让 Agent 复盘结果，并持续改进自己的工作方式"),
    },
    "find-skills": {
      title: t("精选技能：Find Skills"),
      subtitle: t("快速找到合适技能"),
      description: t("帮助 Agent 为当前任务找到合适、可安装的技能"),
    },
    weather: {
      title: t("精选技能：Weather"),
      subtitle: t("立即查看天气"),
      description: t("为 Agent 提供当前天气和预报信息"),
    },
    caveman: {
      title: t("精选技能：Caveman"),
      subtitle: t("用更少文字表达"),
      description: t("用紧凑的沟通方式保留技术重点"),
    },
    "to-issues": {
      title: t("精选技能：To Issues"),
      subtitle: t("把计划拆成可执行 issue"),
      description: t("把计划、规格或 PRD 拆成可独立领取的 issue"),
    },
    simple: {
      title: t("精选技能：Simple"),
      subtitle: t("先澄清，再开始实现"),
      description: t("通过问题和方案对比帮助你收敛实现方向"),
    },
  };
  const [keyword, setKeyword] = useState("");
  const [activeTab, setActiveTab] = useState<SkillsDemoTab>(initialTab === "create" ? "discover" : initialTab);
  const [debounced, setDebounced] = useState("");
  const [registryFilter, setRegistryFilter] = useState<RegistryFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("popular");
  const [searchResultsExpanded, setSearchResultsExpanded] = useState(false);

  const [clawhubResults, setClawhubResults] = useState<Skill[]>([]);
  const [skillsshResults, setSkillsshResults] = useState<Skill[]>([]);
  const [skillhubResults, setSkillhubResults] = useState<Skill[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailedSources, setSearchFailedSources] = useState<SearchRegistry[]>([]);
  const [searchRetryNonce, setSearchRetryNonce] = useState(0);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [installedLoading, setInstalledLoading] = useState(true);
  const [installedError, setInstalledError] = useState<string | null>(null);
  const [installedFailedSources, setInstalledFailedSources] = useState<SearchRegistry[]>([]);
  const [installedSearchQuery, setInstalledSearchQuery] = useState("");
  const [installedCategoryFilter, setInstalledCategoryFilter] = useState<InstalledCategoryFilter>("all");
  const [installedSourceFilter, setInstalledSourceFilter] = useState<InstalledSourceFilter>("all");
  const [installedPage, setInstalledPage] = useState(1);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [batchInstalling, setBatchInstalling] = useState(false);
  const [batchCancelRequested, setBatchCancelRequested] = useState(false);
  const [batchInstallProgress, setBatchInstallProgress] = useState<BatchInstallProgress | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [searchInstallRowStatuses, setSearchInstallRowStatuses] = useState<Map<string, SearchInstallRowStatus>>(() => new Map());
  const [uninstallingKey, setUninstallingKey] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledSkill | null>(null);
  const [knownInstalledIds, setKnownInstalledIds] = useState<Set<string>>(() => readKnownInstalledIds(botId));
  const [featuredBatch, setFeaturedBatch] = useState(0);
  const [selectedSkillDetails, setSelectedSkillDetails] = useState<SkillDetailsEntry | null>(null);
  const batchCancelRequestedRef = useRef(false);
  const installedRequestIdRef = useRef(0);
  const activeBotIdRef = useRef(botId);
  activeBotIdRef.current = botId;

  useEffect(() => {
    if (!selectedSkillDetails) return;

    document.documentElement.classList.add("lv-curated-skill-dialog-open");
    return () => {
      document.documentElement.classList.remove("lv-curated-skill-dialog-open");
    };
  }, [selectedSkillDetails]);

  useEffect(() => {
    setActiveTab(initialTab === "create" ? "discover" : initialTab);
  }, [initialTab]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshInstalled = useCallback(async (): Promise<boolean> => {
    const requestId = installedRequestIdRef.current + 1;
    installedRequestIdRef.current = requestId;
    const requestBotId = botId;
    setInstalledLoading(true);
    setInstalledError(null);
    try {
      const result = await dataLayer.listInstalled();
      if (installedRequestIdRef.current !== requestId || activeBotIdRef.current !== requestBotId) return false;
      setInstalled(result.skills);
      setInstalledFailedSources(result.failedSources);
      setKnownInstalledIds((current) => {
        const next = new Set(
          [...current].filter((id) => rememberedIdExistsInInstalledList(id, result.skills)),
        );
        writeKnownInstalledIds(botId, next);
        return next;
      });
      return true;
    } catch (error) {
      if (installedRequestIdRef.current !== requestId || activeBotIdRef.current !== requestBotId) return false;
      setInstalledError(error instanceof Error ? error.message : "已安装技能加载失败");
      setInstalledFailedSources([]);
      return false;
    } finally {
      if (installedRequestIdRef.current === requestId && activeBotIdRef.current === requestBotId) {
        setInstalledLoading(false);
      }
    }
  }, [botId, dataLayer]);

  useEffect(() => {
    installedRequestIdRef.current += 1;
    setInstalled([]);
    setInstalledError(null);
    setInstalledFailedSources([]);
    setInstalledSearchQuery("");
    setInstalledCategoryFilter("all");
    setInstalledSourceFilter("all");
    setInstalledPage(1);
    setKnownInstalledIds(readKnownInstalledIds(botId));
    void refreshInstalled();
  }, [botId, refreshInstalled]);

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
    const abortController = new AbortController();
    const kw = debounced.trim();
    if (!kw) {
      setClawhubResults([]);
      setSkillsshResults([]);
      setSkillhubResults([]);
      setSearchFailedSources([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchFailedSources([]);
    dataLayer
      .search(kw, {
        sortBy: isDomestic && sortMode === "popular" ? "downloads" : "score",
        signal: abortController.signal,
      })
      .then((res) => {
        if (abortController.signal.aborted) return;
        setClawhubResults(res.clawhub);
        setSkillsshResults(res.skillssh);
        setSkillhubResults(res.skillhub);
        setSearchFailedSources(res.failedSources);
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setClawhubResults([]);
        setSkillsshResults([]);
        setSkillhubResults([]);
        setSearchFailedSources(isDomestic ? ["skillhub"] : ["clawhub", "skills-sh"]);
      })
      .finally(() => {
        if (!abortController.signal.aborted) setSearching(false);
      });
    return () => {
      abortController.abort();
    };
  }, [dataLayer, debounced, isDomestic, searchRetryNonce, sortMode]);

  const installedIdentitySet = useMemo(() => {
    const set = new Set<string>();
    installed.forEach((skill) => set.add(skillIdentity(skill)));
    return set;
  }, [installed]);

  const installedSourceOptions = useMemo(() => {
    const counts = new Map<string, { source: InstalledSourceDescriptor; count: number }>();
    installed.forEach((skill) => {
      getInstalledSources(skill).forEach((source) => {
        const current = counts.get(source.key);
        counts.set(source.key, { source, count: (current?.count ?? 0) + 1 });
      });
    });
    return Array.from(counts.values())
      .sort((a, b) => {
        const priorityDifference = (INSTALLED_SOURCE_ORDER[a.source.key] ?? Number.MAX_SAFE_INTEGER)
          - (INSTALLED_SOURCE_ORDER[b.source.key] ?? Number.MAX_SAFE_INTEGER);
        return priorityDifference || a.source.label.localeCompare(b.source.label);
      });
  }, [installed]);

  const installedCategoryOptions = useMemo(() => {
    const counts = new Map<InstalledCategoryFilter, { label: string; count: number }>();
    installed.forEach((skill) => {
      const key = getInstalledCategoryKey(skill.category);
      const current = counts.get(key);
      counts.set(key, {
        label: current?.label || getInstalledCategoryLabel(t, skill.category),
        count: (current?.count ?? 0) + 1,
      });
    });
    return Array.from(counts.entries())
      .map(([value, item]) => ({ value, ...item }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [installed, t]);

  const filteredInstalledSkills = useMemo(() => {
    const keyword = installedSearchQuery.trim().toLocaleLowerCase();
    return installed.filter((skill) => {
      const sources = getInstalledSources(skill);
      if (installedSourceFilter !== "all" && !sources.some((source) => source.key === installedSourceFilter)) return false;
      if (installedCategoryFilter !== "all" && getInstalledCategoryKey(skill.category) !== installedCategoryFilter) {
        return false;
      }
      if (!keyword) return true;
      return [
        skill.name,
        skill.rawId,
        skill.slug,
        skill.category ?? "",
        getInstalledCategoryLabel(t, skill.category),
        skill.version ?? "",
        ...(skill.nativeAliases ?? []),
        ...sources.flatMap((source) => [source.label, translateInstalledSourceLabel(t, source.label)]),
      ].some((value) => value.toLocaleLowerCase().includes(keyword));
    });
  }, [installed, installedCategoryFilter, installedSearchQuery, installedSourceFilter, t]);

  const installedFiltersActive = installedSearchQuery.trim().length > 0
    || installedCategoryFilter !== "all"
    || installedSourceFilter !== "all";
  const installedTotalPages = Math.max(1, Math.ceil(filteredInstalledSkills.length / INSTALLED_PAGE_SIZE));
  const pagedInstalledSkills = filteredInstalledSkills.slice(
    (installedPage - 1) * INSTALLED_PAGE_SIZE,
    installedPage * INSTALLED_PAGE_SIZE,
  );

  useEffect(() => {
    setInstalledPage(1);
  }, [installedCategoryFilter, installedSearchQuery, installedSourceFilter]);

  useEffect(() => {
    setInstalledPage((current) => Math.min(current, installedTotalPages));
  }, [installedTotalPages]);

  const curatedIdentityByShortSlug = useMemo(() => {
    const configuredSkills = [
      ...(isDomestic ? DOMESTIC_FEATURED_SKILLS : FEATURED_SKILLS).map((entry) => entry.skill),
      ...(isDomestic ? DOMESTIC_SKILL_CATEGORIES : CURATED_SKILL_CATEGORIES).flatMap((category) => (
        category.skills.map((entry) => "skill" in entry ? entry.skill : entry)
      )),
    ];
    const identities = new Map<string, string | null>();
    configuredSkills.forEach((skill) => {
      const shortSlugKey = `${skill.registry}:${skill.slug.trim().toLowerCase()}`;
      const identity = skillIdentity(skill);
      identities.set(shortSlugKey, identities.has(shortSlugKey) ? null : identity);
    });
    return identities;
  }, [isDomestic]);

  const isInstalled = useCallback(
    (skill: Skill) => {
      const identity = skillIdentity(skill);
      if (installedIdentitySet.has(identity) || knownInstalledIds.has(identity)) return true;

      const curatedIdentity = curatedIdentityByShortSlug.get(`${skill.registry}:${skill.slug.trim().toLowerCase()}`);
      if (curatedIdentity !== identity) return false;
      return installed.some((candidate) => (
        candidate.registry === skill.registry
        && candidate.rawId.trim().toLowerCase() === skill.slug.trim().toLowerCase()
      ));
    },
    [curatedIdentityByShortSlug, installed, installedIdentitySet, knownInstalledIds],
  );

  // 当前结果集（按 registry 过滤）
  const visibleResults = useMemo(() => {
    const pool =
      registryFilter === "all"
        ? mergeSkills(clawhubResults, skillsshResults, skillhubResults)
        : registryFilter === "clawhub"
          ? clawhubResults
          : registryFilter === "skills-sh"
            ? skillsshResults
            : skillhubResults;
    return sortMode === "popular" ? sortByPopular(pool) : sortByName(pool);
  }, [clawhubResults, skillhubResults, skillsshResults, registryFilter, sortMode]);

  useEffect(() => {
    setSearchResultsExpanded(false);
  }, [debounced, registryFilter, sortMode]);

  const hasSearch = debounced.trim().length > 0;
  const operationBusy = Boolean(installingId) || batchInstalling;
  const searchQueryPending = keyword.trim() !== debounced.trim();
  const shouldShowAllSearchResults = searchResultsExpanded && visibleResults.length > SEARCH_RESULTS_PREVIEW_LIMIT;
  const displayedSearchResults = shouldShowAllSearchResults
    ? visibleResults
    : visibleResults.slice(0, SEARCH_RESULTS_PREVIEW_LIMIT);

  const featuredEntries: readonly FeaturedSkillEntry[] = useMemo(() => (
    isDomestic ? DOMESTIC_FEATURED_SKILLS : FEATURED_SKILLS
  ), [isDomestic]);
  const skillCategories = useMemo(() => (
    isDomestic ? DOMESTIC_SKILL_CATEGORIES : CURATED_SKILL_CATEGORIES
  ), [isDomestic]);

  const selectableSkillsByIdentity = useMemo(() => {
    const byIdentity = new Map<string, Skill>();
    visibleResults.forEach((skill) => {
      if (!isInstalled(skill)) byIdentity.set(skillIdentity(skill), skill);
    });
    return byIdentity;
  }, [isInstalled, visibleResults]);

  const selectedSkills = useMemo(() => (
    Array.from(selectedSkillIds)
      .map((id) => selectableSkillsByIdentity.get(id))
      .filter((skill): skill is Skill => skill !== undefined && !isInstalled(skill))
  ), [isInstalled, selectableSkillsByIdentity, selectedSkillIds]);

  useEffect(() => {
    setSelectedSkillIds(new Set());
    setSearchInstallRowStatuses(new Map());
  }, [debounced, registryFilter, sortMode]);

  const featuredBatchCount = Math.max(1, Math.ceil(featuredEntries.length / FEATURED_BATCH_SIZE));
  const featuredBatchIndex = Math.min(featuredBatch, featuredBatchCount - 1);
  const featuredBatches = Array.from(
    { length: featuredBatchCount },
    (_, index) => featuredEntries.slice(
      index * FEATURED_BATCH_SIZE,
      (index + 1) * FEATURED_BATCH_SIZE,
    ),
  );
  // 未收录到 featuredSkillCopy 的条目走这套兜底文案。
  // 走 t() 而非中英二元字面量，否则印尼语等语言会落到英文。
  const getFeaturedCopy = (entry: FeaturedSkillEntry) => featuredSkillCopy[entry.id] ?? {
    title: t("精选技能：{{name}}", { name: entry.skill.name }),
    subtitle: t("SkillHub 热门技能"),
    description: entry.skill.description || t("帮助智能体完成对应任务"),
  };

  const handleInstall = useCallback(
    async (skill: Skill) => {
      if (installingId || batchInstalling || searchQueryPending) return;
      const id = skillIdentity(skill);
      setSearchInstallRowStatuses((current) => {
        const next = new Map(current);
        const currentStatus = next.get(id)?.status;
        if (currentStatus === "failed" || currentStatus === "skipped") {
          next.set(id, { status: "retrying" });
        } else {
          next.delete(id);
        }
        return next;
      });
      setInstallingId(id);
      try {
        const result = await dataLayer.install(skill);
        if (result.ok) {
          setSearchInstallRowStatuses((current) => new Map(current).set(id, { status: "done" }));
          setKnownInstalledIds((current) => {
            const next = new Set(current).add(id);
            writeKnownInstalledIds(botId, next);
            return next;
          });
          setSelectedSkillIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
          toast.success(t("安装成功"));
          await refreshInstalled();
        } else {
          setSearchInstallRowStatuses((current) => new Map(current).set(id, getSearchInstallRowStatus(result.message)));
          toast.error(result.message || t("安装失败"));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t("安装失败");
        setSearchInstallRowStatuses((current) => new Map(current).set(id, getSearchInstallRowStatus(message)));
        toast.error(message);
      } finally {
        setInstallingId(null);
      }
    },
    [batchInstalling, botId, dataLayer, installingId, refreshInstalled, searchQueryPending, t],
  );

  const handleToggleSelected = useCallback((skill: Skill) => {
    if (installingId || batchInstalling || searchQueryPending) return;
    const id = skillIdentity(skill);
    setSelectedSkillIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [batchInstalling, installingId, searchQueryPending]);

  const handleBatchInstall = useCallback(async () => {
    if (batchInstalling || installingId || searchQueryPending || selectedSkills.length === 0) return;
    batchCancelRequestedRef.current = false;
    setBatchCancelRequested(false);
    setBatchInstalling(true);
    setBatchInstallProgress(null);
    setSearchInstallRowStatuses((current) => {
      const next = new Map(current);
      selectedSkills.forEach((skill) => next.set(skillIdentity(skill), { status: "pending" }));
      return next;
    });
    try {
      const result = await installSkillsInBatch(dataLayer, selectedSkills, ({ index, total, skill, status, message }) => {
        const id = skillIdentity(skill);
        if (status === "installing") {
          setBatchInstallProgress({ index, total, currentName: skill.name });
          setSearchInstallRowStatuses((current) => new Map(current).set(id, { status: "installing" }));
          return;
        }
        setSearchInstallRowStatuses((current) => new Map(current).set(id,
          status === "succeeded"
            ? { status: "done" }
            : status === "skipped"
              ? { status: "skipped" }
              : getSearchInstallRowStatus(message),
        ));
      }, { shouldCancel: () => batchCancelRequestedRef.current });
      const succeededIds = new Set(result.succeeded.map((skill) => skillIdentity(skill)));
      if (succeededIds.size > 0) {
        setKnownInstalledIds((current) => {
          const next = new Set(current);
          succeededIds.forEach((id) => next.add(id));
          writeKnownInstalledIds(botId, next);
          return next;
        });
        setSelectedSkillIds((current) => {
          const next = new Set(current);
          succeededIds.forEach((id) => next.delete(id));
          return next;
        });
      }
      await refreshInstalled();
      if (result.skipped.length > 0) {
        toast.error(t("已取消安装：成功 {{success}} 个，失败 {{failed}} 个，跳过 {{skipped}} 个", {
          success: result.succeeded.length,
          failed: result.failed.length,
          skipped: result.skipped.length,
        }));
      } else if (result.failed.length > 0) {
        toast.error(t("批量安装完成：成功 {{success}} 个，失败 {{failed}} 个", {
          success: result.succeeded.length,
          failed: result.failed.length,
        }));
      } else {
        toast.success(t("批量安装成功，共 {{count}} 个", { count: result.succeeded.length }));
      }
    } finally {
      setBatchInstallProgress(null);
      setBatchInstalling(false);
      setBatchCancelRequested(false);
      batchCancelRequestedRef.current = false;
    }
  }, [batchInstalling, botId, dataLayer, installingId, refreshInstalled, searchQueryPending, selectedSkills, t]);

  useEffect(() => {
    if (!batchInstalling) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [batchInstalling]);

  const handleUninstall = useCallback(
    async (skill: InstalledSkill) => {
      if (uninstallingKey) return;
      if (skill.uninstallable === false || skill.sourceUncertain) {
        toast.error(skill.sourceUncertain ? t("来源确认后才能删除") : t("系统预置技能不可删除"));
        return;
      }
      // 卸载按 registry + rawId 识别；旧版 list 若只返回 slug，只能按该返回值下发。
      const key = skillIdentity(skill);
      setUninstallingKey(key);
      try {
        const result = await dataLayer.uninstall(skill);
        if (result.ok) {
          setKnownInstalledIds((current) => {
            const next = new Set(current);
            for (const rememberedId of next) {
              if (rememberedIdMatchesSkill(rememberedId, skill)) next.delete(rememberedId);
            }
            writeKnownInstalledIds(botId, next);
            return next;
          });
          const refreshed = await refreshInstalled();
          if (refreshed) toast.success(t("卸载成功"));
          else toast.error(t("卸载已确认，但列表刷新失败，请重试"));
        } else {
          toast.error(result.message || t("删除失败"));
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("删除失败"));
      } finally {
        setUninstallingKey(null);
      }
    },
    [botId, dataLayer, refreshInstalled, t, uninstallingKey],
  );

  const uninstallBusy = Boolean(uninstallingKey);

  return (
    <div className={`${CLS} pb-12`}>
      {/* 数据通道提示（仅 demo 期） */}
      {!SKILLS_DEMO_LIVE ? (
        <div className="mb-3 rounded-md border border-[#FFE7BA] bg-[#FFF7E6] px-3 py-2 text-[11px] leading-5 text-[#8A5A00]">
          {t("演示模式：使用联调样例数据。切换 SKILLS_DEMO_LIVE=true 即走 acli 真实联调。")}
        </div>
      ) : null}

      <CuratedSkillDetailsDialog
        entry={selectedSkillDetails}
        installed={selectedSkillDetails ? isInstalled(selectedSkillDetails.skill) : false}
        installing={selectedSkillDetails ? installingId === skillIdentity(selectedSkillDetails.skill) : false}
        onInstall={handleInstall}
        onClose={() => setSelectedSkillDetails(null)}
      />

      <Dialog
        open={pendingUninstall !== null}
        onOpenChange={(open) => {
          if (!open && !uninstallBusy) setPendingUninstall(null);
        }}
      >
        <DialogContent className="!rounded-md md:w-[28rem]">
          <DialogHeader className="mb-5">
            <DialogTitle>{t("删除技能？")}</DialogTitle>
            <DialogDescription>
              {pendingUninstall
                ? t("这会从智能体中永久删除 {{name}}。", { name: pendingUninstall.name })
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <button
                type="button"
                disabled={uninstallBusy}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-black/65 hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-55"
              >
                {t("取消")}
              </button>
            </DialogClose>
            <button
              type="button"
              disabled={uninstallBusy || pendingUninstall === null}
              aria-label={pendingUninstall
                ? t("确认删除 {{name}}", { name: pendingUninstall.name })
                : t("确认删除")}
              onClick={() => {
                if (!pendingUninstall) return;
                void handleUninstall(pendingUninstall).finally(() => setPendingUninstall(null));
              }}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:opacity-55"
            >
              {uninstallBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {t("删除")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (operationBusy) return;
          if (value !== "discover" && value !== "experts" && value !== "installed") return;
          const nextTab = value as SkillsDemoTab;
          if (nextTab === "installed" && activeTab !== "installed") void refreshInstalled();
          setActiveTab(nextTab);
          onTabChange?.(nextTab);
        }}
        className="min-w-0"
      >
        <div className="mb-4 flex min-w-0 items-end gap-4 border-b border-black/[0.08]">
          <TabsList
            aria-label={t("技能市场页面切换")}
            className="!h-9 min-w-0 flex-1 !justify-start gap-4 !rounded-none !border-0 !bg-transparent !p-0 !shadow-none sm:gap-7"
          >
            <TabsTrigger
              value="discover"
              disabled={operationBusy}
              className="relative !h-9 !min-w-0 !rounded-none !bg-transparent !px-0 !py-0 pb-2 text-sm font-medium text-black/55 !shadow-none transition-colors after:absolute after:bottom-[-1px] after:left-0 after:h-0.5 after:w-full after:bg-transparent hover:text-black/80 data-[state=active]:!bg-transparent data-[state=active]:text-black/90 data-[state=active]:!shadow-none data-[state=active]:after:bg-black"
            >
              {t("技能")}
            </TabsTrigger>
            {expertsPanel ? (
              <TabsTrigger
                value="experts"
                disabled={operationBusy}
                className="relative !h-9 !min-w-0 !rounded-none !bg-transparent !px-0 !py-0 pb-2 text-sm font-medium text-black/55 !shadow-none transition-colors after:absolute after:bottom-[-1px] after:left-0 after:h-0.5 after:w-full after:bg-transparent hover:text-black/80 data-[state=active]:!bg-transparent data-[state=active]:text-black/90 data-[state=active]:!shadow-none data-[state=active]:after:bg-black"
              >
                {t("技能包")}
              </TabsTrigger>
            ) : null}
            <TabsTrigger
              value="installed"
              disabled={operationBusy}
              className="relative !h-9 !min-w-0 !rounded-none !bg-transparent !px-0 !py-0 pb-2 text-sm font-medium text-black/55 !shadow-none transition-colors after:absolute after:bottom-[-1px] after:left-0 after:h-0.5 after:w-full after:bg-transparent hover:text-black/80 data-[state=active]:!bg-transparent data-[state=active]:text-black/90 data-[state=active]:!shadow-none data-[state=active]:after:bg-black"
            >
              {t("已安装")}
              {!installedLoading ? (
                <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-black/[0.06] px-1.5 text-[11px] font-medium text-black/45 tabular-nums">
                  {installed.length}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="discover" className="mt-0">
          <div className="space-y-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className={cn(SKILLS_SEARCH_BOX_CLASS, "min-w-0 flex-1")}>
                <Search className={SKILLS_SEARCH_ICON_CLASS} aria-hidden="true" />
                <input
                  type="text"
                  aria-label={t("搜索技能")}
                  value={keyword}
                  disabled={operationBusy}
                  onChange={(e) => {
                    if (operationBusy) return;
                    setKeyword(e.target.value);
                  }}
                  placeholder={isDomestic ? "搜索 SkillHub 中的技能" : t("搜索 Skills.sh / Clawhub 中的技能")}
                  className={SKILLS_SEARCH_INPUT_CLASS}
                />
                {keyword ? (
                  <button
                    type="button"
                    disabled={operationBusy}
                    onClick={() => {
                      if (operationBusy) return;
                      setKeyword("");
                    }}
                    aria-label={t("清除搜索")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-black/35 hover:text-black/60"
                  >
                    {searching ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <X className="size-4" aria-hidden="true" />}
                  </button>
                ) : null}
              </div>
              {!isDomestic ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Select
                    value={registryFilter}
                    disabled={operationBusy}
                    onValueChange={(value) => {
                      if (operationBusy) return;
                      if (value !== "all" && value !== "skills-sh" && value !== "clawhub") return;
                      setRegistryFilter(value);
                    }}
                  >
                    <SelectTrigger
                      aria-label={t("来源")}
                      className="lv-skills-source-select-trigger !h-10 w-[132px] shrink-0 !justify-center gap-1 !rounded-[12px] !border-black/10 !bg-white !px-3 text-xs font-semibold text-black/75 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-shadow hover:!border-black/16 hover:shadow-[0_2px_7px_rgba(0,0,0,0.07)] data-[state=open]:!border-black/20 data-[state=open]:shadow-[0_3px_10px_rgba(0,0,0,0.09)]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      align="end"
                      sideOffset={4}
                      className="!min-w-[var(--radix-select-trigger-width)] !rounded-md !border-black/10 bg-white shadow-[0_10px_24px_-12px_rgba(0,0,0,0.32),0_3px_8px_rgba(0,0,0,0.06)]"
                    >
                      <SelectItem value="all" className="!rounded-sm py-2 text-xs font-medium data-[highlighted]:bg-black/[0.04] data-[highlighted]:shadow-[0_1px_3px_rgba(0,0,0,0.05)] data-[state=checked]:bg-black/[0.035]">
                        {t("所有来源")}
                      </SelectItem>
                      <SelectSeparator className="mx-1" />
                      <SelectItem value="skills-sh" className="!rounded-sm py-2 text-xs font-medium data-[highlighted]:bg-black/[0.04] data-[highlighted]:shadow-[0_1px_3px_rgba(0,0,0,0.05)] data-[state=checked]:bg-black/[0.035]">
                        skills.sh
                      </SelectItem>
                      <SelectItem value="clawhub" className="!rounded-sm py-2 text-xs font-medium data-[highlighted]:bg-black/[0.04] data-[highlighted]:shadow-[0_1px_3px_rgba(0,0,0,0.05)] data-[state=checked]:bg-black/[0.035]">
                        ClawHub
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>

            {hasSearch ? (
              <section>
                <div className="mb-2 flex min-h-9 flex-wrap items-center justify-between gap-3">
                  <SectionTitle count={visibleResults.length} className="mb-0 text-base">
                    {t("搜索结果")}
                  </SectionTitle>
                  <div className="flex min-h-9 min-w-0 flex-wrap items-center justify-end gap-3">
                    {!searching && visibleResults.length > 0 ? (
                      <div className="lv-skills-sort-control flex h-9 shrink-0 items-center gap-1 rounded-[12px] bg-black/[0.04] p-0.5">
                      <button
                        type="button"
                        disabled={operationBusy}
                        onClick={() => {
                          if (operationBusy) return;
                          setSortMode("popular");
                        }}
                        className={cn(
                          "h-8 rounded-[12px] px-2 text-[11px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-45",
                          sortMode === "popular"
                            ? "bg-white text-black/85 shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                            : "text-black/45 hover:text-black/70",
                        )}
                      >
                        {t("按热度")}
                      </button>
                      <button
                        type="button"
                        disabled={operationBusy}
                        onClick={() => {
                          if (operationBusy) return;
                          setSortMode("name");
                        }}
                        className={cn(
                          "h-8 rounded-[12px] px-2 text-[11px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-45",
                          sortMode === "name"
                            ? "bg-white text-black/85 shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                            : "text-black/45 hover:text-black/70",
                        )}
                      >
                        {t("按名称")}
                      </button>
                      </div>
                    ) : null}
                    {!searching && selectableSkillsByIdentity.size > 0 ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="whitespace-nowrap text-xs text-black/45">
                          {t("已选 {{n}} / {{m}}", {
                            n: selectedSkills.length,
                            m: selectableSkillsByIdentity.size,
                          })}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleBatchInstall()}
                          disabled={selectedSkills.length === 0 || operationBusy || searchQueryPending}
                          aria-busy={batchInstalling}
                          aria-label={t("安装已选技能")}
                          title={selectedSkills.length === 0 ? t("请先选择要安装的技能") : t("安装已选技能")}
                          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[12px] bg-black px-6 text-sm font-semibold text-white transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-black/[0.08] disabled:text-black/30"
                        >
                          {batchInstalling ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                          <span>{t("安装")}</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
                {batchInstallProgress ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mb-2 flex min-h-9 items-center gap-2 rounded-md border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs font-medium text-blue-700"
                  >
                    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      {t("正在安装 ({{index}}/{{total}})：{{name}}", {
                        index: batchInstallProgress.index,
                        total: batchInstallProgress.total,
                        name: batchInstallProgress.currentName,
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={batchCancelRequested}
                      onClick={() => {
                        batchCancelRequestedRef.current = true;
                        setBatchCancelRequested(true);
                      }}
                      className="shrink-0 rounded-sm px-2 py-1 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-wait disabled:opacity-55"
                    >
                      {batchCancelRequested ? t("取消中...") : t("取消剩余任务")}
                    </button>
                  </div>
                ) : null}
                {!searching && searchFailedSources.length > 0 ? (
                  <div
                    role="alert"
                    className="mb-2 flex min-h-10 items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                  >
                    <span>
                      {searchFailedSources.length === (isDomestic ? 1 : 2)
                        ? t("技能搜索失败，请重试")
                        : t("{{sources}} 搜索失败，当前结果可能不完整", {
                            sources: searchFailedSources.map((source) => REGISTRY_LABEL[source]).join("、"),
                          })}
                    </span>
                    <button
                      type="button"
                      disabled={operationBusy}
                      onClick={() => {
                        if (operationBusy) return;
                        setSearchRetryNonce((current) => current + 1);
                      }}
                      className="shrink-0 rounded-sm border border-amber-300 bg-white px-2.5 py-1 font-semibold text-amber-800 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      {t("重试")}
                    </button>
                  </div>
                ) : null}
                {searching ? (
                  <div className="flex items-center gap-2 rounded-md bg-white px-4 py-6 text-sm text-black/45">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    {t("搜索中...")}
                  </div>
                ) : visibleResults.length === 0 ? (
                  searchFailedSources.length === 0 ? (
                    <div className="rounded-md bg-white px-4 py-8 text-center text-sm text-black/40">
                      {t("没有找到匹配的技能")}
                    </div>
                  ) : null
                ) : (
                  <ul className="overflow-hidden rounded-md border border-black/[0.08] bg-white">
                    {displayedSearchResults.map((skill) => (
                      <SearchSkillRow
                        key={`search:${skill.registry}:${skill.rawId}`}
                        skill={skill}
                        installed={isInstalled(skill)}
                        installing={installingId === skillIdentity(skill)}
                        onInstall={handleInstall}
                        selected={selectedSkillIds.has(skillIdentity(skill))}
                        disabled={operationBusy || searchQueryPending}
                        rowStatus={searchInstallRowStatuses.get(skillIdentity(skill))}
                        showSourceLink={!isDomestic}
                        onToggleSelected={handleToggleSelected}
                      />
                    ))}
                  </ul>
                )}
                {!searching && visibleResults.length > 0 ? (
                  <div className="mt-3 grid min-h-8 grid-cols-[1fr_auto_1fr] items-center">
                    {visibleResults.length > SEARCH_RESULTS_PREVIEW_LIMIT ? (
                      <button
                        type="button"
                        onClick={() => setSearchResultsExpanded((expanded) => !expanded)}
                        aria-expanded={shouldShowAllSearchResults}
                        className="col-start-2 inline-flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-full border border-black/[0.08] bg-transparent px-3 text-xs font-semibold text-black/60 transition-colors hover:border-black/15 hover:text-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
                      >
                        <span>{shouldShowAllSearchResults ? t("收起") : t("查看更多")}</span>
                        {shouldShowAllSearchResults ? (
                          <ChevronUp className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
                        ) : (
                          <ChevronDown className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                    {isDomestic ? (
                      <a
                        href="https://skillhub.cn"
                        target="_blank"
                        rel="noreferrer"
                        className="col-start-3 inline-flex h-8 justify-self-end items-center gap-[3px] rounded-sm text-[13px] font-normal text-[#2563EB] underline-offset-2 transition-colors hover:text-[#1D4ED8] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      >
                        源自 SkillHub
                        <span aria-hidden="true">↗</span>
                      </a>
                    ) : (
                      <p className="col-start-3 inline-flex h-8 items-center justify-self-end gap-[3px] text-[13px] font-normal text-[#2563EB] underline-offset-2 transition-colors hover:text-[#1D4ED8]">
                        <span>{isChinese ? "源自" : t("技能来源于")}</span>
                        {" "}
                        <a
                          href="https://skills.sh"
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                        >
                          Skills.sh
                        </a>
                        {" "}
                        <span>{isChinese ? "和" : t("与")}</span>
                        {" "}
                        <a
                          href="https://clawhub.ai/"
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                        >
                          ClawHub
                        </a>
                        <span aria-hidden="true">↗</span>
                      </p>
                    )}
                  </div>
                ) : null}
              </section>
            ) : null}

            <section>
              <SectionTitle className="mb-2 text-base">{t("精选")}</SectionTitle>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFeaturedBatch((current) => Math.max(current - 1, 0))}
                  disabled={featuredBatchIndex === 0}
                  aria-label={t("上一批")}
                  title={t("上一批")}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-black/60 transition-colors hover:bg-black/[0.03] hover:text-black disabled:cursor-default disabled:border-black/[0.06] disabled:bg-transparent disabled:text-black/20"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <motion.div
                    animate={{ x: `${-(featuredBatchIndex * 100) / featuredBatchCount}%` }}
                    transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: "easeOut" }}
                    className="flex"
                    style={{ width: `${featuredBatchCount * 100}%` }}
                  >
                    {featuredBatches.map((batch, index) => (
                      <ul
                        key={`featured:${index}`}
                        aria-hidden={index !== featuredBatchIndex}
                        inert={index !== featuredBatchIndex}
                        className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-3"
                        style={{ width: `${100 / featuredBatchCount}%` }}
                      >
                        {batch.map((entry) => {
                          const copy = getFeaturedCopy(entry);
                          return (
                            <FeaturedSkillCard
                              key={entry.id}
                              entry={entry}
                              title={copy.title}
                              subtitle={copy.subtitle}
                              description={copy.description}
                              installed={isInstalled(entry.skill)}
                              installing={
                                installingId === skillIdentity(entry.skill)
                                || (batchInstalling && selectedSkillIds.has(skillIdentity(entry.skill)))
                              }
                              onInstall={handleInstall}
                              disabled={batchInstalling || Boolean(installingId)}
                              onOpenDetails={(skill) => setSelectedSkillDetails({
                                skill,
                                overview: getSkillOverview(skill, overviewLocale, t),
                              })}
                            />
                          );
                        })}
                      </ul>
                    ))}
                  </motion.div>
                </div>
                <button
                  type="button"
                  onClick={() => setFeaturedBatch((current) => Math.min(current + 1, featuredBatchCount - 1))}
                  disabled={featuredBatchIndex >= featuredBatchCount - 1}
                  aria-label={t("下一批")}
                  title={t("下一批")}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-black/60 transition-colors hover:bg-black/[0.03] hover:text-black disabled:cursor-default disabled:border-black/[0.06] disabled:bg-transparent disabled:text-black/20"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
            </section>

            <div className="space-y-6">
              {skillCategories.map((category) => (
                <section key={category.id}>
                  <SectionTitle className="mb-2 text-base">
                    {getCategoryLabel(category.label, overviewLocale)}
                  </SectionTitle>
                  <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {category.skills.map((entry) => {
                      const skill = "skill" in entry ? entry.skill : entry;
                      const description = getSkillOverview(skill, overviewLocale, t).overview[0];
                      return (
                      <SkillCard
                        key={`discover:${skillIdentity(skill)}`}
                        skill={skill}
                        installed={isInstalled(skill)}
                        installing={
                          installingId === skillIdentity(skill)
                          || (batchInstalling && selectedSkillIds.has(skillIdentity(skill)))
                        }
                        onInstall={handleInstall}
                        disabled={batchInstalling || Boolean(installingId)}
                        onOpenDetails={() => setSelectedSkillDetails({
                          skill,
                          overview: getSkillOverview(skill, overviewLocale, t),
                        })}
                        description={description}
                      />
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </TabsContent>

        {expertsPanel ? (
          <TabsContent value="experts" className="mt-0">
            {expertsPanel}
          </TabsContent>
        ) : null}

        <TabsContent value="installed" className="mt-0">
          <div className="mb-3 flex min-h-10 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SectionTitle className="mb-0">
              {t("已安装")}
              {!installedLoading ? (
                <span className="text-xs font-normal tabular-nums text-black/40">
                  ({installedFiltersActive ? `${filteredInstalledSkills.length}/${installed.length}` : installed.length})
                </span>
              ) : null}
            </SectionTitle>
            {!installedLoading && installed.length > 0 ? (
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 sm:w-60">
                  <div className={SKILLS_SEARCH_BOX_CLASS}>
                    <Search className={SKILLS_SEARCH_ICON_CLASS} aria-hidden="true" />
                    <input
                      type="search"
                      value={installedSearchQuery}
                      onChange={(event) => setInstalledSearchQuery(event.target.value)}
                      aria-label={t("搜索已安装技能")}
                      placeholder={t("搜索已安装技能")}
                      className={cn(SKILLS_SEARCH_INPUT_CLASS, SEARCH_INPUT_NATIVE_CLEAR_CLASS)}
                    />
                    {installedSearchQuery ? (
                      <button
                        type="button"
                        onClick={() => setInstalledSearchQuery("")}
                        aria-label={t("清除已安装技能搜索")}
                        className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-black/35 transition-colors hover:bg-black/[0.04] hover:text-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </div>
                <Select
                  value={installedCategoryFilter}
                  onValueChange={(value) => setInstalledCategoryFilter(value as InstalledCategoryFilter)}
                >
                  <SelectTrigger
                    aria-label={t("筛选技能分类")}
                    className="h-9 w-full rounded-[12px] border-black/10 bg-white px-3 text-xs font-medium text-black/70 shadow-none sm:w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" className="rounded-md border-black/10 bg-white p-1 shadow-xl">
                    <SelectItem value="all" className="rounded-sm py-2 text-xs">
                      {t("全部分类")} ({installed.length})
                    </SelectItem>
                    {installedCategoryOptions.map(({ value, label, count }) => (
                      <SelectItem key={value} value={value} className="rounded-sm py-2 text-xs">
                        {label} ({count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={installedSourceFilter}
                  onValueChange={(value) => setInstalledSourceFilter(value as InstalledSourceFilter)}
                >
                  <SelectTrigger
                    aria-label={t("筛选技能来源")}
                    className="h-9 w-full rounded-[12px] border-black/10 bg-white px-3 text-xs font-medium text-black/70 shadow-none sm:w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" className="rounded-md border-black/10 bg-white p-1 shadow-xl">
                    <SelectItem value="all" className="rounded-sm py-2 text-xs">
                      {t("全部来源")} ({installed.length})
                    </SelectItem>
                    {installedSourceOptions.map(({ source, count }) => (
                      <SelectItem key={source.key} value={source.key} className="rounded-sm py-2 text-xs">
                        {translateInstalledSourceLabel(t, source.label)} ({count})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          {(installedError && installed.length > 0) || installedFailedSources.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#F2D38A] bg-[#FFF8E6] px-3 py-2 text-xs text-[#7A5200]">
              <span>
                {installedError
                  ? t("已安装技能加载失败，当前列表可能不是最新状态")
                  : t("部分技能来源暂不可用，相关技能暂时不能删除")}
              </span>
              <button
                type="button"
                onClick={() => void refreshInstalled()}
                disabled={installedLoading}
                className="inline-flex h-7 items-center justify-center rounded-md border border-[#D8B45B] bg-white px-2.5 text-xs font-semibold text-[#7A5200] hover:border-[#B88B2A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-55"
              >
                {t("重试")}
              </button>
            </div>
          ) : null}
          {installedLoading && installed.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md bg-white px-4 py-6 text-sm text-black/45">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("加载中...")}
            </div>
          ) : installedError && installed.length === 0 ? (
            <div className="rounded-md border border-black/[0.08] bg-white px-4 py-8 text-center">
              <p className="text-sm text-black/45">{t("无法获取已安装技能")}</p>
              <button
                type="button"
                onClick={() => void refreshInstalled()}
                className="mt-3 inline-flex h-8 items-center justify-center rounded-md border border-black/10 px-3 text-xs font-medium text-black/60 hover:border-black/20 hover:text-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {t("重试")}
              </button>
            </div>
          ) : installed.length === 0 ? (
            <div className="rounded-md bg-white px-4 py-8 text-center text-sm text-black/40">
              {t("还没有已安装的技能")}
            </div>
          ) : filteredInstalledSkills.length === 0 ? (
            <div className="rounded-md border border-black/[0.08] bg-white px-4 py-8 text-center">
              <p className="text-sm text-black/45">{t("没有匹配的已安装技能")}</p>
              <button
                type="button"
                onClick={() => {
                  setInstalledSearchQuery("");
                  setInstalledCategoryFilter("all");
                  setInstalledSourceFilter("all");
                }}
                className="mt-3 inline-flex h-8 items-center justify-center rounded-md border border-black/10 px-3 text-xs font-medium text-black/60 transition-colors hover:border-black/20 hover:text-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {t("清除筛选")}
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-black/[0.08] bg-white">
              <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(110px,0.65fr)_minmax(120px,0.7fr)_minmax(64px,0.35fr)_2.25rem] items-center gap-x-3 border-b border-black/[0.08] bg-black/[0.025] px-3.5 py-2.5 text-xs font-semibold text-black/45 md:grid">
                <span>{t("名称/Slug")}</span>
                <span>{t("分类")}</span>
                <span>{t("来源")}</span>
                <span>{t("版本")}</span>
                <span className="sr-only">{t("操作")}</span>
              </div>
              <ul aria-label={t("已安装技能列表")} className="divide-y divide-black/[0.06]">
                {pagedInstalledSkills.map((skill) => (
                  <InstalledSkillRow
                    key={skillIdentity(skill)}
                    skill={skill}
                    disabled={uninstallBusy}
                    uninstalling={uninstallingKey === skillIdentity(skill)}
                    onUninstall={setPendingUninstall}
                  />
                ))}
              </ul>
            </div>
          )}
          {!installedLoading && filteredInstalledSkills.length > INSTALLED_PAGE_SIZE ? (
            <div className="mt-3 flex items-center justify-center gap-3 text-xs text-black/50">
              <button
                type="button"
                onClick={() => setInstalledPage((page) => Math.max(1, page - 1))}
                disabled={installedPage <= 1}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 font-medium hover:border-black/20 hover:text-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
              >
                {t("上一页")}
              </button>
              <span className="tabular-nums">{t("{{page}} / {{total}} 页", { page: installedPage, total: installedTotalPages })}</span>
              <button
                type="button"
                onClick={() => setInstalledPage((page) => Math.min(installedTotalPages, page + 1))}
                disabled={installedPage >= installedTotalPages}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 font-medium hover:border-black/20 hover:text-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:opacity-40"
              >
                {t("下一页")}
              </button>
            </div>
          ) : null}
        </TabsContent>

      </Tabs>
    </div>
  );
}
