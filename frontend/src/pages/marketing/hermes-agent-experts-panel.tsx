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

import { useT } from "@/i18n/t";
import { loadExpertPackagesState, saveExpertPackagesState } from "@/lib/expert-package-storage";
import { shellQuote } from "@/lib/hermes-cron-client";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAsyncResource } from "@/services/use-async-resource";
import {
  fetchSkillFile,
  fetchSkillDetail,
  fetchSkillFiles,
  fetchSkillSetDetail,
  fetchSkillSets,
  type SkillHubKnownSkillSetScene,
  type SkillHubSkillSet,
} from "@/lib/skillhub-api";

type ExpertFilterId = "all" | SkillHubKnownSkillSetScene;

interface ExpertSceneOption {
  value: SkillHubKnownSkillSetScene;
  label: string;
  labelEn: string;
  icon: ElementType;
}

export interface ExecDebugCommandResult {
  status: string;
  exitCode: number;
  output: string;
  stdout?: string;
  stderr?: string;
}

export type ExpertsExecDebugCommand = (botId: string, command: string) => Promise<ExecDebugCommandResult>;

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
  { value: "finance", label: "金融", labelEn: "Finance", icon: Landmark },
  { value: "tech", label: "科技", labelEn: "Technology", icon: Cpu },
  { value: "design", label: "设计", labelEn: "Design", icon: Palette },
  { value: "marketing", label: "营销", labelEn: "Marketing", icon: Megaphone },
  { value: "legal", label: "法律", labelEn: "Legal", icon: Scale },
  { value: "academic", label: "学术", labelEn: "Academic", icon: GraduationCap },
  { value: "education", label: "教育", labelEn: "Education", icon: BookOpen },
  { value: "hr", label: "人力", labelEn: "Human Resources", icon: Users },
  { value: "ecommerce", label: "电商", labelEn: "Ecommerce", icon: ShoppingCart },
  { value: "media", label: "媒体", labelEn: "Media", icon: Clapperboard },
  { value: "healthcare", label: "医疗", labelEn: "Healthcare", icon: HeartPulse },
  { value: "mysticism", label: "玄学", labelEn: "Mysticism", icon: MoonStar },
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
const AI_BUDDY_ASSET_BASE = "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple";
const AI_BUDDY_EXPERT_PROFILE_VERSION = "v20260625";
const AI_BUDDY_EXPERT_PROFILE_EXT = "avif";
const HERMES_SKILLS_LIST_COMMAND = 'cd "$HOME/.hermes/hermes-agent" && COLUMNS=10000 ./venv/bin/python -m hermes_cli.main skills list';
const SKILLHUB_SELF_UPGRADE_COMMAND = "skillhub self-upgrade";
const SKILLHUB_DOWNLOAD_URL_TEMPLATE = "https://api.skillhub.cn/api/v1/download?slug={slug}";
const SKILLHUB_PACKAGE_SOURCE_URL = "https://skillhub.cn/skillspackage";
const INSTALLED_PACKAGES_STORAGE_PREFIX = "lightvela-experts-installed-packages";
const LEGACY_SKILL_DOC_NAMES = ["skill.md", "readme.md", "skills.md"];
const EXPERT_LANGUAGE_DOC_NAMES = {
  en: ["identify_en.md", ...LEGACY_SKILL_DOC_NAMES],
  zh: ["identify.md", ...LEGACY_SKILL_DOC_NAMES],
} as const;
type ExpertLanguage = "en" | "zh";
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

