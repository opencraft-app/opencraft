// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  ArrowLeft,
  AlertTriangle,
  BookOpen,
  Clapperboard,
  Check,
  Cpu,
  GraduationCap,
  HeartPulse,
  Landmark,
  LayoutGrid,
  List,
  Loader2,
  Megaphone,
  MoonStar,
  PackageOpen,
  Palette,
  Puzzle,
  RefreshCw,
  Scale,
  Search,
  ShoppingCart,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementType } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { useT } from "../../i18n/t";
import { loadExpertPackagesState, saveExpertPackagesState } from "../../lib/expert-package-storage";
import { requireHermesSkillsProfile, withHermesAgent, withHermesSkillsProfile } from "../../lib/hermes-agent-command";
import { shellQuote } from "../../lib/hermes-cron-client";
import {
  buildInstalledSkillsListCommand,
  getUniqueSkillSlugs,
  parseInstalledSkillSlugs,
} from "../../lib/hermes-skills-client";
import { toast } from "../../lib/toast";
import { cn } from "../../lib/utils";
import { useAsyncResource } from "../../services/use-async-resource";
import {
  fetchSkillFile,
  fetchSkillDetail,
  fetchSkillFiles,
  fetchSkillSetDetail,
  fetchSkillSets,
  type SkillHubKnownSkillSetScene,
  type SkillHubSkillSet,
} from "../../lib/skillhub-api";

import {
  installSkillsWithNativeBatch,
  type BatchInstallResult,
  type Skill,
  type SkillsExecDebugCommandStream,
} from "./skills-demo/skill-registries";

type ExpertFilterId = "all" | SkillHubKnownSkillSetScene;
type ExpertView = "list" | "grid";

interface ExpertSceneOption {
  value: SkillHubKnownSkillSetScene;
  label: string;
  labelEn: string;
  labelEs: string;
  labelJa: string;
  icon: ElementType;
}

export interface ExecDebugCommandResult {
  status: string;
  exitCode: number;
  output: string;
  stdout?: string;
  stderr?: string;
}

export type ExpertsExecDebugCommand = (
  botId: string,
  command: string,
  options?: { timeoutMs?: number },
) => Promise<ExecDebugCommandResult>;

interface ExpertPackageCard {
  pkg: SkillHubSkillSet;
}

interface SkillInstallFailure {
  slug: string;
  output: string;
}

interface SkillInstallResult {
  succeeded: string[];
  failed: SkillInstallFailure[];
}

interface SkillInstallProgress {
  current: number;
  total: number;
}

const EXPERT_FILTER_SCENES: ExpertSceneOption[] = [
  // Keep the same visible category order as SkillHub's /skillspackage page.
  { value: "finance", label: "金融", labelEn: "Finance", labelEs: "Finanzas", labelJa: "金融", icon: Landmark },
  { value: "tech", label: "科技", labelEn: "Technology", labelEs: "Tecnología", labelJa: "テクノロジー", icon: Cpu },
  { value: "design", label: "设计", labelEn: "Design", labelEs: "Diseño", labelJa: "デザイン", icon: Palette },
  { value: "marketing", label: "营销", labelEn: "Marketing", labelEs: "Marketing", labelJa: "マーケティング", icon: Megaphone },
  { value: "legal", label: "法律", labelEn: "Legal", labelEs: "Legal", labelJa: "法務", icon: Scale },
  { value: "academic", label: "学术", labelEn: "Academic", labelEs: "Académico", labelJa: "学術", icon: GraduationCap },
  { value: "education", label: "教育", labelEn: "Education", labelEs: "Educación", labelJa: "教育", icon: BookOpen },
  { value: "hr", label: "人力", labelEn: "Human Resources", labelEs: "Recursos humanos", labelJa: "人事", icon: Users },
  { value: "ecommerce", label: "电商", labelEn: "Ecommerce", labelEs: "Comercio electrónico", labelJa: "EC", icon: ShoppingCart },
  { value: "media", label: "媒体", labelEn: "Media", labelEs: "Medios", labelJa: "メディア", icon: Clapperboard },
  { value: "healthcare", label: "医疗", labelEn: "Healthcare", labelEs: "Salud", labelJa: "ヘルスケア", icon: HeartPulse },
  { value: "mysticism", label: "玄学", labelEn: "Mysticism", labelEs: "Misticismo", labelJa: "占術", icon: MoonStar },
];

const EXPERT_PACKAGE_SCENE_ROLES: Record<SkillHubKnownSkillSetScene, string> = {
  academic: "学术研究员",
  "content-creation": "内容创作专家",
  design: "产品设计顾问",
  ecommerce: "电商运营专家",
  education: "学习规划师",
  finance: "投资分析专家",
  healthcare: "健康信息顾问",
  hr: "组织人才顾问",
  legal: "法律合规顾问",
  lifestyle: "生活健康顾问",
  marketing: "营销增长专家",
  media: "媒体内容专家",
  mysticism: "命理占卜顾问",
  tech: "高级开发工程师",
};

const EXPERT_PACKAGE_SUB_SCENE_ROLES: Record<string, string> = {
  "fitness-training": "健身训练教练",
  "health-data-analysis": "健康数据分析师",
  "lyrics-songwriting": "歌词创作专家",
  "meditation-mindfulness": "正念冥想教练",
  "mental-counseling": "心理咨询顾问",
  "novel-writing": "小说创作专家",
  "nutrition-meal-plan": "营养健康顾问",
  "poetry-creation": "诗词创作专家",
  screenwriting: "剧本创作专家",
  "story-outlining": "故事大纲策划",
};

const EXPERT_KNOWN_SCENE_SET = new Set(Object.keys(EXPERT_PACKAGE_SCENE_ROLES) as SkillHubKnownSkillSetScene[]);
const EXPERT_VIEW_OPTIONS: Array<{ value: ExpertView; label: string; icon: ElementType }> = [
  { value: "list", label: "列表", icon: List },
  { value: "grid", label: "卡片", icon: LayoutGrid },
];

const EXPERT_PAGE_SIZE = 200;
// SkillHub currently returns both domestic and international packages from the
// localized list endpoint. Keep the international catalog aligned with the
// package slugs supplied by the SkillHub team.
const INTERNATIONAL_EXPERT_PACKAGE_SLUGS = [
  "academic/literature-review",
  "content-creation/lyrics-songwriting",
  "content-creation/screenwriting",
  "content-creation/story-outlining-en",
  "design/interaction-design",
  "design/prd-writing",
  "ecommerce/product-selection-en",
  "ecommerce/user-profiling",
  "education/lesson-planning",
  "education/student-assessment",
  "education/training-program",
  "finance/financial-report-analysis-en",
  "finance/quant-backtesting-en",
  "healthcare/clinical-support",
  "healthcare/health-report",
  "healthcare/medical-record-analysis",
  "healthcare/nursing-plan",
  "hr/meeting-minutes-en",
  "hr/ppt-creation",
  "hr/resume-screening",
  "legal/contract-drafting",
  "legal/contract-review",
  "legal/litigation-strategy",
  "lifestyle/health-data-analysis-en",
  "lifestyle/meditation-mindfulness",
  "lifestyle/mental-counseling",
  "marketing/ad-copywriting",
  "media/script-breakdown",
  "media/storyboard-design",
  "media/video-editing",
  "mysticism/tarot-divination",
  "mysticism/zodiac-fortune",
  "tech/api-documentation",
  "tech/bug-troubleshooting",
  "tech/test-automation",
] as const;
const INTERNATIONAL_EXPERT_PACKAGE_API_SLUGS = INTERNATIONAL_EXPERT_PACKAGE_SLUGS.map((slug) => slug.replace("/", "-"));
const INTERNATIONAL_EXPERT_PACKAGE_SLUG_SET = new Set(INTERNATIONAL_EXPERT_PACKAGE_API_SLUGS);
const INTERNATIONAL_EXPERT_PACKAGE_ORDER = new Map(
  INTERNATIONAL_EXPERT_PACKAGE_API_SLUGS.map((slug, index) => [slug, index]),
);
const INSTALL_ERROR_OUTPUT_LINE_LIMIT = 3;
const SKILL_INSTALL_DEFAULT_RETRY_DELAYS_MS = [0] as const;
const SKILL_INSTALL_RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const SKILL_PACKAGE_COMMAND_TIMEOUT_MS = 120_000;
const AI_BUDDY_ASSET_BASE = "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple";
const AI_BUDDY_EXPERT_PROFILE_VERSION = "v20260625";
const AI_BUDDY_EXPERT_PROFILE_EXT = "avif";
const SKILLHUB_SELF_UPGRADE_COMMAND = "skillhub self-upgrade";
const SKILLHUB_DOWNLOAD_URL_TEMPLATE = "https://api.skillhub.cn/api/v1/download?slug={slug}";
const SKILLHUB_PACKAGE_SOURCE_URL = "https://skillhub.cn/skillspackage";
const INSTALLED_PACKAGES_STORAGE_PREFIX = "lightvela-experts-installed-packages";
const LEGACY_SKILL_DOC_NAMES = ["skill.md", "readme.md", "skills.md"];
const EXPERT_LANGUAGE_DOC_NAMES = {
  en: ["identify_en.md", ...LEGACY_SKILL_DOC_NAMES],
  zh: ["identify.md", ...LEGACY_SKILL_DOC_NAMES],
} as const;
type ExpertLanguage = "en" | "zh" | "es" | "ja";

