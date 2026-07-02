import {
  ArrowLeft,
  AlertTriangle,
  BookOpen,
  Clapperboard,
  Check,
  Code2,
  GraduationCap,
  HeartPulse,
  Landmark,
  LayoutGrid,
  List,
  Loader2,
  Megaphone,
  PackageCheck,
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
type ExpertView = "list" | "grid";

interface ExpertSceneOption {
  value: SkillHubKnownSkillSetScene;
  label: string;
  role: string;
  icon: ElementType;
}

export interface ExecDebugCommandResult {
  status: string;
  exitCode: number;
  output: string;
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

const EXPERT_SCENES: ExpertSceneOption[] = [
  { value: "finance", label: "金融", role: "金融分析技能包", icon: Landmark },
  { value: "tech", label: "技术", role: "开发工程技能包", icon: Code2 },
  { value: "design", label: "设计", role: "产品设计技能包", icon: Palette },
  { value: "marketing", label: "营销", role: "营销增长技能包", icon: Megaphone },
  { value: "legal", label: "法律", role: "法律合规技能包", icon: Scale },
  { value: "academic", label: "学术", role: "学术研究技能包", icon: GraduationCap },
  { value: "education", label: "教育", role: "教育学习技能包", icon: BookOpen },
  { value: "hr", label: "人力", role: "组织人才技能包", icon: Users },
  { value: "ecommerce", label: "电商", role: "电商运营技能包", icon: ShoppingCart },
  { value: "media", label: "媒体", role: "内容创作技能包", icon: Clapperboard },
  { value: "healthcare", label: "医疗", role: "医疗健康技能包", icon: HeartPulse },
];

const EXPERT_SCENE_MAP = new Map(EXPERT_SCENES.map((scene) => [scene.value, scene] as const));
const EXPERT_VIEW_OPTIONS: Array<{ value: ExpertView; label: string; icon: ElementType }> = [
  { value: "list", label: "列表", icon: List },
  { value: "grid", label: "卡片", icon: LayoutGrid },
];

const EXPERT_PAGE_SIZE = 60;
const INSTALL_ERROR_OUTPUT_LINE_LIMIT = 3;
const SKILL_INSTALL_DEFAULT_RETRY_DELAYS_MS = [0] as const;
const SKILL_INSTALL_RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const AI_BUDDY_ASSET_BASE = "https://cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/source/ai-buddy-decouple";
const AI_BUDDY_ASSET_VERSION = "v20260616";
const HERMES_SKILLS_LIST_COMMAND = 'cd "$HOME/.hermes/hermes-agent" && COLUMNS=10000 ./venv/bin/python -m hermes_cli.main skills list';
const SKILLHUB_SELF_UPGRADE_COMMAND = "skillhub self-upgrade";
const SKILLHUB_DOWNLOAD_URL_TEMPLATE = "https://api.skillhub.cn/api/v1/download?slug={slug}";
const INSTALLED_PACKAGES_STORAGE_PREFIX = "lightvela-experts-installed-packages";
const TARGET_SKILL_DOC_NAMES = ["skill.md", "readme.md", "skills.md"];
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

function isKnownExpertScene(scene: string | undefined): scene is SkillHubKnownSkillSetScene {
  return !!scene && EXPERT_SCENE_MAP.has(scene as SkillHubKnownSkillSetScene);
}

function getPackageScene(
  pkg: Pick<SkillHubSkillSet, "scene">,
  fallback: ExpertFilterId,
): SkillHubKnownSkillSetScene | undefined {
  if (isKnownExpertScene(pkg.scene)) return pkg.scene;
  return fallback === "all" ? undefined : fallback;
}

function getExpertRole(scene: SkillHubKnownSkillSetScene | undefined, t: ReturnType<typeof useT>): string {
  return scene ? EXPERT_SCENE_MAP.get(scene)?.role ?? t("技能包") : t("技能包");
}

function getPackageSummary(pkg: SkillHubSkillSet, t: ReturnType<typeof useT>): string {
  return pkg.summary || pkg.remark || t("精选技能包组合，适合直接接入完整工作流。");
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

function findSkillDocPath(filePaths: string[]): string | null {
  for (const targetName of TARGET_SKILL_DOC_NAMES) {
    const matched = filePaths.find((path) => !path.includes("/") && path.toLowerCase() === targetName);
    if (matched) return matched;
  }
  return null;
}

async function fetchSkillMarkdown(skillSlug: string): Promise<string> {
  const files = await fetchSkillFiles(skillSlug);
  const docPath = findSkillDocPath(files.map((file) => file.path));
  if (!docPath) {
    throw new Error("未找到 SKILL.md 或 README.md 文件");
  }
  return stripMarkdownFrontmatter(await fetchSkillFile(skillSlug, docPath));
}

async function fetchSkillDisplayNames(skillSlugs: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    skillSlugs.map(async (skillSlug) => {
      try {
        const skill = await fetchSkillDetail(skillSlug);
        return [skillSlug, skill.displayName || formatSkillDisplayName(skillSlug)] as const;
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

async function fetchExperts(params: {
  keyword: string;
  activeFilter: ExpertFilterId;
  page: number;
}): Promise<{ packages: SkillHubSkillSet[]; total: number }> {
  const response = await fetchSkillSets({
    keyword: params.keyword,
    scene: params.activeFilter === "all" ? undefined : params.activeFilter,
    page: params.page,
    pageSize: EXPERT_PAGE_SIZE,
  });
  const packages = response.skillSets ?? [];
  return {
    packages,
    total: response.total ?? packages.length,
  };
}

export function ExpertsPanel({
  botId,
  execDebugCommand,
}: {
  botId: string;
  execDebugCommand: ExpertsExecDebugCommand;
}) {
  const t = useT();
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

  const visibleCards = useMemo<ExpertPackageCard[]>(() => {
    return expertPackages.map((pkg) => ({ pkg }));
  }, [expertPackages]);

  const hasMoreExperts = expertPackages.length < expertTotal;

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
    } else {
      setExpertsLoadingMore(true);
    }
    setExpertsError(null);

    fetchExperts({ keyword, activeFilter, page: expertPage })
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
  }, [activeFilter, expertPage, expertsRetryNonce, keyword]);

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
      return !packageSkillSlugs.has(pkg.slug);
    });
    if (missingCards.length === 0) return;

    let cancelled = false;

    async function fetchVisiblePackageDetails() {
      await Promise.all(missingCards.map(async ({ pkg }) => {
        try {
          const detail = await fetchSkillSetDetail(pkg.slug);
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
  }, [packageSkillSlugs, visibleCards]);

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
      const detail = await fetchSkillSetDetail(pkg.slug);
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
  }, [botId, execDebugCommand, installingSlug, t]);

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
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-6 text-black/50">
            {t("快速安装技能组合，让 Agent 从单点技能走向完整工作流")}
          </p>
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <ExpertSearchBox value={searchDraft} onChange={setSearchDraft} onCommit={commitSearch} />
          <ExpertViewToggle value={view} onChange={handleViewChange} />
        </div>

        <ExpertSceneFilters
          activeFilter={activeFilter}
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
        view === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] items-start gap-4">
            {visibleCards.map((card) => (
              <ExpertGridCard
                key={card.pkg.slug}
                card={card}
                activeFilter={activeFilter}
                installingSlug={installingSlug}
                installProgress={installProgress}
                isInstalled={isPackageInstalled(card.pkg)}
                onOpen={handleOpenDetail}
                onInstall={handleInstall}
              />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-black/6 bg-white">
            {visibleCards.map((card, index) => (
              <div key={card.pkg.slug}>
                {index > 0 ? <div className="mx-5 h-px bg-black/[0.06]" /> : null}
                <ExpertListItem
                  card={card}
                  activeFilter={activeFilter}
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
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
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
        placeholder="搜索技能包"
        className="lv-agent-search-box-input"
      />
    </div>
  );
}

function ExpertViewToggle({
  value,
  onChange,
}: {
  value: ExpertView;
  onChange: (value: ExpertView) => void;
}) {
  return (
    <div className="flex w-max items-center gap-1 rounded-md bg-black/[0.04] p-0.5">
      {EXPERT_VIEW_OPTIONS.map((item) => {
        const Icon = item.icon;
        const active = value === item.value;
        const tooltipId = `skill-package-view-${item.value}-tooltip`;
        return (
          <span key={item.value} className="group relative inline-flex">
            <button
              type="button"
              onClick={() => onChange(item.value)}
              aria-label={item.label}
              aria-describedby={tooltipId}
              className={cn(
                "peer lv-agent-view-toggle-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] transition-all",
                active ? "bg-white text-black/85 shadow-[0_1px_4px_rgba(0,0,0,0.08)]" : "text-black/45 hover:text-black/70",
              )}
              data-tooltip={item.label}
              aria-pressed={active}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
            <span
              id={tooltipId}
              role="tooltip"
              className="pointer-events-auto absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 select-text whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-hover:opacity-100 peer-focus-visible:opacity-100"
            >
              {item.label}
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
}: {
  activeFilter: ExpertFilterId;
  onChange: (filterId: ExpertFilterId) => void;
}) {
  const t = useT();
  const filters: Array<{ value: ExpertFilterId; label: string; icon: ElementType }> = [
    { value: "all", label: t("全部"), icon: PackageOpen },
    ...EXPERT_SCENES,
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
  return `${AI_BUDDY_ASSET_BASE}/expert-profiles/${slug}.${AI_BUDDY_ASSET_VERSION}.png`;
}

function getExpertInitial(displayName: string): string {
  return Array.from(displayName.trim())[0]?.toUpperCase() ?? "专";
}

function SkillPackageProfileIcon({ pkg, className }: { pkg: SkillHubSkillSet; className?: string }) {
  const [failedImageSlug, setFailedImageSlug] = useState<string | null>(null);
  const imageFailed = failedImageSlug === pkg.slug;

  return (
    <div
      className={cn(
        "relative flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-black/[0.04] text-sm font-semibold text-black/56",
        className,
      )}
      data-testid="skill-package-profile-icon"
    >
      {imageFailed ? (
        <span data-testid="skill-package-profile-fallback">{getExpertInitial(pkg.displayName)}</span>
      ) : (
        <img
          src={getExpertProfileImage(pkg.slug)}
          alt=""
          className="h-full w-full object-cover"
          data-testid="skill-package-profile-image"
          onError={() => setFailedImageSlug(pkg.slug)}
        />
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
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-semibold leading-none transition-colors",
        isInstalled
          ? "bg-[#F4FCF9] text-[#82BDAE]"
          : "bg-black text-white hover:bg-black/85 active:bg-black/95",
        isInstalled ? "cursor-not-allowed" : "",
        installingSlug && !isInstalling ? "cursor-not-allowed opacity-55" : "",
        className,
      )}
    >
      {isInstalling ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : isInstalled ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <PackageCheck className="h-3.5 w-3.5" />
      )}
      {label}
    </button>
  );
}

function ExpertGridCard({
  card,
  activeFilter,
  installingSlug,
  installProgress,
  isInstalled,
  onOpen,
  onInstall,
}: {
  card: ExpertPackageCard;
  activeFilter: ExpertFilterId;
  installingSlug: string | null;
  installProgress: SkillInstallProgress | null;
  isInstalled: boolean;
  onOpen: (card: ExpertPackageCard) => void;
  onInstall: (pkg: SkillHubSkillSet) => void;
}) {
  const t = useT();
  const scene = getPackageScene(card.pkg, activeFilter);
  const summary = getPackageSummary(card.pkg, t);

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
      className="group flex min-h-[164px] cursor-pointer flex-col rounded-md border border-black/6 bg-white px-4 pb-2.5 pt-4 transition-all hover:border-black/12 hover:shadow-[0_10px_28px_rgba(15,23,42,0.055)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/40"
    >
      <div className="flex items-start gap-3">
        <SkillPackageProfileIcon pkg={card.pkg} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-semibold leading-6 text-black/90">{card.pkg.displayName}</h3>
          </div>
          <p className="mt-1.5 truncate text-xs font-medium leading-5 text-black/48">{getExpertRole(scene, t)}</p>
        </div>
      </div>
      <p className="line-clamp-3 text-[13px] leading-5 text-black/58" style={{ marginTop: 16 }} title={summary}>{summary}</p>
      <div className="mt-3.5 flex items-center justify-end">
        <InstallButton
          pkg={card.pkg}
          installingSlug={installingSlug}
          installProgress={installProgress}
          isInstalled={isInstalled}
          onInstall={onInstall}
          className="h-6 px-2 text-xs"
        />
      </div>
    </article>
  );
}

function ExpertListItem({
  card,
  activeFilter,
  installingSlug,
  installProgress,
  isInstalled,
  onOpen,
  onInstall,
}: {
  card: ExpertPackageCard;
  activeFilter: ExpertFilterId;
  installingSlug: string | null;
  installProgress: SkillInstallProgress | null;
  isInstalled: boolean;
  onOpen: (card: ExpertPackageCard) => void;
  onInstall: (pkg: SkillHubSkillSet) => void;
}) {
  const t = useT();
  const scene = getPackageScene(card.pkg, activeFilter);
  const summary = getPackageSummary(card.pkg, t);

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
      className="group flex cursor-pointer items-start gap-4 px-4 py-6 text-left transition-colors hover:bg-black/[0.018] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-black/35"
    >
      <SkillPackageProfileIcon pkg={card.pkg} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <h3 className="truncate text-lg font-semibold leading-6 text-black/90">{card.pkg.displayName}</h3>
        </div>
        <div className="mb-2 flex min-w-0 flex-wrap items-center">
          <p className="truncate text-xs font-medium leading-5 text-black/48">{getExpertRole(scene, t)}</p>
        </div>
        <p className="line-clamp-2 text-[13px] leading-[24px] text-black/58" title={summary}>{summary}</p>
      </div>
      <div className="hidden flex-shrink-0 flex-col items-end gap-3 pt-1 md:flex">
        <InstallButton
          pkg={card.pkg}
          installingSlug={installingSlug}
          installProgress={installProgress}
          isInstalled={isInstalled}
          onInstall={onInstall}
          className="h-7 px-2.5 text-xs"
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
}: {
  card: ExpertPackageCard;
  activeFilter: ExpertFilterId;
  installingSlug: string | null;
  installProgress: SkillInstallProgress | null;
  isInstalled: boolean;
  onBack: () => void;
  onInstall: (pkg: SkillHubSkillSet) => void;
}) {
  const t = useT();
  const detailFetcher = useCallback(() => fetchSkillSetDetail(card.pkg.slug), [card.pkg.slug]);
  const { data, loading, error } = useAsyncResource(detailFetcher, [card.pkg.slug]);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const detail = data ?? card.pkg;
  const scene = getPackageScene(detail, activeFilter);
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
    () => fetchSkillDisplayNames(skillSlugs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skillSlugsKey],
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
        <span>{t("技能包")} / {detail.displayName}</span>
      </button>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-5">
          <SkillPackageProfileIcon pkg={detail} className="h-16 w-16 rounded-[14px]" />
          <div className="min-w-0">
            <h2 className="text-[28px] font-semibold leading-tight text-black/95">{detail.displayName}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-7 gap-y-1 text-sm font-medium leading-6 text-black/48">
              <span>{getExpertRole(scene, t)}</span>
              {skillSlugs.length > 0 ? (
                <span className="inline-flex flex-shrink-0 items-center gap-1.5 text-xs font-light text-black/52">
                  <PackageOpen className="h-3.5 w-3.5" />
                  {t("{{count}} 个技能", { count: skillSlugs.length })}
                </span>
              ) : null}
            </div>
            <p className="mt-5 max-w-5xl text-sm leading-7 text-black/62">
              {getPackageSummary(detail as SkillHubSkillSet, t)}
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
            <div className="inline-flex max-w-full items-center overflow-x-auto rounded-md bg-[#EEEEEE] p-[3px]">
              {skillSlugs.map((skillSlug, index) => {
                const skillDisplayName = skillDisplayNames.data?.get(skillSlug) ?? formatSkillDisplayName(skillSlug);
                return (
                  <button
                    key={skillSlug}
                    type="button"
                    onClick={() => setActiveSkillIndex(index)}
                    className={cn(
                      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[4px] px-4 py-2 text-sm transition-all",
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

            {activeSkillSlug ? <SkillContent slug={activeSkillSlug} /> : null}
          </div>
        ) : (
          <p className="py-8 text-sm text-black/40">{t("暂无技能模块。")}</p>
        )}
      </div>
    </div>
  );
}

function SkillContent({ slug }: { slug: string }) {
  const t = useT();
  const fetcher = useCallback(() => fetchSkillMarkdown(slug), [slug]);
  const { data, loading, error } = useAsyncResource(fetcher, [slug]);

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
          <code className="block overflow-x-auto rounded-md bg-black/[0.04] px-3 py-2 font-mono text-xs leading-6 text-black/62">
            {children}
          </code>
        );
      }
      return (
        <code className="rounded bg-black/[0.05] px-1 py-0.5 font-mono text-xs text-black/62">
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <pre className="my-4 overflow-x-auto rounded-md bg-black/[0.04] p-0">{children}</pre>;
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