export function getUniqueSkillSlugs(skillSlugs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of skillSlugs) {
    const normalized = slug.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

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
  const subSceneRoles = lang === "en" ? EXPERT_PACKAGE_SUB_SCENE_ROLES_EN : EXPERT_PACKAGE_SUB_SCENE_ROLES;
  const sceneRoles = lang === "en" ? EXPERT_PACKAGE_SCENE_ROLES_EN : EXPERT_PACKAGE_SCENE_ROLES;
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

  const match = lines[lineIndex].match(keyPattern);
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
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function getLocalizedPackageDisplayName(pkg: SkillHubSkillSet, lang?: ExpertLanguage): string {
  if (lang !== "en") return pkg.displayName;
  return pkg.displayNameEn?.trim()
    || getEnglishPackageFrontmatterValue(pkg.contentEn, "display_name")
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
  if (lang === "en") {
    return getEnglishPackageSummary(pkg)
      || `A curated skill package for ${getLocalizedPackageDisplayName(pkg, "en")}.`;
  }
  return pkg.summary || pkg.summaryEn || pkg.remark || t("精选技能包组合，适合直接接入完整工作流。");
}

export function buildInstallSkillCommand(skillSlug: string): string {
  return `env SKILLHUB_PRIMARY_DOWNLOAD_URL_TEMPLATE=${shellQuote(SKILLHUB_DOWNLOAD_URL_TEMPLATE)} acli skills install ${shellQuote(skillSlug)}`;
}

export function buildInstalledSkillsListCommand(): string {
  return HERMES_SKILLS_LIST_COMMAND;
}

export function buildSkillHubSelfUpgradeCommand(): string {
  return SKILLHUB_SELF_UPGRADE_COMMAND;
}

export function stripMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").trim();
}

export function getExpertSkillDocumentPath(filePaths: string[], lang?: ExpertLanguage): string | null {
  const targetNames = lang === "en"
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
    throw new Error(lang === "en" ? "未找到 identify_en.md 或兼容技能文档" : "未找到 identify.md 或兼容技能文档");
  }
  return stripMarkdownFrontmatter(await fetchSkillFile(skillSlug, docPath));
}