function usesEnglishExpertContent(lang?: ExpertLanguage): boolean {
  return lang === "en" || lang === "es" || lang === "ja";
}
const PACKAGE_SKILL_SLUG_OVERRIDES: Record<string, Record<string, string>> = {
  "tech-code-review": {
    cody: "code-review-assistant",
  },
};
const PACKAGE_MISSING_SKILL_SLUGS: Record<string, string[]> = {
  "tech-test-automation": ["tdd-guide"],
};
const SKILL_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  "code-review-assistant": "code-review-assistant",
};

const EXPERT_PACKAGE_SCENE_ROLES_EN: Record<SkillHubKnownSkillSetScene, string> = {
  academic: "Academic Researcher",
  "content-creation": "Content Creation Expert",
  design: "Product Design Advisor",
  ecommerce: "Ecommerce Operations Expert",
  education: "Learning Planner",
  finance: "Investment Analysis Expert",
  healthcare: "Health Information Advisor",
  hr: "People and Organization Advisor",
  legal: "Legal and Compliance Advisor",
  lifestyle: "Lifestyle and Health Advisor",
  marketing: "Marketing Growth Expert",
  media: "Media Content Expert",
  mysticism: "Fortune and Divination Advisor",
  tech: "Senior Development Engineer",
};

const EXPERT_PACKAGE_SUB_SCENE_ROLES_EN: Record<string, string> = {
  "fitness-training": "Fitness Training Coach",
  "health-data-analysis": "Health Data Analyst",
  "lyrics-songwriting": "Lyric Writing Expert",
  "meditation-mindfulness": "Mindfulness Coach",
  "mental-counseling": "Mental Health Counseling Advisor",
  "novel-writing": "Novel Writing Expert",
  "nutrition-meal-plan": "Nutrition and Wellness Advisor",
  "poetry-creation": "Poetry Creation Expert",
  screenwriting: "Screenwriting Expert",
  "story-outlining": "Story Outline Planner",
};

const EXPERT_PACKAGE_SCENE_ROLES_ES: Record<SkillHubKnownSkillSetScene, string> = {
  academic: "Investigador académico",
  "content-creation": "Especialista en creación de contenido",
  design: "Asesor de diseño de producto",
  ecommerce: "Especialista en operaciones de comercio electrónico",
  education: "Asesor de planificación del aprendizaje",
  finance: "Especialista en análisis de inversiones",
  healthcare: "Asesor de información sanitaria",
  hr: "Asesor de talento y organización",
  legal: "Asesor de cumplimiento legal",
  lifestyle: "Asesor de vida saludable",
  marketing: "Especialista en crecimiento de marketing",
  media: "Especialista en contenido multimedia",
  mysticism: "Asesor de astrología y adivinación",
  tech: "Ingeniero de software sénior",
};

const EXPERT_PACKAGE_SUB_SCENE_ROLES_ES: Record<string, string> = {
  "fitness-training": "Entrenador personal",
  "health-data-analysis": "Analista de datos de salud",
  "lyrics-songwriting": "Especialista en composición de letras",
  "meditation-mindfulness": "Instructor de meditación y mindfulness",
  "mental-counseling": "Asesor psicológico",
  "novel-writing": "Especialista en escritura de novelas",
  "nutrition-meal-plan": "Asesor de nutrición y salud",
  "poetry-creation": "Especialista en poesía",
  screenwriting: "Guionista",
  "story-outlining": "Especialista en planificación de tramas",
};

const EXPERT_PACKAGE_SCENE_ROLES_JA: Record<SkillHubKnownSkillSetScene, string> = {
  academic: "学術リサーチャー",
  "content-creation": "コンテンツ制作エキスパート",
  design: "プロダクトデザインアドバイザー",
  ecommerce: "EC運用エキスパート",
  education: "学習プランナー",
  finance: "投資分析エキスパート",
  healthcare: "ヘルスケア情報アドバイザー",
  hr: "人材・組織アドバイザー",
  legal: "法務・コンプライアンスアドバイザー",
  lifestyle: "ライフスタイル・健康アドバイザー",
  marketing: "マーケティング成長エキスパート",
  media: "メディアコンテンツエキスパート",
  mysticism: "占いアドバイザー",
  tech: "シニア開発エンジニア",
};

const EXPERT_PACKAGE_SUB_SCENE_ROLES_JA: Record<string, string> = {
  "fitness-training": "フィットネストレーナー",
  "health-data-analysis": "健康データアナリスト",
  "lyrics-songwriting": "作詞エキスパート",
  "meditation-mindfulness": "マインドフルネスコーチ",
  "mental-counseling": "メンタルヘルスアドバイザー",
  "novel-writing": "小説執筆エキスパート",
  "nutrition-meal-plan": "栄養・健康アドバイザー",
  "poetry-creation": "詩作エキスパート",
  screenwriting: "脚本執筆エキスパート",
  "story-outlining": "ストーリー構成プランナー",
};
function getInstalledPackagesStorageKey(botId: string): string {
  return `${INSTALLED_PACKAGES_STORAGE_PREFIX}:${botId}`;
}

function readStoredInstalledPackageSlugs(botId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(getInstalledPackagesStorageKey(botId));
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return Array.isArray(parsed) ? new Set(getUniqueSkillSlugs(parsed.filter((item): item is string => typeof item === "string"))) : new Set();
  } catch {
    return new Set();
  }
}

function writeStoredInstalledPackageSlugs(botId: string, slugs: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getInstalledPackagesStorageKey(botId), JSON.stringify([...slugs]));
  } catch {
    /* Ignore storage failures in restricted contexts. */
  }
}

function mergeInstalledPackageSlugs(current: Set<string>, slugs: string[]): Set<string> {
  const next = new Set(current);
  for (const slug of getUniqueSkillSlugs(slugs)) {
    next.add(slug);
  }
  return next;
}

export function getPackageSkillSlugs(packageSlug: string, skillSlugs: string[], missingSkillSlugs: string[] = []): string[] {
  const overrides = PACKAGE_SKILL_SLUG_OVERRIDES[packageSlug];
  const missingSlugs = new Set(getUniqueSkillSlugs([
    ...missingSkillSlugs,
    ...(PACKAGE_MISSING_SKILL_SLUGS[packageSlug] ?? []),
  ]));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const skillSlug of skillSlugs) {
    const normalizedSkillSlug = skillSlug.trim();
    if (!normalizedSkillSlug || missingSlugs.has(normalizedSkillSlug)) continue;
    const displaySlug = (overrides?.[normalizedSkillSlug] ?? normalizedSkillSlug).trim();
    if (!displaySlug || missingSlugs.has(displaySlug) || seen.has(displaySlug)) continue;
    seen.add(displaySlug);
    result.push(displaySlug);
  }

  return result;
}

function isMissingSkillDetailError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\b)(?:404|not found|skill not found)(?:\b|$)/i.test(message);
}

export async function resolveAvailablePackageSkillSlugs(
  packageSlug: string,
  skillSlugs: string[],
  missingSkillSlugs: string[] = [],
): Promise<string[]> {
  const normalizedSkillSlugs = getPackageSkillSlugs(packageSlug, skillSlugs, missingSkillSlugs);
  const checkedSkillSlugs = await Promise.all(
    normalizedSkillSlugs.map(async (skillSlug) => {
      try {
        await fetchSkillDetail(skillSlug);
        return skillSlug;
      } catch (error) {
        return isMissingSkillDetailError(error) ? null : skillSlug;
      }
    }),
  );
  return getUniqueSkillSlugs(checkedSkillSlugs.filter((skillSlug): skillSlug is string => !!skillSlug));
}

function getKnownExpertScene(scene: string | undefined): SkillHubKnownSkillSetScene | undefined {
  const normalized = scene?.trim();
  return normalized && EXPERT_KNOWN_SCENE_SET.has(normalized as SkillHubKnownSkillSetScene)
    ? normalized as SkillHubKnownSkillSetScene
    : undefined;
}

function hasVisibleExpertPackageScene(pkg: Pick<SkillHubSkillSet, "scene">): boolean {
  return typeof pkg.scene === "string" && pkg.scene.trim().length > 0;
}

function getPackageScene(
  pkg: Pick<SkillHubSkillSet, "scene">,
  fallback: ExpertFilterId,
): SkillHubKnownSkillSetScene | undefined {
  const scene = getKnownExpertScene(pkg.scene);
  if (scene) return scene;
  return fallback === "all" ? undefined : fallback;
}

function getExpertRole(
  pkg: Pick<SkillHubSkillSet, "displayName" | "scene" | "subScene">,
  fallback: ExpertFilterId,
  t: ReturnType<typeof useT>,
  lang?: ExpertLanguage,
): string {
  const subSceneRoles = lang === "ja"
    ? EXPERT_PACKAGE_SUB_SCENE_ROLES_JA
    : lang === "es"
    ? EXPERT_PACKAGE_SUB_SCENE_ROLES_ES
    : lang === "en"
      ? EXPERT_PACKAGE_SUB_SCENE_ROLES_EN
      : EXPERT_PACKAGE_SUB_SCENE_ROLES;
  const sceneRoles = lang === "ja"
    ? EXPERT_PACKAGE_SCENE_ROLES_JA
    : lang === "es"
    ? EXPERT_PACKAGE_SCENE_ROLES_ES
    : lang === "en"
      ? EXPERT_PACKAGE_SCENE_ROLES_EN
      : EXPERT_PACKAGE_SCENE_ROLES;
  const subSceneRole = pkg.subScene ? subSceneRoles[pkg.subScene] : undefined;
  if (subSceneRole) return subSceneRole;

  const scene = getPackageScene(pkg, fallback);
  const sceneRole = scene ? sceneRoles[scene] : undefined;
  return sceneRole ?? t("技能包");
}