async function fetchSkillDisplayNames(
  skillSlugs: string[],
  lang?: ExpertLanguage,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    skillSlugs.map(async (skillSlug) => {
      try {
        const skill = await fetchSkillDetail(skillSlug, lang === "en" ? { lang } : undefined);
        const displayName = lang === "en" ? skill.displayNameEn || skill.displayName : skill.displayName;
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

function readInstalledSkillSlug(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  const name = value.name;
  const slug = value.slug;
  if (typeof name === "string" && name.trim()) return name.trim();
  if (typeof slug === "string" && slug.trim()) return slug.trim();
  return "";
}

function parseInstalledSkillsTable(output: string): string[] {
  const slugs: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("│")) continue;
    const cells = line
      .split("│")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 1 || cells[0] === "Name") continue;
    if (cells[0]) slugs.push(cells[0]);
  }
  return slugs;
}

export function parseInstalledSkillSlugs(output: string): string[] {
  if (!output.trim()) return [];

  try {
    const parsed = JSON.parse(output) as unknown;
    const payload = isRecord(parsed) && parsed.success === true && isRecord(parsed.data) ? parsed.data : parsed;
    const items = isRecord(payload) && Array.isArray(payload.skills)
      ? payload.skills
      : Array.isArray(payload)
        ? payload
        : [];
    if (items.length > 0) {
      return getUniqueSkillSlugs(items.map(readInstalledSkillSlug));
    }
  } catch {
    /* Non-JSON output falls through to table/plain text parsing. */
  }

  const tableSlugs = parseInstalledSkillsTable(output);
  if (tableSlugs.length > 0) {
    return getUniqueSkillSlugs(tableSlugs);
  }

  return getUniqueSkillSlugs(output.split("\n").map((line) => line.trim()));
}

async function executeInstallSkillCommand(
  botId: string,
  skillSlug: string,
  execDebugCommand: ExpertsExecDebugCommand,
): Promise<{ succeeded: boolean; output: string }> {
  try {
    const result = await execDebugCommand(botId, buildInstallSkillCommand(skillSlug));
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

export async function installSkillSlugs(
  botId: string,
  skillSlugs: string[],
  execDebugCommand: ExpertsExecDebugCommand,
  onProgress?: (progress: SkillInstallProgress) => void,
): Promise<SkillInstallResult> {
  const succeeded: string[] = [];
  const failed: SkillInstallFailure[] = [];
  let hasTriedSkillHubUpgrade = false;

  for (const [index, skillSlug] of skillSlugs.entries()) {
    onProgress?.({ current: index + 1, total: skillSlugs.length });
    let result = await executeInstallSkillCommand(botId, skillSlug, execDebugCommand);
    if (!result.succeeded && !hasTriedSkillHubUpgrade && shouldUpgradeSkillHubCli(result.output)) {
      hasTriedSkillHubUpgrade = true;
      await execDebugCommand(botId, buildSkillHubSelfUpgradeCommand()).catch(() => null);
      result = await executeInstallSkillCommand(botId, skillSlug, execDebugCommand);
    }
    if (!result.succeeded) {
      result = await retryFailedSkillInstall(botId, skillSlug, execDebugCommand, result);
    }

    if (result.succeeded) {
      succeeded.push(skillSlug);
    } else {
      failed.push({ slug: skillSlug, output: result.output });
    }
  }

  return { succeeded, failed };
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
  const expertLanguage = lang === "en" || lang === "zh" ? lang : undefined;
  const apiLanguage = expertLanguage === "en" ? "en" : undefined;
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

  return [...visiblePackages, ...fetchedMissingPackages.filter((pkg): pkg is SkillHubSkillSet => Boolean(pkg))]
    .sort((left, right) => (INTERNATIONAL_EXPERT_PACKAGE_ORDER.get(left.slug) ?? Number.MAX_SAFE_INTEGER)
      - (INTERNATIONAL_EXPERT_PACKAGE_ORDER.get(right.slug) ?? Number.MAX_SAFE_INTEGER));
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
  page: number;
  lang?: string;
}): Promise<{ packages: SkillHubSkillSet[]; total: number }> {
  const packages = await fetchAllExpertPackages(params.keyword, params.lang);
  return {
    packages,
    total: packages.length,
  };
}

export function ExpertsPanel({
  botId,
  execDebugCommand,
  lang,
}: {
  botId: string;
  execDebugCommand: ExpertsExecDebugCommand;
  lang?: ExpertLanguage;
}) {
  const t = useT();
  const [activeFilter, setActiveFilter] = useState<ExpertFilterId>("all");
  const [keyword, setKeyword] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<SkillInstallProgress | null>(null);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(() => readStoredInstalledPackageSlugs(botId));
  const installedSlugsRef = useRef(installedSlugs);
  const [installedSkillSlugs, setInstalledSkillSlugs] = useState<Set<string>>(() => new Set());
  const [packageSkillSlugs, setPackageSkillSlugs] = useState<Map<string, string[]>>(() => new Map());
  const [selectedCard, setSelectedCard] = useState<ExpertPackageCard | null>(null);
  const [expertPackages, setExpertPackages] = useState<SkillHubSkillSet[]>([]);
  const [expertTotal, setExpertTotal] = useState(0);
  const [expertPage, setExpertPage] = useState(1);
  const [expertsLoading, setExpertsLoading] = useState(true);
  const [expertsLoadingMore, setExpertsLoadingMore] = useState(false);
  const [expertsError, setExpertsError] = useState<Error | null>(null);
  const [expertsRetryNonce, setExpertsRetryNonce] = useState(0);
  const expertsRequestIdRef = useRef(0);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  const filteredExpertPackages = useMemo(() => {
    return filterExpertPackagesByScene(expertPackages, activeFilter);
  }, [activeFilter, expertPackages]);

  const visibleCards = useMemo<ExpertPackageCard[]>(() => {
    return filteredExpertPackages.map((pkg) => ({ pkg }));
  }, [filteredExpertPackages]);

  const hasMoreExperts = expertPackages.length < expertTotal;

  useEffect(() => {
    installedSlugsRef.current = installedSlugs;
  }, [installedSlugs]);

  const commitSearch = useCallback((value: string) => {
    const nextKeyword = value.trim();
    setSearchDraft(nextKeyword);
    setKeyword(nextKeyword);
    setExpertPage(1);
    setSelectedCard(null);
  }, []);

  const reloadExperts = useCallback(() => {
    setExpertPage(1);
    setExpertPackages([]);
    setExpertsRetryNonce((current) => current + 1);
  }, []);

  const loadMoreExperts = useCallback(() => {
    if (expertsLoading || expertsLoadingMore || !hasMoreExperts) return;
    setExpertPage((current) => current + 1);
  }, [expertsLoading, expertsLoadingMore, hasMoreExperts]);

  useEffect(() => {
    if (!hasMoreExperts || expertsLoading || expertsLoadingMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          loadMoreExperts();
        }
      },
      { rootMargin: "240px 0px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [expertsLoading, expertsLoadingMore, hasMoreExperts, loadMoreExperts]);

  useEffect(() => {
    const currentRequestId = ++expertsRequestIdRef.current;
    const firstPage = expertPage === 1;

    if (firstPage) {
      setExpertsLoading(true);
      setExpertPackages([]);
      setExpertTotal(0);
    } else {
      setExpertsLoadingMore(true);
    }
    setExpertsError(null);

    fetchExperts({ keyword, page: expertPage, lang })
      .then((result) => {
        if (currentRequestId !== expertsRequestIdRef.current) return;
        setExpertTotal(result.total);
        setExpertPackages((current) => firstPage ? result.packages : [...current, ...result.packages]);
      })
      .catch((error) => {
        if (currentRequestId !== expertsRequestIdRef.current) return;
        setExpertsError(error instanceof Error ? error : new Error(String(error)));
        if (firstPage) {
          setExpertPackages([]);
          setExpertTotal(0);
        }
      })
      .finally(() => {
        if (currentRequestId !== expertsRequestIdRef.current) return;
        setExpertsLoading(false);
        setExpertsLoadingMore(false);
      });
  }, [expertPage, expertsRetryNonce, keyword, lang]);

  useEffect(() => {
    let cancelled = false;
    const cachedPackageSlugs = readStoredInstalledPackageSlugs(botId);
    installedSlugsRef.current = cachedPackageSlugs;
    setInstalledSlugs(cachedPackageSlugs);
    setInstalledSkillSlugs(new Set());

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
        const result = await execDebugCommand(botId, buildInstalledSkillsListCommand());
        if (!cancelled) {
          setInstalledSkillSlugs(isExecSucceeded(result) ? new Set(parseInstalledSkillSlugs(result.output)) : new Set());
        }
      } catch {
        if (!cancelled) {
          setInstalledSkillSlugs(new Set());
        }
      }
    }

    void refreshInstalledPackages();
    void refreshInstalledSkills();
    return () => {
      cancelled = true;
    };
  }, [botId, execDebugCommand]);

  useEffect(() => {
    if (visibleCards.length === 0) return;

    const missingCards = visibleCards.filter(({ pkg }) => {
      return !packageSkillSlugs.has(pkg.slug) && !Array.isArray(pkg.skillSlugs);
    });
    if (missingCards.length === 0) return;

    let cancelled = false;

    async function fetchVisiblePackageDetails() {
      await Promise.all(missingCards.map(async ({ pkg }) => {
        try {
          const detail = lang === "en"
            ? await fetchSkillSetDetail(pkg.slug, { lang })
            : await fetchSkillSetDetail(pkg.slug);
          const skillSlugs = await resolveAvailablePackageSkillSlugs(
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
  }, [lang, packageSkillSlugs, visibleCards]);

  const getKnownSkillSlugs = useCallback((pkg: SkillHubSkillSet) => {
    return getPackageSkillSlugs(pkg.slug, packageSkillSlugs.get(pkg.slug) ?? pkg.skillSlugs ?? [], pkg.missing ?? []);
  }, [packageSkillSlugs]);

  const isPackageInstalled = useCallback((pkg: SkillHubSkillSet) => {
    const knownSkillSlugs = getKnownSkillSlugs(pkg);
    const hasInstalledSkillPackage = knownSkillSlugs.length > 0
      && knownSkillSlugs.every((skillSlug) => installedSkillSlugs.has(skillSlug));
    return installedSlugs.has(pkg.slug) || hasInstalledSkillPackage;
  }, [getKnownSkillSlugs, installedSkillSlugs, installedSlugs]);

  const handleInstall = useCallback(async (pkg: SkillHubSkillSet) => {
    if (installingSlug) return;
    setInstallingSlug(pkg.slug);
    try {
      const detail = lang === "en"
        ? await fetchSkillSetDetail(pkg.slug, { lang })
        : await fetchSkillSetDetail(pkg.slug);
      const skillSlugs = await resolveAvailablePackageSkillSlugs(pkg.slug, detail.skillSlugs ?? [], detail.missing ?? []);
      if (skillSlugs.length === 0) {
        toast.error(t("该技能包暂未包含可安装的 skills"));
        return;
      }

      const installResult = await installSkillSlugs(botId, skillSlugs, execDebugCommand, setInstallProgress);
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
  }, [botId, execDebugCommand, installingSlug, lang, t]);

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
        </div>

        <ExpertSceneFilters
          activeFilter={activeFilter}
          lang={lang}
          onChange={(filterId) => {
            setActiveFilter(filterId);
            setExpertPage(1);
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
        <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
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
        <div className="rounded-md bg-white px-5 py-10 text-center text-sm text-black/40">
          {t("没有找到匹配的技能包")}
        </div>
      )}

      {visibleCards.length > 0 && hasMoreExperts ? (
        <div className="flex min-h-8 justify-center pt-1">
          <div ref={loadMoreSentinelRef} className="flex h-8 items-center gap-2 text-xs text-black/32">
            {expertsLoadingMore ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("加载更多...")}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
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
        placeholder={lang === "en" ? "Search skill packages" : "搜索技能包"}
        className="lv-agent-search-box-input"
      />
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
      label: lang === "en" ? filter.labelEn : filter.label,
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
  return Array.from(displayName.trim())[0]?.toUpperCase() ?? "专";
}

function SkillPackageProfileIcon({ pkg, className }: { pkg: SkillHubSkillSet; className?: string }) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [assetFailed, setAssetFailed] = useState(false);
  const [defaultFailed, setDefaultFailed] = useState(false);
  const avatarSrc = pkg.avatarUrl?.trim();
  const assetSrc = getExpertProfileImage(pkg.slug);
  const defaultSrc = getDefaultExpertProfileImage(pkg.slug || pkg.displayName);
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
  }, [avatarSrc, pkg.displayName, pkg.slug]);

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
        <span data-testid="skill-package-profile-fallback">{getExpertInitial(pkg.displayName)}</span>
      )}
      <span className="sr-only">{pkg.displayName}</span>
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
    ? t("召唤中 {{current}}/{{total}}", {
        current: installProgress.current,
        total: installProgress.total,
      })
    : isInstalling
      ? t("召唤中...")
      : isInstalled
        ? t("已召唤")
        : t("召唤");
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
      <SkillPackageProfileIcon pkg={card.pkg} className="h-9 w-9 rounded-[8px]" />
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
    () => lang === "en"
      ? fetchSkillSetDetail(card.pkg.slug, { lang })
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
          <SkillPackageProfileIcon pkg={detail} className="h-16 w-16 rounded-[14px]" />
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