export function getEnglishPackageFrontmatterValue(content: string | undefined, key: string): string | undefined {
  if (!content) return undefined;
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1];
  if (!frontmatter) return undefined;

  const lines = frontmatter.split("\n");
  const keyPattern = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  const lineIndex = lines.findIndex((line) => keyPattern.test(line));
  if (lineIndex < 0) return undefined;

  const matchingLine = lines[lineIndex];
  if (!matchingLine) return undefined;
  const match = matchingLine.match(keyPattern);
  const rawValue = match?.[1]?.trim() ?? "";
  if ([">", ">-", ">+", "|", "|-", "|+"].includes(rawValue)) {
    const continuation: string[] = [];
    for (const line of lines.slice(lineIndex + 1)) {
      if (line.trim() && !/^\s/.test(line)) break;
      if (line.trim()) continuation.push(line.trim());
    }
    const separator = rawValue.startsWith(">") ? " " : "\n";
    return continuation.join(separator).trim() || undefined;
  }

  return rawValue.replace(/^["']|["']$/g, "").trim() || undefined;
}

function formatEnglishPackageSlug(slug: string): string {
  return slug
    .replace(/[\/_-]+/g, " ")
    .split(/\s+/)
    .filter((part) => part.toLowerCase() !== "en")
    .map((part) => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function getLocalizedPackageDisplayName(pkg: SkillHubSkillSet, lang?: ExpertLanguage): string {
  if (!usesEnglishExpertContent(lang)) return pkg.displayName;
  return pkg.displayNameEn?.trim()
    || getEnglishPackageFrontmatterValue(pkg.contentEn, "display_name")
    || (pkg.displayName?.trim() && !/[\u3400-\u9fff]/.test(pkg.displayName) ? pkg.displayName.trim() : undefined)
    || formatEnglishPackageSlug(pkg.slug);
}

function getEnglishPackageSummary(pkg: SkillHubSkillSet): string | undefined {
  if (pkg.summaryEn?.trim()) return pkg.summaryEn.trim();
  const frontmatterDescription = getEnglishPackageFrontmatterValue(pkg.contentEn, "description");
  if (frontmatterDescription) return frontmatterDescription;
  if (pkg.summary?.trim() && !/[\u3400-\u9fff]/.test(pkg.summary)) return pkg.summary.trim();
  if (!pkg.contentEn) return undefined;

  const body = stripMarkdownFrontmatter(pkg.contentEn);
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#+\s*/, "").trim())
    .find((paragraph) => paragraph && !paragraph.startsWith("- "));
}

function getPackageSummary(
  pkg: SkillHubSkillSet,
  t: ReturnType<typeof useT>,
  lang?: ExpertLanguage,
): string {
  if (usesEnglishExpertContent(lang)) {
    return getEnglishPackageSummary(pkg)
      || `A curated skill package for ${getLocalizedPackageDisplayName(pkg, "en")}.`;
  }
  return pkg.summary || pkg.summaryEn || pkg.remark || t("精选技能包组合，适合直接接入完整工作流。");
}

export function buildInstallSkillCommand(skillSlug: string): string {
  return `env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE=${shellQuote(SKILLHUB_DOWNLOAD_URL_TEMPLATE)} acli skills install ${shellQuote(skillSlug)}`;
}

export function buildInstallSkillsBatchCommand(skillSlugs: string[]): string {
  return `env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE=${shellQuote(SKILLHUB_DOWNLOAD_URL_TEMPLATE)} acli skills batch-install --wait=true ${shellQuote(skillSlugs.join(" "))}`;
}

export function buildSkillHubSelfUpgradeCommand(): string {
  return SKILLHUB_SELF_UPGRADE_COMMAND;
}

export function stripMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").trim();
}

export function getExpertSkillDocumentPath(filePaths: string[], lang?: ExpertLanguage): string | null {
  const targetNames = usesEnglishExpertContent(lang)
    ? EXPERT_LANGUAGE_DOC_NAMES.en
    : EXPERT_LANGUAGE_DOC_NAMES.zh;
  for (const targetName of targetNames) {
    const matched = filePaths.find((path) => !path.includes("/") && path.toLowerCase() === targetName);
    if (matched) return matched;
  }
  return null;
}

async function fetchSkillMarkdown(skillSlug: string, lang?: ExpertLanguage): Promise<string> {
  const files = await fetchSkillFiles(skillSlug);
  const docPath = getExpertSkillDocumentPath(files.map((file) => file.path), lang);
  if (!docPath) {
    throw new Error(getMissingExpertSkillDocumentMessage(lang));
  }
  return stripMarkdownFrontmatter(await fetchSkillFile(skillSlug, docPath));
}

export function getMissingExpertSkillDocumentMessage(lang?: ExpertLanguage): string {
  if (lang === "ja") return "identify_en.md または互換性のあるスキル文書が見つかりません";
  return usesEnglishExpertContent(lang)
    ? "Could not find identify_en.md or a compatible skill document"
    : "未找到 identify.md 或兼容技能文档";
}

async function fetchSkillDisplayNames(
  skillSlugs: string[],
  lang?: ExpertLanguage,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    skillSlugs.map(async (skillSlug) => {
      try {
        const skill = await fetchSkillDetail(skillSlug, usesEnglishExpertContent(lang) ? { lang: "en" } : undefined);
        const displayName = usesEnglishExpertContent(lang) ? skill.displayNameEn || skill.displayName : skill.displayName;
        return [skillSlug, displayName || formatSkillDisplayName(skillSlug)] as const;
      } catch {
        return [skillSlug, formatSkillDisplayName(skillSlug)] as const;
      }
    }),
  );
  return new Map(entries);
}

function formatSkillDisplayName(slug: string): string {
  const displayName = SKILL_DISPLAY_NAME_OVERRIDES[slug];
  if (displayName) return displayName;

  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getSkillHubErrorMessage(error: string | Error, t: ReturnType<typeof useT>): string {
  const message = typeof error === "string" ? error : error.message;
  if (/failed to fetch/i.test(message)) {
    return t("无法连接 SkillHub，请稍后重试");
  }
  return message;
}

export function isSkillInstallAlreadyExists(output: string): boolean {
  return /Target exists:/i.test(output) || /use --force to overwrite/i.test(output);
}

function isExecSucceeded(result: ExecDebugCommandResult): boolean {
  const status = result.status.toLowerCase();
  return result.exitCode === 0 && status !== "failed" && status !== "error";
}

function isSkillHubInstallSuccessOutput(output: string): boolean {
  const parsed = tryParseJson(output.trim());
  if (isRecord(parsed) && parsed.success === true) return true;
  return false;
}

function isSkillInstallSucceeded(result: ExecDebugCommandResult): boolean {
  return isExecSucceeded(result)
    || isSkillInstallAlreadyExists(result.output)
    || isSkillHubInstallSuccessOutput(result.output);
}

function shouldUpgradeSkillHubCli(output: string): boolean {
  return /skillhub self-upgrade/i.test(output) || /发现新版本/i.test(output);
}

function isSkillInstallRateLimited(output: string): boolean {
  return /\bHTTP\s*429\b/i.test(output) || /rate[-\s]?limited/i.test(output) || /too many requests/i.test(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function executeInstallSkillCommand(
  botId: string,
  skillSlug: string,
  execDebugCommand: ExpertsExecDebugCommand,
): Promise<{ succeeded: boolean; output: string }> {
  try {
    const result = await execDebugCommand(botId, buildInstallSkillCommand(skillSlug), {
      timeoutMs: SKILL_PACKAGE_COMMAND_TIMEOUT_MS,
    });
    return {
      succeeded: isSkillInstallSucceeded(result),
      output: result.output,
    };
  } catch (error) {
    return {
      succeeded: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function waitForSkillInstallRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

async function retryFailedSkillInstall(
  botId: string,
  skillSlug: string,
  execDebugCommand: ExpertsExecDebugCommand,
  failedResult: { succeeded: boolean; output: string },
): Promise<{ succeeded: boolean; output: string }> {
  let result = failedResult;
  const retryDelays = isSkillInstallRateLimited(result.output)
    ? SKILL_INSTALL_RATE_LIMIT_RETRY_DELAYS_MS
    : SKILL_INSTALL_DEFAULT_RETRY_DELAYS_MS;

  for (const retryDelay of retryDelays) {
    await waitForSkillInstallRetry(retryDelay);
    result = await executeInstallSkillCommand(botId, skillSlug, execDebugCommand);
    if (result.succeeded || !isSkillInstallRateLimited(result.output)) return result;
  }

  return result;
}

type SkillHubUpgradeState = {
  attempted: boolean;
};

async function recoverSkillInstall(
  botId: string,
  skillSlug: string,
  execDebugCommand: ExpertsExecDebugCommand,
  failedResult: { succeeded: boolean; output: string },
  upgradeState: SkillHubUpgradeState,
): Promise<{ succeeded: boolean; output: string }> {
  let result = failedResult;
  if (!result.succeeded && !upgradeState.attempted && shouldUpgradeSkillHubCli(result.output)) {
    upgradeState.attempted = true;
    await execDebugCommand(botId, buildSkillHubSelfUpgradeCommand(), {
      timeoutMs: SKILL_PACKAGE_COMMAND_TIMEOUT_MS,
    }).catch(() => null);
    result = await executeInstallSkillCommand(botId, skillSlug, execDebugCommand);
  }
  if (!result.succeeded) {
    result = await retryFailedSkillInstall(botId, skillSlug, execDebugCommand, result);
  }
  return result;
}

async function installSkillSlugWithRecovery(
  botId: string,
  skillSlug: string,
  execDebugCommand: ExpertsExecDebugCommand,
  upgradeState: SkillHubUpgradeState,
): Promise<{ succeeded: boolean; output: string }> {
  const result = await executeInstallSkillCommand(botId, skillSlug, execDebugCommand);
  if (result.succeeded) return result;
  return recoverSkillInstall(botId, skillSlug, execDebugCommand, result, upgradeState);
}

function toPackageSkill(skillSlug: string): Skill {
  return {
    registry: "skillhub",
    rawId: skillSlug,
    slug: skillSlug,
    name: skillSlug,
  };
}

function mapBatchInstallResult(
  skillSlugs: string[],
  result: BatchInstallResult,
): SkillInstallResult {
  const succeededSlugs = new Set(result.succeeded.map((skill) => skill.rawId));
  const failedOutputs = new Map(result.failed.map(({ skill, message }) => [skill.rawId, message ?? ""]));
  return {
    succeeded: skillSlugs.filter((skillSlug) => succeededSlugs.has(skillSlug)),
    failed: skillSlugs
      .filter((skillSlug) => failedOutputs.has(skillSlug))
      .map((skillSlug) => ({ slug: skillSlug, output: failedOutputs.get(skillSlug) ?? "" })),
  };
}

async function installSkillSlugsSequentially(
  botId: string,
  skillSlugs: string[],
  execDebugCommand: ExpertsExecDebugCommand,
  onProgress?: (progress: SkillInstallProgress) => void,
  upgradeState: SkillHubUpgradeState = { attempted: false },
): Promise<SkillInstallResult> {
  const succeeded: string[] = [];
  const failed: SkillInstallFailure[] = [];

  for (const [index, skillSlug] of skillSlugs.entries()) {
    onProgress?.({ current: index + 1, total: skillSlugs.length });
    const result = await installSkillSlugWithRecovery(botId, skillSlug, execDebugCommand, upgradeState);
    if (result.succeeded) succeeded.push(skillSlug);
    else failed.push({ slug: skillSlug, output: result.output });
  }

  return { succeeded, failed };
}

async function installSkillSlugsWithNativeBatch(
  botId: string,
  skillSlugs: string[],
  execDebugCommand: ExpertsExecDebugCommand,
  execDebugCommandStream: SkillsExecDebugCommandStream,
  onProgress?: (progress: SkillInstallProgress) => void,
): Promise<SkillInstallResult> {
  const skills = skillSlugs.map(toPackageSkill);
  const upgradeState: SkillHubUpgradeState = { attempted: false };
  let usedSequentialFallback = false;
  let maxReportedProgress = 0;
  const reportProgress = (current: number, total: number) => {
    maxReportedProgress = Math.max(maxReportedProgress, current);
    onProgress?.({ current: maxReportedProgress, total });
  };
  const runBatchInstall = () => {
    usedSequentialFallback = false;
    return installSkillsWithNativeBatch(
      botId,
      execDebugCommandStream,
      async (skill) => {
        const result = await installSkillSlugWithRecovery(botId, skill.rawId, execDebugCommand, upgradeState);
        return { ok: result.succeeded, message: result.output };
      },
      skills,
      ({ index, total }) => reportProgress(index, total),
      {
        buildBatchCommand: (_registry, batchSkills) => (
          buildInstallSkillsBatchCommand(batchSkills.map((skill) => skill.rawId))
        ),
        onSequentialFallback: () => {
          usedSequentialFallback = true;
        },
        onIncompleteResults: (_registry, incompleteSkills) => {
          // eslint-disable-next-line no-console
          console.warn(
            "[experts] ACLI batch-install omitted results; retrying individually:",
            incompleteSkills.map((skill) => skill.rawId),
          );
        },
      },
    );
  };

  let batchResult = await runBatchInstall();
  if (usedSequentialFallback) return mapBatchInstallResult(skillSlugs, batchResult);

  const shouldRetryBatchAfterUpgrade = !upgradeState.attempted
    && batchResult.succeeded.length === 0
    && batchResult.failed.length === skills.length
    && batchResult.failed.every(({ message }) => shouldUpgradeSkillHubCli(message ?? ""));
  if (shouldRetryBatchAfterUpgrade) {
    upgradeState.attempted = true;
    await execDebugCommand(botId, buildSkillHubSelfUpgradeCommand(), {
      timeoutMs: SKILL_PACKAGE_COMMAND_TIMEOUT_MS,
    }).catch(() => null);
    batchResult = await runBatchInstall();
    if (usedSequentialFallback) return mapBatchInstallResult(skillSlugs, batchResult);
  }

  const succeededSlugs = new Set(batchResult.succeeded.map((skill) => skill.rawId));
  const failedOutputs = new Map<string, string>();
  for (const { skill, message } of batchResult.failed) {
    reportProgress(skillSlugs.indexOf(skill.rawId) + 1, skillSlugs.length);
    const recovered = await recoverSkillInstall(
      botId,
      skill.rawId,
      execDebugCommand,
      { succeeded: false, output: message ?? "" },
      upgradeState,
    );
    if (recovered.succeeded) succeededSlugs.add(skill.rawId);
    else failedOutputs.set(skill.rawId, recovered.output);
  }

  return {
    succeeded: skillSlugs.filter((skillSlug) => succeededSlugs.has(skillSlug)),
    failed: skillSlugs
      .filter((skillSlug) => failedOutputs.has(skillSlug))
      .map((skillSlug) => ({ slug: skillSlug, output: failedOutputs.get(skillSlug) ?? "" })),
  };
}

export async function installSkillSlugs(
  botId: string,
  skillSlugs: string[],
  execDebugCommand: ExpertsExecDebugCommand,
  onProgress?: (progress: SkillInstallProgress) => void,
  execDebugCommandStream?: SkillsExecDebugCommandStream,
): Promise<SkillInstallResult> {
  if (execDebugCommandStream) {
    return installSkillSlugsWithNativeBatch(
      botId,
      skillSlugs,
      execDebugCommand,
      execDebugCommandStream,
      onProgress,
    );
  }
  return installSkillSlugsSequentially(botId, skillSlugs, execDebugCommand, onProgress);
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function compactInstallErrorMessage(message: string): string {
  const normalized = message.replace(/\\n/g, "\n").replace(/\\"/g, "\"").trim();
  const downloadFailure = normalized.match(/Download failed:[^;}]+/i)?.[0]?.trim().replace(/["']+$/, "");
  if (downloadFailure) return downloadFailure;

  const targetExists = normalized.match(/Target exists:[^;}]+/i)?.[0]?.trim().replace(/["']+$/, "");
  if (targetExists) return targetExists;

  return normalized
    .split(/\r?\n|；|; /)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^error:?\s*$/i.test(line))
    .slice(-INSTALL_ERROR_OUTPUT_LINE_LIMIT)
    .join("；");
}

function readInstallErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const parsed = tryParseJson(trimmed);
    return parsed === null ? compactInstallErrorMessage(trimmed) : readInstallErrorMessage(parsed);
  }
  if (!isRecord(value)) return "";
  const message = value.message;
  if (typeof message === "string" && message.trim()) return readInstallErrorMessage(message);
  const error = value.error;
  if (typeof error === "string" && error.trim()) return readInstallErrorMessage(error);
  if (isRecord(error)) return readInstallErrorMessage(error);
  return "";
}

export function formatInstallFailureOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";

  try {
    const parsed = tryParseJson(trimmed);
    const parsedMessage = readInstallErrorMessage(parsed);
    if (parsedMessage) return parsedMessage;
  } catch {
    /* Non-JSON output falls through to line trimming. */
  }

  const normalizedOutput = trimmed.replace(/\\n/g, "\n").replace(/\\"/g, "\"");
  return normalizedOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^error:?\s*$/i.test(line))
    .slice(-INSTALL_ERROR_OUTPUT_LINE_LIMIT)
    .join("；");
}

export function getSkillPackageInstallFailureMessage(
  result: SkillInstallResult,
  t: ReturnType<typeof useT>,
): string {
  const failedSlugs = result.failed.map((failure) => failure.slug).join(", ");
  const output = result.failed
    .map((failure) => formatInstallFailureOutput(failure.output))
    .find(Boolean);
  const summary = t("技能包安装：成功 {{ok}} 项，失败 {{fail}} 项", {
    ok: result.succeeded.length,
    fail: result.failed.length,
  });

  if (!output) {
    return `${summary}。${t("失败：{{skills}}", { skills: failedSlugs })}`;
  }

  return `${summary}。${t("失败：{{skills}}；错误：{{detail}}", {
    skills: failedSlugs,
    detail: output,
  })}`;
}

async function fetchAllExpertPackages(keyword: string, lang?: string): Promise<SkillHubSkillSet[]> {
  const expertLanguage = lang === "en" || lang === "zh" || lang === "es" || lang === "ja" ? lang : undefined;
  const apiLanguage = expertLanguage === "en" || expertLanguage === "es" || expertLanguage === "ja" ? "en" : undefined;
  let page = 1;
  let total = 0;
  const allPackages: SkillHubSkillSet[] = [];

  do {
    const response = await fetchSkillSets({
      keyword,
      lang: apiLanguage,
      page,
      pageSize: EXPERT_PAGE_SIZE,
    });
    const packages = response.skillSets ?? [];
    allPackages.push(...packages);
    total = response.total ?? allPackages.length;
    if (packages.length === 0) break;
    page += 1;
  } while (allPackages.length < total);

  const visiblePackages = allPackages
    .filter(hasVisibleExpertPackageScene)
    .filter((pkg) => !expertLanguage || INTERNATIONAL_EXPERT_PACKAGE_SLUG_SET.has(pkg.slug));

  if (!expertLanguage) return visiblePackages;

  const sortByInternationalOrder = (left: SkillHubSkillSet, right: SkillHubSkillSet) => (
    (INTERNATIONAL_EXPERT_PACKAGE_ORDER.get(left.slug) ?? Number.MAX_SAFE_INTEGER)
    - (INTERNATIONAL_EXPERT_PACKAGE_ORDER.get(right.slug) ?? Number.MAX_SAFE_INTEGER)
  );
  if (keyword.trim()) return visiblePackages.sort(sortByInternationalOrder);

  const missingPackages = INTERNATIONAL_EXPERT_PACKAGE_API_SLUGS.filter(
    (slug) => !visiblePackages.some((pkg) => pkg.slug === slug),
  );
  const fetchedMissingPackages = await Promise.all(missingPackages.map(async (slug) => {
    try {
      return await fetchSkillSetDetail(slug, apiLanguage ? { lang: apiLanguage } : undefined);
    } catch {
      return null;
    }
  }));

  const availableMissingPackages = fetchedMissingPackages.flatMap((pkg) => pkg ? [pkg] : []);
  return [...visiblePackages, ...availableMissingPackages]
    .sort(sortByInternationalOrder);
}

function filterExpertPackagesByScene(
  packages: SkillHubSkillSet[],
  activeFilter: ExpertFilterId,
): SkillHubSkillSet[] {
  if (activeFilter === "all") return packages;
  return packages.filter((pkg) => getKnownExpertScene(pkg.scene) === activeFilter);
}

async function fetchExperts(params: {
  keyword: string;
  lang?: string;
}): Promise<SkillHubSkillSet[]> {
  return fetchAllExpertPackages(params.keyword, params.lang);
}

export function ExpertsPanel({
  botId,
  profileId,
  mode = "domestic",
  execDebugCommand: baseExecDebugCommand,
  execDebugCommandStream: baseExecDebugCommandStream,
  lang,
}: {
  botId: string;
  profileId?: string;
  mode?: "domestic" | "global";
  execDebugCommand: ExpertsExecDebugCommand;
  execDebugCommandStream?: SkillsExecDebugCommandStream;
  lang?: ExpertLanguage;
}) {
  const t = useT();
  const scopeSkillsCommand = useCallback((command: string) => {
    if (!/(?:^|\s)acli skills\s/.test(command)) return command;
    if (mode === "global") return profileId ? withHermesAgent(command, profileId) : command;
    return withHermesSkillsProfile(command, profileId);
  }, [mode, profileId]);
  const execDebugCommand = useCallback<ExpertsExecDebugCommand>((targetBotId, command, options) => (
    baseExecDebugCommand(
      targetBotId,
      scopeSkillsCommand(command),
      options,
    )
  ), [baseExecDebugCommand, scopeSkillsCommand]);
  const execDebugCommandStream = useMemo<SkillsExecDebugCommandStream | undefined>(() => {
    if (!baseExecDebugCommandStream) return undefined;
    return (targetBotId, command, onChunk, options) => baseExecDebugCommandStream(
      targetBotId,
      scopeSkillsCommand(command),
      onChunk,
      options,
    );
  }, [baseExecDebugCommandStream, scopeSkillsCommand]);
  const [activeFilter, setActiveFilter] = useState<ExpertFilterId>("all");
  const [keyword, setKeyword] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [view, setView] = useState<ExpertView>(() => {
    if (typeof window === "undefined") return "list";
    return window.localStorage.getItem("lightvela-experts-view") === "grid" ? "grid" : "list";
  });
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<SkillInstallProgress | null>(null);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(() => readStoredInstalledPackageSlugs(botId));
  const installedSlugsRef = useRef(installedSlugs);
  const [installedSkillSlugs, setInstalledSkillSlugs] = useState<Set<string>>(() => new Set());
  const [installedSkillsLoaded, setInstalledSkillsLoaded] = useState(false);
  const [packageSkillSlugs, setPackageSkillSlugs] = useState<Map<string, string[]>>(() => new Map());
  const [selectedCard, setSelectedCard] = useState<ExpertPackageCard | null>(null);
  const [expertPackages, setExpertPackages] = useState<SkillHubSkillSet[]>([]);
  const [expertsLoading, setExpertsLoading] = useState(true);
  const [expertsError, setExpertsError] = useState<Error | null>(null);
  const [expertsRetryNonce, setExpertsRetryNonce] = useState(0);
  const expertsRequestIdRef = useRef(0);

  const filteredExpertPackages = useMemo(() => {
    return filterExpertPackagesByScene(expertPackages, activeFilter);
  }, [activeFilter, expertPackages]);

  const visibleCards = useMemo<ExpertPackageCard[]>(() => {
    return filteredExpertPackages.map((pkg) => ({ pkg }));
  }, [filteredExpertPackages]);

  useEffect(() => {
    installedSlugsRef.current = installedSlugs;
  }, [installedSlugs]);

  const handleViewChange = useCallback((nextView: ExpertView) => {
    setView(nextView);
    try {
      window.localStorage.setItem("lightvela-experts-view", nextView);
    } catch {
      /* localStorage may be unavailable in restricted contexts. */
    }
  }, []);

  const commitSearch = useCallback((value: string) => {
    const nextKeyword = value.trim();
    setSearchDraft(nextKeyword);
    setKeyword(nextKeyword);
    setSelectedCard(null);
  }, []);

  const reloadExperts = useCallback(() => {
    setExpertPackages([]);
    setExpertsRetryNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    const currentRequestId = ++expertsRequestIdRef.current;
    setExpertsLoading(true);
    setExpertPackages([]);
    setExpertsError(null);

    fetchExperts({ keyword, lang })
      .then((packages) => {
        if (currentRequestId !== expertsRequestIdRef.current) return;
        setExpertPackages(packages);
      })
      .catch((error) => {
        if (currentRequestId !== expertsRequestIdRef.current) return;
        setExpertsError(error instanceof Error ? error : new Error(String(error)));
        setExpertPackages([]);
      })
      .finally(() => {
        if (currentRequestId !== expertsRequestIdRef.current) return;
        setExpertsLoading(false);
      });
  }, [expertsRetryNonce, keyword, lang]);

  useEffect(() => {
    let cancelled = false;
    const cachedPackageSlugs = readStoredInstalledPackageSlugs(botId);
    installedSlugsRef.current = cachedPackageSlugs;
    setInstalledSlugs(cachedPackageSlugs);
    setInstalledSkillSlugs(new Set());
    setInstalledSkillsLoaded(false);
    setPackageSkillSlugs(new Map());

    async function refreshInstalledPackages() {
      try {
        const state = await loadExpertPackagesState(botId);
        if (cancelled || !state) return;
        setInstalledSlugs((current) => {
          const next = mergeInstalledPackageSlugs(current, state.installedPackageSlugs);
          installedSlugsRef.current = next;
          writeStoredInstalledPackageSlugs(botId, next);
          return next;
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[experts] loadExpertPackagesState failed:", error);
      }
    }

    async function refreshInstalledSkills() {
      try {
        const id = mode === "domestic" ? requireHermesSkillsProfile(profileId) : profileId;
        const result = await execDebugCommand(botId, buildInstalledSkillsListCommand(id), {
          timeoutMs: SKILL_PACKAGE_COMMAND_TIMEOUT_MS,
        });
        if (!cancelled) {
          if (isExecSucceeded(result)) {
            setInstalledSkillSlugs(new Set(parseInstalledSkillSlugs(result.output)));
            setInstalledSkillsLoaded(true);
          } else {
            setInstalledSkillSlugs(new Set());
            setInstalledSkillsLoaded(false);
          }
        }
      } catch {
        if (!cancelled) {
          setInstalledSkillSlugs(new Set());
          setInstalledSkillsLoaded(false);
        }
      }
    }

    void refreshInstalledPackages();
    void refreshInstalledSkills();
    return () => {
      cancelled = true;
    };
  }, [botId, execDebugCommand, mode, profileId]);

  useEffect(() => {
    if (!installedSkillsLoaded || installedSlugs.size === 0 || visibleCards.length === 0) return;

    const missingCards = visibleCards.filter(({ pkg }) => {
      return installedSlugs.has(pkg.slug)
        && !packageSkillSlugs.has(pkg.slug)
        && !Array.isArray(pkg.skillSlugs);
    });
    if (missingCards.length === 0) return;

    let cancelled = false;

    async function fetchVisiblePackageDetails() {
      await Promise.all(missingCards.map(async ({ pkg }) => {
        try {
          const detail = usesEnglishExpertContent(lang)
            ? await fetchSkillSetDetail(pkg.slug, { lang: "en" })
            : await fetchSkillSetDetail(pkg.slug);
          const skillSlugs = getPackageSkillSlugs(
            pkg.slug,
            detail.skillSlugs ?? pkg.skillSlugs ?? [],
            detail.missing ?? pkg.missing ?? [],
          );
          if (cancelled) return;
          setPackageSkillSlugs((current) => {
            if (current.has(pkg.slug)) return current;
            const next = new Map(current);
            next.set(pkg.slug, skillSlugs);
            return next;
          });
        } catch {
          if (cancelled) return;
          setPackageSkillSlugs((current) => {
            if (current.has(pkg.slug)) return current;
            const fallbackSkillSlugs = getPackageSkillSlugs(pkg.slug, pkg.skillSlugs ?? [], pkg.missing ?? []);
            const next = new Map(current);
            next.set(pkg.slug, fallbackSkillSlugs);
            return next;
          });
        }
      }));
    }

    void fetchVisiblePackageDetails();
    return () => {
      cancelled = true;
    };
  }, [installedSkillsLoaded, installedSlugs, lang, packageSkillSlugs, visibleCards]);

  const getKnownSkillSlugs = useCallback((pkg: SkillHubSkillSet) => {
    return getPackageSkillSlugs(pkg.slug, packageSkillSlugs.get(pkg.slug) ?? pkg.skillSlugs ?? [], pkg.missing ?? []);
  }, [packageSkillSlugs]);

  const isPackageInstalled = useCallback((pkg: SkillHubSkillSet) => {
    const knownSkillSlugs = getKnownSkillSlugs(pkg);
    const hasInstalledSkillPackage = knownSkillSlugs.length > 0
      && knownSkillSlugs.every((skillSlug) => installedSkillSlugs.has(skillSlug));
    const hasResolvedPackageSkills = packageSkillSlugs.has(pkg.slug) || Array.isArray(pkg.skillSlugs);
    if (installedSkillsLoaded && hasResolvedPackageSkills) {
      return hasInstalledSkillPackage;
    }
    return installedSlugs.has(pkg.slug) || hasInstalledSkillPackage;
  }, [getKnownSkillSlugs, installedSkillSlugs, installedSkillsLoaded, installedSlugs, packageSkillSlugs]);

  useEffect(() => {
    if (!installedSkillsLoaded || installedSlugs.size === 0 || expertPackages.length === 0) return;

    const packageBySlug = new Map(expertPackages.map((pkg) => [pkg.slug, pkg]));
    const stalePackageSlugs = [...installedSlugs].filter((packageSlug) => {
      const pkg = packageBySlug.get(packageSlug);
      if (!pkg) return false;
      const hasResolvedPackageSkills = packageSkillSlugs.has(packageSlug) || Array.isArray(pkg.skillSlugs);
      if (!hasResolvedPackageSkills) return false;
      const skillSlugs = getKnownSkillSlugs(pkg);
      return skillSlugs.length === 0 || skillSlugs.some((skillSlug) => !installedSkillSlugs.has(skillSlug));
    });
    if (stalePackageSlugs.length === 0) return;

    const nextInstalledSlugs = new Set(installedSlugs);
    stalePackageSlugs.forEach((packageSlug) => nextInstalledSlugs.delete(packageSlug));
    installedSlugsRef.current = nextInstalledSlugs;
    writeStoredInstalledPackageSlugs(botId, nextInstalledSlugs);
    setInstalledSlugs(nextInstalledSlugs);
    saveExpertPackagesState(botId, { installedPackageSlugs: [...nextInstalledSlugs] })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[experts] saveExpertPackagesState failed:", error);
      });
  }, [botId, expertPackages, getKnownSkillSlugs, installedSkillSlugs, installedSkillsLoaded, installedSlugs, packageSkillSlugs]);

  const handleInstall = useCallback(async (pkg: SkillHubSkillSet) => {
    if (installingSlug) return;
    setInstallingSlug(pkg.slug);
    try {
      const detail = usesEnglishExpertContent(lang)
        ? await fetchSkillSetDetail(pkg.slug, { lang: "en" })
        : await fetchSkillSetDetail(pkg.slug);
      const skillSlugs = await resolveAvailablePackageSkillSlugs(pkg.slug, detail.skillSlugs ?? [], detail.missing ?? []);
      if (skillSlugs.length === 0) {
        toast.error(t("该技能包暂未包含可安装的 skills"));
        return;
      }

      const installResult = await installSkillSlugs(
        botId,
        skillSlugs,
        execDebugCommand,
        setInstallProgress,
        execDebugCommandStream,
      );
      if (installResult.failed.length > 0) {
        toast.error(getSkillPackageInstallFailureMessage(installResult, t));
        return;
      }

      const nextInstalledSlugs = new Set(installedSlugsRef.current);
      nextInstalledSlugs.add(pkg.slug);
      installedSlugsRef.current = nextInstalledSlugs;
      writeStoredInstalledPackageSlugs(botId, nextInstalledSlugs);
      setInstalledSlugs(nextInstalledSlugs);
      saveExpertPackagesState(botId, { installedPackageSlugs: [...nextInstalledSlugs] })
        .catch((error: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[experts] saveExpertPackagesState failed:", error);
        });
      setInstalledSkillSlugs((current) => {
        const next = new Set(current);
        installResult.succeeded.forEach((skillSlug) => next.add(skillSlug));
        return next;
      });
      setPackageSkillSlugs((current) => {
        const next = new Map(current);
        next.set(pkg.slug, skillSlugs);
        return next;
      });
      toast.success(t("技能包安装成功"));
    } catch (error) {
      toast.error(error instanceof Error ? getSkillHubErrorMessage(error, t) : t("技能包安装失败"));
    } finally {
      setInstallingSlug(null);
      setInstallProgress(null);
    }
  }, [botId, execDebugCommand, execDebugCommandStream, installingSlug, lang, profileId, t]);

  const handleOpenDetail = useCallback((card: ExpertPackageCard) => {
    setSelectedCard(card);
  }, []);

  if (selectedCard) {
    return (
      <SkillPackageDetailView
        card={selectedCard}
        activeFilter={activeFilter}
        installingSlug={installingSlug}
        installProgress={installProgress}
        isInstalled={isPackageInstalled(selectedCard.pkg)}
        onBack={() => setSelectedCard(null)}
        onInstall={handleInstall}
        lang={lang}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <ExpertSearchBox value={searchDraft} onChange={setSearchDraft} onCommit={commitSearch} lang={lang} />
          <ExpertViewToggle value={view} onChange={handleViewChange} lang={lang} />
        </div>

        <ExpertSceneFilters
          activeFilter={activeFilter}
          lang={lang}
          onChange={(filterId) => {
            setActiveFilter(filterId);
            setSelectedCard(null);
          }}
        />
      </div>

      {expertsLoading && visibleCards.length === 0 ? (
        <div className="flex min-h-[240px] items-center justify-center rounded-md bg-white">
          <Loader2 className="h-5 w-5 animate-spin text-black/35" />
          <span className="ml-2 text-sm text-black/45">{t("正在加载技能包")}</span>
        </div>
      ) : expertsError ? (
        <div className="rounded-md border border-red-500/15 bg-white p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-black/90">{t("技能包加载失败")}</h2>
              <p className="mt-1 text-sm leading-6 text-black/50">{getSkillHubErrorMessage(expertsError, t)}</p>
              <button
                type="button"
                onClick={reloadExperts}
                className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-black px-3 text-sm font-medium text-white transition-colors hover:bg-black/85"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("重试")}
              </button>
            </div>
          </div>
        </div>
      ) : visibleCards.length > 0 ? (
        view === "grid" ? (
          <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-2" data-testid="skill-package-card-view">
            {visibleCards.map((card) => (
              <ExpertGridCard
                key={card.pkg.slug}
                card={card}
                activeFilter={activeFilter}
                lang={lang}
                installingSlug={installingSlug}
                installProgress={installProgress}
                isInstalled={isPackageInstalled(card.pkg)}
                onOpen={handleOpenDetail}
                onInstall={handleInstall}
              />
            ))}
          </div>
        ) : (
          <div
            className="overflow-hidden rounded-md border border-black/[0.06] bg-white"
            data-testid="skill-package-list-view"
          >
            {visibleCards.map((card, index) => (
              <div key={card.pkg.slug}>
                {index > 0 ? <div className="mx-4 h-px bg-black/[0.06]" /> : null}
                <ExpertListItem
                  card={card}
                  activeFilter={activeFilter}
                  lang={lang}
                  installingSlug={installingSlug}
                  installProgress={installProgress}
                  isInstalled={isPackageInstalled(card.pkg)}
                  onOpen={handleOpenDetail}
                  onInstall={handleInstall}
                />
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="rounded-md bg-white px-5 py-10 text-center text-sm text-black/40">
          {t("没有找到匹配的技能包")}
        </div>
      )}

    </div>
  );
}

function ExpertSearchBox({
  value,
  onChange,
  onCommit,
  lang,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  lang?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const placeholder = lang === "es"
    ? "Buscar paquetes de Skills"
    : lang === "en"
      ? "Search skill packages"
      : "搜索技能包";

  return (
    <div className="lv-agent-search-box">
      <Search className="lv-agent-search-box-icon" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={(event) => onCommit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit(event.currentTarget.value);
            inputRef.current?.blur();
          }
        }}
        placeholder={placeholder}
        className="lv-skills-search-input lv-agent-search-box-input"
      />
    </div>
  );
}

function ExpertViewToggle({
  value,
  onChange,
  lang,
}: {
  value: ExpertView;
  onChange: (value: ExpertView) => void;
  lang?: ExpertLanguage;
}) {
  const viewLabelsEs: Record<ExpertView, string> = {
    list: "Lista",
    grid: "Tarjetas",
  };
  return (
    <div className="flex w-max items-center gap-1 rounded-md bg-black/[0.04] p-0.5">
      {EXPERT_VIEW_OPTIONS.map((item) => {
        const Icon = item.icon;
        const active = value === item.value;
        const label = lang === "es"
          ? viewLabelsEs[item.value]
          : lang === "en"
            ? (item.value === "list" ? "List" : "Cards")
            : item.label;
        const tooltipId = `skill-package-view-${item.value}-tooltip`;
        return (
          <span key={item.value} className="group relative inline-flex">
            <button
              type="button"
              onClick={() => onChange(item.value)}
              aria-label={label}
              aria-describedby={tooltipId}
              aria-pressed={active}
              className={cn(
                "peer lv-agent-view-toggle-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/40",
                active ? "bg-white text-black/85 shadow-[0_1px_4px_rgba(0,0,0,0.08)]" : "text-black/45 hover:text-black/70",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
            <span
              id={tooltipId}
              role="tooltip"
              className="pointer-events-auto absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 select-text whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-hover:opacity-100 peer-focus-visible:opacity-100"
            >
              {label}
              <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white" />
            </span>
          </span>
        );
      })}
    </div>
  );
}

function ExpertSceneFilters({
  activeFilter,
  onChange,
  lang,
}: {
  activeFilter: ExpertFilterId;
  onChange: (filterId: ExpertFilterId) => void;
  lang?: string;
}) {
  const t = useT();
  const filters: Array<{ value: ExpertFilterId; label: string; icon: ElementType }> = [
    { value: "all", label: t("全部"), icon: PackageOpen },
    ...EXPERT_FILTER_SCENES.map((filter) => ({
      ...filter,
      label: lang === "ja"
        ? filter.labelJa
        : lang === "es"
          ? filter.labelEs
          : lang === "en" ? filter.labelEn : filter.label,
    })),
  ];

  return (
    <div className="-mx-0.5 flex min-w-0 flex-wrap gap-1.5 overflow-visible px-0.5 pb-1">
      {filters.map((filter) => {
        const Icon = filter.icon;
        const active = activeFilter === filter.value;
        return (
          <button
            key={filter.value}
            type="button"
            onClick={() => onChange(filter.value)}
            style={{ fontSize: 13, lineHeight: "18px" }}
            className={cn(
              "inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium transition-colors",
              active
                ? "border-black/32 bg-black/[0.055] text-black/90 shadow-[0_2px_8px_rgba(15,23,42,0.07)]"
                : "border-black/8 bg-white text-black/60 hover:border-black/18 hover:text-black/82",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {filter.label}
          </button>
        );
      })}
    </div>
  );
}

function getExpertProfileImage(slug: string): string {
  return `${AI_BUDDY_ASSET_BASE}/expert-profiles/${slug}.${AI_BUDDY_EXPERT_PROFILE_VERSION}.${AI_BUDDY_EXPERT_PROFILE_EXT}`;
}

function pickDefaultExpertProfileIndex(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }

  return Math.abs(hash) % 2;
}

function getDefaultExpertProfileImage(seed: string): string {
  const gender = pickDefaultExpertProfileIndex(seed) === 0 ? "male" : "female";
  return `${AI_BUDDY_ASSET_BASE}/expert-profiles/default-${gender}.${AI_BUDDY_EXPERT_PROFILE_VERSION}.${AI_BUDDY_EXPERT_PROFILE_EXT}`;
}

function getExpertInitial(displayName: string): string {
  return Array.from(displayName.trim())[0]?.toUpperCase() ?? "E";
}

function SkillPackageProfileIcon({
  pkg,
  displayName,
  className,
}: {
  pkg: SkillHubSkillSet;
  displayName: string;
  className?: string;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [assetFailed, setAssetFailed] = useState(false);
  const [defaultFailed, setDefaultFailed] = useState(false);
  const avatarSrc = pkg.avatarUrl?.trim();
  const assetSrc = getExpertProfileImage(pkg.slug);
  const defaultSrc = getDefaultExpertProfileImage(pkg.slug || displayName);
  const imageSrc = avatarSrc && !avatarFailed
    ? avatarSrc
    : !assetFailed
      ? assetSrc
      : defaultFailed
        ? null
        : defaultSrc;

  useEffect(() => {
    setAvatarFailed(false);
    setAssetFailed(false);
    setDefaultFailed(false);
  }, [avatarSrc, displayName, pkg.slug]);

  return (
    <div
      className={cn(
        "relative flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-black/[0.04] text-sm font-semibold text-black/56",
        className,
      )}
      data-testid="skill-package-profile-icon"
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          className="h-full w-full object-cover"
          data-testid="skill-package-profile-image"
          onError={() => {
            if (imageSrc === avatarSrc) {
              setAvatarFailed(true);
            } else if (imageSrc === assetSrc) {
              setAssetFailed(true);
            } else {
              setDefaultFailed(true);
            }
          }}
        />
      ) : (
        <span data-testid="skill-package-profile-fallback">{getExpertInitial(displayName)}</span>
      )}
      <span className="sr-only">{displayName}</span>
    </div>
  );
}

function InstallButton({
  pkg,
  installingSlug,
  installProgress,
  isInstalled,
  onInstall,
  className,
}: {
  pkg: SkillHubSkillSet;
  installingSlug: string | null;
  installProgress: SkillInstallProgress | null;
  isInstalled: boolean;
  onInstall: (pkg: SkillHubSkillSet) => void;
  className?: string;
}) {
  const t = useT();
  const isInstalling = installingSlug === pkg.slug;
  const label = isInstalling && installProgress?.total
    ? t("安装中 {{current}}/{{total}}", {
        current: installProgress.current,
        total: installProgress.total,
      })
    : isInstalling
      ? t("安装中...")
      : isInstalled
        ? t("已安装")
        : t("安装");
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void onInstall(pkg);
      }}
      disabled={Boolean(installingSlug) || isInstalled}
      className={cn(
        "inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-semibold leading-none transition-colors",
        isInstalled
          ? "bg-[#F4FCF9] text-[#82BDAE]"
          : "bg-black text-white hover:bg-black/85 active:bg-black/95",
        isInstalled ? "cursor-not-allowed" : "",
        installingSlug && !isInstalling ? "cursor-not-allowed opacity-55" : "",
        className,
      )}
    >
      {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {label}
    </button>
  );
}

function ExpertListItem({
  card,
  activeFilter,
  lang,
  installingSlug,
  installProgress,
  isInstalled,
  onOpen,
  onInstall,
}: {
  card: ExpertPackageCard;
  activeFilter: ExpertFilterId;
  lang?: ExpertLanguage;
  installingSlug: string | null;
  installProgress: SkillInstallProgress | null;
  isInstalled: boolean;
  onOpen: (card: ExpertPackageCard) => void;
  onInstall: (pkg: SkillHubSkillSet) => void;
}) {
  const t = useT();
  const role = getExpertRole(card.pkg, activeFilter, t, lang);
  const summary = getPackageSummary(card.pkg, t, lang);

  return (
    <article
      className="group flex items-stretch gap-3 px-4 py-4 transition-colors hover:bg-black/[0.018]"
    >
      <button
        type="button"
        onClick={() => onOpen(card)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/35"
      >
        <SkillPackageProfileIcon
          pkg={card.pkg}
          displayName={getLocalizedPackageDisplayName(card.pkg, lang)}
          className="h-10 w-10 rounded-[9px]"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-5 text-black/90">
            {getLocalizedPackageDisplayName(card.pkg, lang)}
          </span>
          <span className="mt-0.5 block truncate text-[11px] font-medium leading-4 text-black/48">{role}</span>
          <span className="mt-1 line-clamp-2 text-xs leading-5 text-black/50" title={summary}>{summary}</span>
        </span>
      </button>
      <InstallButton
        pkg={card.pkg}
        installingSlug={installingSlug}
        installProgress={installProgress}
        isInstalled={isInstalled}
        onInstall={onInstall}
        className="h-9 shrink-0 self-center px-3"
      />
    </article>
  );
}

function ExpertGridCard({
  card,
  activeFilter,
  lang,
  installingSlug,
  installProgress,
  isInstalled,
  onOpen,
  onInstall,
}: {
  card: ExpertPackageCard;
  activeFilter: ExpertFilterId;
  lang?: ExpertLanguage;
  installingSlug: string | null;
  installProgress: SkillInstallProgress | null;
  isInstalled: boolean;
  onOpen: (card: ExpertPackageCard) => void;
  onInstall: (pkg: SkillHubSkillSet) => void;
}) {
  const t = useT();
  const role = getExpertRole(card.pkg, activeFilter, t, lang);
  const summary = getPackageSummary(card.pkg, t, lang);

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(card);
        }
      }}
      className="group flex cursor-pointer items-start gap-3 rounded-md border border-black/[0.06] bg-white px-3.5 py-3 text-left transition-colors hover:border-black/[0.12] hover:bg-black/[0.025] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/40"
    >
      <SkillPackageProfileIcon
        pkg={card.pkg}
        displayName={getLocalizedPackageDisplayName(card.pkg, lang)}
        className="h-9 w-9 rounded-[8px]"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-black/90">{getLocalizedPackageDisplayName(card.pkg, lang)}</h3>
        <p className="mt-1 line-clamp-2 text-xs leading-4 text-black/45" title={summary}>{summary}</p>
        <div className="mt-1 truncate text-[11px] text-black/50">{role}</div>
      </div>
      <div className="relative shrink-0 self-center">
        <InstallButton
          pkg={card.pkg}
          installingSlug={installingSlug}
          installProgress={installProgress}
          isInstalled={isInstalled}
          onInstall={onInstall}
          className="h-9 px-3"
        />
      </div>
    </article>
  );
}

function SkillPackageDetailView({
  card,
  activeFilter,
  installingSlug,
  installProgress,
  isInstalled,
  onBack,
  onInstall,
  lang,
}: {
  card: ExpertPackageCard;
  activeFilter: ExpertFilterId;
  installingSlug: string | null;
  installProgress: SkillInstallProgress | null;
  isInstalled: boolean;
  onBack: () => void;
  onInstall: (pkg: SkillHubSkillSet) => void;
  lang?: ExpertLanguage;
}) {
  const t = useT();
  const detailFetcher = useCallback(
    () => usesEnglishExpertContent(lang)
      ? fetchSkillSetDetail(card.pkg.slug, { lang: "en" })
      : fetchSkillSetDetail(card.pkg.slug),
    [card.pkg.slug, lang],
  );
  const { data, loading, error } = useAsyncResource(detailFetcher, [card.pkg.slug]);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const detail = data ?? card.pkg;
  const role = getExpertRole(detail, activeFilter, t, lang);
  const candidateSkillSlugs = getPackageSkillSlugs(
    card.pkg.slug,
    data?.skillSlugs ?? card.pkg.skillSlugs ?? [],
    data?.missing ?? card.pkg.missing ?? [],
  );
  const candidateSkillSlugsKey = candidateSkillSlugs.join("\u0000");
  const availableSkillSlugsFetcher = useCallback(
    () => resolveAvailablePackageSkillSlugs(card.pkg.slug, candidateSkillSlugs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [card.pkg.slug, candidateSkillSlugsKey],
  );
  const availableSkillSlugs = useAsyncResource(availableSkillSlugsFetcher, [card.pkg.slug, candidateSkillSlugsKey]);
  const skillSlugs = availableSkillSlugs.data ?? [];
  const skillSlugsKey = skillSlugs.join("\u0000");
  const skillDisplayNamesFetcher = useCallback(
    () => fetchSkillDisplayNames(skillSlugs, lang),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, skillSlugsKey],
  );
  const skillDisplayNames = useAsyncResource(skillDisplayNamesFetcher, [skillSlugsKey]);
  const activeSkillSlug = skillSlugs[activeSkillIndex] ?? skillSlugs[0];

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [card.pkg.slug]);

  useEffect(() => {
    if (skillSlugs.length > 0 && activeSkillIndex >= skillSlugs.length) setActiveSkillIndex(0);
  }, [activeSkillIndex, skillSlugs.length]);

  return (
    <div className="space-y-10">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-8 items-center gap-2 text-sm font-semibold leading-8 text-black/42 transition-colors hover:text-black/78"
      >
        <ArrowLeft className="h-4 w-4" />
        <span>{t("技能包")} / {getLocalizedPackageDisplayName(detail, lang)}</span>
      </button>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-5">
          <SkillPackageProfileIcon
            pkg={detail}
            displayName={getLocalizedPackageDisplayName(detail, lang)}
            className="h-16 w-16 rounded-[14px]"
          />
          <div className="min-w-0">
            <h2 className="text-[28px] font-semibold leading-tight text-black/95">{getLocalizedPackageDisplayName(detail, lang)}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-7 gap-y-1 text-sm font-medium leading-6 text-black/48">
              <span>{role}</span>
              {skillSlugs.length > 0 ? (
                <span className="inline-flex flex-shrink-0 items-center gap-1.5 text-xs font-light text-black/52">
                  <PackageOpen className="h-3.5 w-3.5" />
                  {t("{{count}} 个技能", { count: skillSlugs.length })}
                </span>
              ) : null}
              <a
                href={SKILLHUB_PACKAGE_SOURCE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex flex-shrink-0 items-center gap-[3px] text-[13px] font-normal text-[#2563EB] underline-offset-2 transition-colors hover:text-[#1D4ED8] hover:underline"
              >
                {t("源自 SkillHub")}
                <span aria-hidden="true">↗</span>
              </a>
            </div>
            <p className="mt-5 max-w-5xl text-sm leading-7 text-black/62">
              {getPackageSummary(detail as SkillHubSkillSet, t, lang)}
            </p>
          </div>
        </div>
        <InstallButton
          pkg={card.pkg}
          installingSlug={installingSlug}
          installProgress={installProgress}
          isInstalled={isInstalled}
          onInstall={onInstall}
          className="h-9 flex-shrink-0 px-4"
        />
      </div>

      <div>
        {loading && !data ? (
          <div className="flex min-h-40 items-center justify-center text-sm text-black/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("正在加载技能包详情...")}
          </div>
        ) : error ? (
          <div className="rounded-md border border-red-500/15 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">
            {getSkillHubErrorMessage(error, t)}
          </div>
        ) : availableSkillSlugs.loading && candidateSkillSlugs.length > 0 ? (
          <div className="flex min-h-40 items-center justify-center text-sm text-black/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("正在加载技能包详情...")}
          </div>
        ) : skillSlugs.length > 0 ? (
          <div className="space-y-8">
            <div className="inline-flex max-w-full items-center overflow-x-auto rounded-[4px] bg-[#EEEEEE] p-[3px]">
              {skillSlugs.map((skillSlug, index) => {
                const skillDisplayName = skillDisplayNames.data?.get(skillSlug) ?? formatSkillDisplayName(skillSlug);
                return (
                  <button
                    key={skillSlug}
                    type="button"
                    onClick={() => setActiveSkillIndex(index)}
                    className={cn(
                      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[8px] px-4 py-2 text-sm transition-all",
                      index === activeSkillIndex
                        ? "bg-white font-semibold text-black/90 shadow-[0_1px_4px_rgba(0,0,0,0.05)]"
                        : "bg-transparent font-medium text-black/62 hover:text-black/88",
                    )}
                  >
                    <Puzzle className="h-4 w-4" />
                    <span className="max-w-40 overflow-hidden text-ellipsis" title={skillDisplayName}>
                      {skillDisplayName}
                    </span>
                  </button>
                );
              })}
            </div>

            {activeSkillSlug ? <SkillContent slug={activeSkillSlug} lang={lang} /> : null}
          </div>
        ) : (
          <p className="py-8 text-sm text-black/40">{t("暂无技能模块。")}</p>
        )}
      </div>
    </div>
  );
}

function SkillContent({ slug, lang }: { slug: string; lang?: ExpertLanguage }) {
  const t = useT();
  const fetcher = useCallback(() => fetchSkillMarkdown(slug, lang), [lang, slug]);
  const { data, loading, error } = useAsyncResource(fetcher, [lang, slug]);

  if (loading && !data) {
    return (
      <div className="space-y-4 py-4">
        <div className="h-5 w-40 animate-pulse rounded bg-black/8" />
        <div className="h-4 w-full animate-pulse rounded bg-black/5" />
        <div className="h-4 w-4/5 animate-pulse rounded bg-black/5" />
      </div>
    );
  }

  if (error || !data) {
    return <p className="py-8 text-sm text-black/40">{error || t("暂无内容")}</p>;
  }

  return <SkillPackageMarkdown content={data} />;
}

function SkillPackageMarkdown({ content }: { content: string }) {
  const components: Components = {
    h1({ children }) {
      return <h3 className="mt-6 text-lg font-semibold leading-7 text-black/88 first:mt-0">{children}</h3>;
    },
    h2({ children }) {
      return <h3 className="mt-6 text-base font-semibold leading-7 text-black/82 first:mt-0">{children}</h3>;
    },
    h3({ children }) {
      return <h4 className="mt-5 text-sm font-semibold leading-6 text-black/78 first:mt-0">{children}</h4>;
    },
    p({ children }) {
      return <p className="my-3 text-sm leading-7 text-black/60">{children}</p>;
    },
    ul({ children }) {
      return <ul className="my-3 list-disc space-y-1.5 pl-5 text-sm leading-7 text-black/60">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="my-3 list-decimal space-y-1.5 pl-5 text-sm leading-7 text-black/60">{children}</ol>;
    },
    li({ children }) {
      return <li className="pl-1">{children}</li>;
    },
    strong({ children }) {
      return <strong className="font-semibold text-black/78">{children}</strong>;
    },
    code({ className, children }) {
      if (className) {
        return (
          <code className="block overflow-x-auto rounded-[4px] bg-black/[0.04] px-3 py-2 font-mono text-xs leading-6 text-black/62">
            {children}
          </code>
        );
      }
      return (
        <code className="rounded-[3px] bg-black/[0.05] px-1 py-0.5 font-mono text-xs text-black/62">
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <pre className="my-4 overflow-x-auto rounded-[4px] bg-black/[0.04] p-0">{children}</pre>;
    },
    table({ children }) {
      return (
        <div className="my-4 overflow-x-auto rounded-md border border-black/8">
          <table className="min-w-full border-collapse text-sm text-black/62">{children}</table>
        </div>
      );
    },
    th({ children }) {
      return <th className="border-b border-black/8 bg-black/[0.025] px-3 py-2 text-left font-semibold text-black/72">{children}</th>;
    },
    td({ children }) {
      return <td className="border-t border-black/6 px-3 py-2 align-top">{children}</td>;
    },
  };

  return (
    <div>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
