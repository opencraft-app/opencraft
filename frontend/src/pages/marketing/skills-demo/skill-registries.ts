/**
 * Skills 页面 registry 数据层。
 *
 * 设计要点：
 * 1. 两个 registry 的标识符不同：
 *    - ClawHub 用 `slug`（如 `react`）安装：`acli clawhub install <slug>`
 *    - skills.sh 用完整 `id`（如 `anthropics/skills/frontend-design`）安装：`acli skills-sh install <id>`
 *    因此 Skill 同时保存 `registry` + `rawId`，install 时按 registry 决定命令，
 *    避免「用 clawhub 命令装 skills.sh 技能」这类错配。
 *
 * 2. 「已安装技能来源」修正：`acli clawhub list` / `acli skills-sh list` 的返回都不含 source 字段，
 *    单独调用只会得到 Unknown Source。这里同时跑两个 list 命令，并按 registry + rawId 识别技能，
 *    避免不同完整 ID 但相同短 slug 的技能被错误合并。
 *
 * 3. 三套数据通道：
 *    - mock：直接用联调样例 JSON 当 fixture，不需要真实实例即可演示前端
 *    - live：通过 execDebugCommand 下发 acli 命令并解析输出
 *    - domestic：国内站通过 SkillHub HTTP 搜索，并通过 `acli skills` 管理实例技能
 *    由 SKILLS_DEMO_LIVE 切换。等后端把 acli skills-sh 部署到实例后翻成 true 即可联调。
 *
 * 国际站命令契约来源：联调表 skills联调.xlsx（ClawHub / skills.sh 各 4 条命令的输入输出样例）。
 */

import { shellQuote } from "@/lib/hermes-cron-client";
import {
  buildHermesSkillDeleteCommand,
  buildInstalledSkillsListCommand,
  formatInstalledSkillDisplayName,
  parseInstalledSkillSlugs,
} from "@/lib/hermes-skills-client";

import { resolveSkillHubApiBase } from "@/lib/skillhub-api";

import type { ExpertsExecDebugCommand } from "../hermes-agent-experts-panel";

export type Registry = "clawhub" | "skills-sh" | "skillhub" | "hermes";

/** 面板内部统一的技能模型（合并两个 registry 的字段） */
export interface Skill {
  /** 来源 registry */
  registry: Registry;
  /** 展示来源；国内 SkillHub 镜像可能来自 ClawHub，但安装仍走 SkillHub。 */
  sourceRegistry?: Extract<Registry, "clawhub" | "skillhub">;
  /** 安装命令使用的原始标识：ClawHub=slug，skills.sh=完整 id */
  rawId: string;
  /** 短 slug，用于展示 / 已安装列表匹配 */
  slug: string;
  /** 展示名 */
  name: string;
  description?: string;
  installs?: number;
  downloads?: number;
  iconUrl?: string;
  score?: number;
  /** ClawHub 作者 handle */
  author?: string;
  /** skills.sh 源组织前缀，如 `anthropics/skills` */
  sourceOrg?: string;
  /** 国内 SkillHub 分类，用于 Discover 分类展示 */
  category?: string;
}

export interface InstalledSkill extends Skill {
  version?: string;
  /** Registry 同一条记录提供的原生别名；市场 rawId 与本地目录名不同时用于和 Hermes 清单归并。 */
  nativeAliases?: string[];
  /** 来源归属（双 list 合并判定后的结果） */
  sourceLabel: string;
  registries: Registry[];
  /** 兼容旧数据中的卸载能力标记；当前页面为所有已安装来源提供真实卸载。 */
  uninstallable?: boolean;
}

export interface InstallResult {
  ok: boolean;
  message?: string;
}

/** 技能的稳定身份；展示名和短 slug 都不能作为唯一 key。 */
export function skillIdentity(skill: Pick<Skill, "registry" | "rawId">): string {
  return `${skill.registry}:${skill.rawId.trim().toLowerCase()}`;
}

/**
 * 切换 mock / live 数据通道。
 * - true  = 走真实 acli 命令（通过 execDebugCommand 下发到实例）。ClawHub 在国际站实例上已验证可用；
 *           skills.sh 取决于 acli skills-sh 是否已部署到目标实例，未部署时该 registry 静默返回空。
 * - false = 用联调样例数据演示，不接触实例。
 */
export const SKILLS_DEMO_LIVE = true;

export const REGISTRY_LABEL: Record<Registry, string> = {
  clawhub: "ClawHub",
  "skills-sh": "skills.sh",
  skillhub: "SkillHub",
  hermes: "Hermes",
};

// ─── 命令构造 ────────────────────────────────────────────────────────────────

export function buildClawhubSearchCommand(keyword: string, sortBy = "installs"): string {
  return `acli clawhub search ${shellQuote(keyword)} --sort-by ${sortBy}`;
}
export function buildClawhubInstallCommand(slug: string): string {
  return `acli clawhub install ${shellQuote(slug)}`;
}
export function buildClawhubUninstallCommand(slug: string): string {
  return `acli clawhub uninstall ${shellQuote(slug)}`;
}
export function buildClawhubListCommand(): string {
  return "acli clawhub list";
}
export function buildSkillsshSearchCommand(keyword: string, sortBy = "installs"): string {
  return `acli skills-sh search ${shellQuote(keyword)} --sort-by ${sortBy}`;
}

function buildLoginShellCommand(command: string): string {
  return `bash -lc ${shellQuote(`cd "$HOME" && ${command}`)}`;
}

function safeSkillsshId(id: string): string {
  const normalized = id.trim();
  if (!normalized || !/^[A-Za-z0-9@._/-]+$/.test(normalized)) {
    throw new Error("Invalid skills.sh skill ID");
  }
  return normalized;
}

export function buildSkillsshInstallCommand(id: string): string {
  // skills.sh install reads registry/download configuration from agentuser's login profile.
  return buildLoginShellCommand(`acli skills-sh install ${safeSkillsshId(id)}`);
}
export function buildSkillsshUninstallCommand(id: string): string {
  // skills.sh uninstall 未在联调表中确认；按 install 的对称形态下发，
  // 若 acli 尚未支持该子命令，调用方会拿到非 0 退出码并在 UI 提示错误。
  return buildLoginShellCommand(`acli skills-sh uninstall ${safeSkillsshId(id)}`);
}
export function buildSkillsshListCommand(): string {
  return "acli skills-sh list";
}

export function buildSkillhubInstallCommand(slug: string): string {
  return `acli skills install ${shellQuote(slug)}`;
}

export function buildSkillhubUninstallCommand(slug: string): string {
  return `acli skills uninstall ${shellQuote(slug)}`;
}

export function buildSkillhubListCommand(): string {
  return "acli skills list";
}

export function buildHermesSkillsListCommand(): string {
  return buildInstalledSkillsListCommand();
}

// ─── 输出解析 ─────────────────────────────────────────────────────────────────

function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  try {
    return JSON.parse(raw.slice(start)) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function dataEnvelope(parsed: unknown): unknown {
  if (isRecord(parsed) && parsed.success === true && isRecord(parsed.data)) return parsed.data;
  return parsed;
}

interface ClawhubSearchItem {
  author?: string;
  displayName?: string;
  installs?: number;
  score?: number;
  slug?: string;
}
function parseClawhubSearch(raw: string): Skill[] {
  const parsed = dataEnvelope(extractJsonObject(raw));
  if (!isRecord(parsed)) return [];
  const results = Array.isArray(parsed.results) ? (parsed.results as ClawhubSearchItem[]) : [];
  return results
    .map((item) => {
      const slug = (item?.slug ?? "").trim();
      if (!slug) return null;
      return {
        registry: "clawhub" as const,
        rawId: slug,
        slug,
        name: (item?.displayName ?? slug).trim(),
        installs: typeof item?.installs === "number" ? item.installs : undefined,
        score: typeof item?.score === "number" ? item.score : undefined,
        author: item?.author?.trim() || undefined,
      } satisfies Skill;
    })
    .filter((s): s is Skill => s !== null);
}

interface SkillsshSearchItem {
  displayName?: string;
  id?: string;
  installs?: number;
  slug?: string;
  source?: string;
}
function parseSkillsshSearch(raw: string): Skill[] {
  const parsed = dataEnvelope(extractJsonObject(raw));
  if (!isRecord(parsed)) return [];
  const results = Array.isArray(parsed.results) ? (parsed.results as SkillsshSearchItem[]) : [];
  return results
    .map((item) => {
      const id = (item?.id ?? "").trim();
      const slug = (item?.slug ?? "").trim();
      if (!id && !slug) return null;
      const rawId = id || slug;
      const sourceOrg = item?.source?.trim() || undefined;
      return {
        registry: "skills-sh" as const,
        rawId,
        slug: slug || rawId.split("/").pop() || rawId,
        name: (item?.displayName ?? rawId).trim(),
        installs: typeof item?.installs === "number" ? item.installs : undefined,
        sourceOrg,
      } satisfies Skill;
    })
    .filter((s): s is Skill => s !== null);
}

interface ClawhubListItem {
  displayName?: string;
  slug?: string;
  version?: string;
}
function parseClawhubList(raw: string): InstalledSkill[] {
  const parsed = dataEnvelope(extractJsonObject(raw));
  if (!isRecord(parsed)) return [];
  const skills = Array.isArray(parsed.skills) ? (parsed.skills as ClawhubListItem[]) : [];
  return skills
    .map((item) => {
      const slug = (item?.slug ?? "").trim();
      if (!slug) return null;
      return {
        registry: "clawhub" as const,
        rawId: slug,
        slug,
        name: (item?.displayName ?? slug).trim(),
        version: item?.version?.trim() || undefined,
        registries: ["clawhub" as Registry],
        sourceLabel: REGISTRY_LABEL.clawhub,
      } satisfies InstalledSkill;
    })
    .filter((s): s is InstalledSkill => s !== null);
}

interface SkillsshListItem {
  displayName?: string;
  id?: string;
  rawId?: string;
  slug?: string;
}
function parseSkillsshList(raw: string): InstalledSkill[] {
  const parsed = dataEnvelope(extractJsonObject(raw));
  if (!isRecord(parsed)) return [];
  const skills = Array.isArray(parsed.skills) ? (parsed.skills as SkillsshListItem[]) : [];
  return skills
    .map((item) => {
      const rawId = (item?.id ?? item?.rawId ?? item?.slug ?? "").trim();
      if (!rawId) return null;
      const slug = (item?.slug ?? rawId.split("/").pop() ?? rawId).trim();
      return {
        registry: "skills-sh" as const,
        rawId,
        slug,
        name: (item?.displayName ?? slug).trim(),
        registries: ["skills-sh" as Registry],
        sourceLabel: REGISTRY_LABEL["skills-sh"],
      } satisfies InstalledSkill;
    })
    .filter((s): s is InstalledSkill => s !== null);
}

interface SkillhubSearchItem {
  category?: string;
  description?: string;
  descriptionEn?: string;
  description_en?: string;
  description_zh?: string;
  displayNameEn?: string;
  display_name_en?: string;
  downloads?: number;
  iconUrl?: string;
  installs?: number;
  name?: string;
  score?: number;
  slug?: string;
  source?: string;
  summaryEn?: string;
  summary_en?: string;
}

type SkillhubLanguage = "zh" | "en";

function mapSkillhubItem(item: SkillhubSearchItem, language: SkillhubLanguage): Skill | null {
  const slug = item.slug?.trim() || "";
  if (!slug) return null;
  const name = language === "en"
    ? item.displayNameEn?.trim() || item.display_name_en?.trim() || item.name?.trim() || slug
    : item.name?.trim() || slug;
  const description = language === "en"
    ? item.descriptionEn?.trim()
      || item.description_en?.trim()
      || item.summaryEn?.trim()
      || item.summary_en?.trim()
      || item.description?.trim()
    : item.description_zh?.trim() || item.description?.trim();
  return {
    registry: "skillhub",
    sourceRegistry: item.source?.trim().toLowerCase() === "clawhub" ? "clawhub" : "skillhub",
    rawId: slug,
    slug,
    name,
    description: description || undefined,
    installs: typeof item.installs === "number" ? item.installs : undefined,
    downloads: typeof item.downloads === "number" ? item.downloads : undefined,
    iconUrl: item.iconUrl?.trim() || undefined,
    score: typeof item.score === "number" ? item.score : undefined,
    sourceOrg: item.source?.trim() || undefined,
    category: item.category?.trim() || undefined,
  };
}

/** 解析 SkillHub `/api/skills` 的公共响应，兼容 code/data 和直接 data 两种包装。 */
export function parseSkillhubSearch(raw: string, language: SkillhubLanguage = "zh"): Skill[] {
  const parsed = extractJsonObject(raw);
  if (!isRecord(parsed)) return [];
  const outerData = isRecord(parsed.data) ? parsed.data : parsed;
  if (!isRecord(outerData) || !Array.isArray(outerData.skills)) return [];
  return (outerData.skills as SkillhubSearchItem[])
    .map((item) => mapSkillhubItem(item, language))
    .filter((skill): skill is Skill => skill !== null);
}

interface SkillhubListItem {
  display_name?: string;
  displayName?: string;
  id?: string;
  iconUrl?: string;
  name?: string;
  rawId?: string;
  slug?: string;
  source?: string;
  version?: string;
}

function parseSkillhubListTable(raw: string): SkillhubListItem[] {
  return raw.split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 0 && cells[0] && cells[0] !== "Name" && cells[0] !== "名称")
    .map(([name, version]) => ({ name, version }));
}

export function parseSkillhubList(raw: string): InstalledSkill[] {
  const parsed = dataEnvelope(extractJsonObject(raw));
  const items = isRecord(parsed) && Array.isArray(parsed.skills)
    ? parsed.skills as SkillhubListItem[]
    : parseSkillhubListTable(raw);

  return items.map((item) => {
    const explicitId = item.slug ?? item.rawId ?? item.id;
    const listedName = (item.name ?? "").trim();
    const nativeAliases = Array.from(new Set(
      [explicitId ? listedName : "", item.display_name, item.displayName]
        .map((value) => value?.trim() ?? "")
        .filter(Boolean),
    ));
    const rawId = explicitId
      ? (/^\d+$/.test(explicitId.trim()) ? "" : explicitId.trim())
      : listedName;
    if (!rawId) return null;
    const name = (item.display_name ?? item.displayName ?? item.name ?? rawId).trim();
    return {
      registry: "skillhub" as const,
      rawId,
      slug: rawId,
      name,
      iconUrl: item.iconUrl?.trim() || undefined,
      version: item.version?.trim() || undefined,
      nativeAliases: nativeAliases.length > 0 ? nativeAliases : undefined,
      registries: ["skillhub" as Registry],
      sourceLabel: REGISTRY_LABEL.skillhub,
    } satisfies InstalledSkill;
  }).filter((skill): skill is InstalledSkill => skill !== null);
}

export function parseHermesInstalledSkills(raw: string): InstalledSkill[] {
  return parseInstalledSkillSlugs(raw).map((slug) => ({
    registry: "hermes",
    rawId: slug,
    slug,
    name: formatInstalledSkillDisplayName(slug) || slug,
    registries: ["hermes"],
    sourceLabel: REGISTRY_LABEL.hermes,
    uninstallable: true,
  }));
}

export function parseInstallOk(raw: string): boolean {
  const envelope = extractJsonObject(raw);
  if (!isRecord(envelope) || ("success" in envelope && envelope.success !== true)) return false;
  const parsed = dataEnvelope(envelope);
  if (isRecord(parsed)) {
    if (parsed.success === true) return true;
    const status = parsed.status;
    if (typeof status === "string" && /install/i.test(status)) return true;
  }
  return false;
}

/** 解析 acli uninstall 输出：`{ name, status: 'uninstalled' }` 或 `{ success: true }` 都算成功。 */
export function parseUninstallOk(raw: string): boolean {
  const envelope = extractJsonObject(raw);
  if (!isRecord(envelope) || ("success" in envelope && envelope.success !== true)) return false;
  const parsed = dataEnvelope(envelope);
  if (isRecord(parsed)) {
    if (parsed.success === true) return true;
    const status = parsed.status;
    if (typeof status === "string" && /uninstall|remove|delet/i.test(status)) return true;
  }
  return false;
}

// ─── 合并 / 排序 / 来源归属 ───────────────────────────────────────────────────

export function mergeSkills(clawhub: Skill[], skillssh: Skill[], skillhub: Skill[] = []): Skill[] {
  return [...clawhub, ...skillssh, ...skillhub];
}

function popularitySortValue(skill: Pick<Skill, "registry" | "installs" | "downloads">): number {
  return skill.registry === "skillhub" ? (skill.downloads ?? 0) : (skill.installs ?? 0);
}

export function sortByPopular(skills: Skill[]): Skill[] {
  if (!Array.isArray(skills)) return [];
  return [...skills].sort(
    (a, b) => popularitySortValue(b) - popularitySortValue(a) || a.name.localeCompare(b.name),
  );
}

export function sortByName(skills: Skill[]): Skill[] {
  if (!Array.isArray(skills)) return [];
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把 clawhub list + skills-sh list 的结果合并，并按 slug 归属判定每个已安装技能的来源。
 * 这一步是修正「Unknown Source」的关键：单 list 不带 source 字段，必须双 list 交叉判定。
 */
export function mergeInstalledSources(
  clawhubInstalled: InstalledSkill[],
  skillsshInstalled: InstalledSkill[],
): InstalledSkill[] {
  const byIdentity = new Map<string, InstalledSkill>();
  const mergeInto = (list: InstalledSkill[], reg: Registry) => {
    for (const skill of list) {
      const key = skillIdentity(skill);
      const existing = byIdentity.get(key);
      if (!existing) {
        byIdentity.set(key, { ...skill, registries: [reg] });
      } else {
        const set = new Set<Registry>(existing.registries);
        set.add(reg);
        const registries = Array.from(set);
        existing.registries = registries;
        existing.sourceLabel = registries.map((r) => REGISTRY_LABEL[r]).join(" / ");
        existing.version = existing.version ?? skill.version;
      }
    }
  };
  mergeInto(clawhubInstalled, "clawhub");
  mergeInto(skillsshInstalled, "skills-sh");

  const installed = Array.from(byIdentity.values());
  const bySlug = new Map<string, InstalledSkill[]>();
  for (const skill of installed) {
    const slug = skill.slug.trim().toLowerCase();
    const matches = bySlug.get(slug) ?? [];
    matches.push(skill);
    bySlug.set(slug, matches);
  }

  const merged: InstalledSkill[] = [];
  for (const matches of bySlug.values()) {
    const clawhubSkill = matches.length === 2
      ? matches.find((skill) => skill.registry === "clawhub")
      : undefined;
    const skillsshSkill = matches.length === 2
      ? matches.find((skill) => skill.registry === "skills-sh")
      : undefined;
    if (!clawhubSkill || !skillsshSkill) {
      merged.push(...matches);
      continue;
    }

    const registries = Array.from(new Set<Registry>([
      ...skillsshSkill.registries,
      ...clawhubSkill.registries,
    ]));
    const skillsshNameIsSlug = skillsshSkill.name.trim().toLowerCase() === skillsshSkill.slug.trim().toLowerCase();
    merged.push({
      ...skillsshSkill,
      name: skillsshNameIsSlug ? clawhubSkill.name : skillsshSkill.name,
      version: skillsshSkill.version ?? clawhubSkill.version,
      registries,
      sourceLabel: registries.map((registry) => REGISTRY_LABEL[registry]).join(" / "),
    });
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export function mergeInstalledWithHermes(
  registryInstalled: InstalledSkill[],
  hermesInstalled: InstalledSkill[],
): InstalledSkill[] {
  const merged = registryInstalled.map((skill) => ({
    ...skill,
    registries: [...skill.registries],
    uninstallable: skill.uninstallable ?? true,
  }));

  for (const hermesSkill of hermesInstalled) {
    const normalizedSlug = hermesSkill.slug.trim().toLowerCase();
    const matches = merged.filter((skill) => (
      skill.registry !== "hermes"
      && (
        skill.slug.trim().toLowerCase() === normalizedSlug
        || skill.nativeAliases?.some((alias) => alias.toLowerCase() === normalizedSlug)
      )
    ));
    if (matches.length === 1 && matches[0]) {
      if (!matches[0].registries.includes("hermes")) matches[0].registries.push("hermes");
      matches[0].sourceLabel = matches[0].registries.map((registry) => REGISTRY_LABEL[registry]).join(" / ");
      continue;
    }
    merged.push({ ...hermesSkill, registries: [...hermesSkill.registries], uninstallable: true });
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── 数据层接口 ───────────────────────────────────────────────────────────────

export type SkillSearchSort = "score" | "downloads";

export type SkillSearchOptions = {
  sortBy?: SkillSearchSort;
};

export interface SkillsDataLayer {
  search(keyword: string, options?: SkillSearchOptions): Promise<{ clawhub: Skill[]; skillssh: Skill[]; skillhub: Skill[] }>;
  listInstalled(): Promise<InstalledSkill[]>;
  install(skill: Skill): Promise<InstallResult>;
  /** 卸载已安装技能。ClawHub 走 acli clawhub uninstall；skills.sh 走对称子命令（未确认时调用会失败）。 */
  uninstall(skill: Skill): Promise<InstallResult>;
  /** 默认页（无搜索）的推荐位。mock 返回 fixtures；live 暂返回空，后续可接 trending。 */
  getPopular(): Promise<{ clawhub: Skill[]; skillssh: Skill[]; skillhub: Skill[] }>;
}

export type BatchInstallResult = {
  succeeded: Skill[];
  failed: Array<{ skill: Skill; message?: string }>;
};

export async function installSkillsSequentially(
  dataLayer: Pick<SkillsDataLayer, "install">,
  skills: Skill[],
): Promise<BatchInstallResult> {
  const succeeded: Skill[] = [];
  const failed: BatchInstallResult["failed"] = [];
  for (const skill of skills) {
    try {
      const result = await dataLayer.install(skill);
      if (result.ok) succeeded.push(skill);
      else failed.push({ skill, message: result.message });
    } catch (error) {
      failed.push({ skill, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { succeeded, failed };
}

export type BatchUninstallResult = {
  succeeded: InstalledSkill[];
  failed: Array<{ skill: InstalledSkill; message?: string }>;
};

export async function uninstallSkillsSequentially(
  dataLayer: Pick<SkillsDataLayer, "uninstall">,
  skills: InstalledSkill[],
): Promise<BatchUninstallResult> {
  const succeeded: InstalledSkill[] = [];
  const failed: BatchUninstallResult["failed"] = [];
  for (const skill of skills) {
    try {
      const result = await dataLayer.uninstall(skill);
      if (result.ok) succeeded.push(skill);
      else failed.push({ skill, message: result.message });
    } catch (error) {
      failed.push({ skill, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { succeeded, failed };
}

// ─── Mock fixtures（来自联调样例 JSON） ───────────────────────────────────────

const MOCK_CLAWHUB_SEARCH: Skill[] = [
  { registry: "clawhub", rawId: "react", slug: "react", name: "React", author: "ivangdavila", installs: 232, score: 4.083 },
  { registry: "clawhub", rawId: "react-best-practices", slug: "react-best-practices", name: "React Best Practices", author: "wpank", installs: 181, score: 2.935 },
  { registry: "clawhub", rawId: "react-native", slug: "react-native", name: "React Native", author: "ivangdavila", installs: 116, score: 2.59 },
  { registry: "clawhub", rawId: "react-best-practices-2", slug: "react-best-practices-2", name: "Vercel React Best Practices", author: "analsharqy", installs: 102, score: 2.59 },
  { registry: "clawhub", rawId: "react-performance", slug: "react-performance", name: "React Performance", author: "wpank", installs: 85, score: 2.958 },
  { registry: "clawhub", rawId: "vercel-react-native-skills", slug: "vercel-react-native-skills", name: "React Native Skills", author: "xaiohuangningde", installs: 68, score: 2.59 },
  { registry: "clawhub", rawId: "realtime-react-hooks", slug: "realtime-react-hooks", name: "Realtime React Hooks", author: "wpank", installs: 50, score: 2.908 },
  { registry: "clawhub", rawId: "afrexai-react-production", slug: "afrexai-react-production", name: "React Production Engineering", author: "1kalin", installs: 45, score: 2.876 },
  { registry: "clawhub", rawId: "compound-eng-react-frontend", slug: "compound-eng-react-frontend", name: "ia-react-frontend", author: "iliaal", installs: 40, score: 2.942 },
  { registry: "clawhub", rawId: "react-native-logs-cli", slug: "react-native-logs-cli", name: "React Native Logs", author: "okwasniewski", installs: 40, score: 2.59 },
  { registry: "clawhub", rawId: "minimax-react-native-dev", slug: "minimax-react-native-dev", name: "MiniMax React Native Dev", author: "daidai8910g", installs: 28, score: 2.866 },
  { registry: "clawhub", rawId: "react-patterns", slug: "react-patterns", name: "React Patterns", author: "codekungfu", installs: 26, score: 2.904 },
  { registry: "clawhub", rawId: "react-flow-implementation", slug: "react-flow-implementation", name: "React Flow Implementation", author: "anderskev", installs: 21, score: 2.9 },
  { registry: "clawhub", rawId: "react-flow-architecture", slug: "react-flow-architecture", name: "React Flow Architecture", author: "anderskev", installs: 20, score: 2.872 },
  { registry: "clawhub", rawId: "react-flow", slug: "react-flow", name: "React Flow", author: "anderskev", installs: 18, score: 2.897 },
  { registry: "clawhub", rawId: "react-flow-advanced", slug: "react-flow-advanced", name: "React Flow Advanced", author: "anderskev", installs: 18, score: 2.863 },
  { registry: "clawhub", rawId: "react-advanced", slug: "react-advanced", name: "React Advanced", author: "wangzhiming1999", installs: 17, score: 2.93 },
  { registry: "clawhub", rawId: "agentic-atlas-react-best-practices", slug: "agentic-atlas-react-best-practices", name: "React Best Practices", author: "asimons81", installs: 17, score: 2.895 },
  { registry: "clawhub", rawId: "react-game-loop", slug: "react-game-loop", name: "React Game Loop Hooks", author: "ravenquasar", installs: 14, score: 2.873 },
  { registry: "clawhub", rawId: "ah-react-pro", slug: "ah-react-pro", name: "react-pro", author: "mtsatryan", installs: 13, score: 2.934 },
  { registry: "clawhub", rawId: "react-component-auditor", slug: "react-component-auditor", name: "React Component Auditor", author: "charlie-morrison", installs: 13, score: 2.911 },
  { registry: "clawhub", rawId: "ah-react-specialist", slug: "ah-react-specialist", name: "react-specialist", author: "mtsatryan", installs: 12, score: 2.956 },
  { registry: "clawhub", rawId: "fec-react-project-standard", slug: "fec-react-project-standard", name: "React Project Standard", author: "bovinphang", installs: 11, score: 2.954 },
  { registry: "clawhub", rawId: "react-flow-best-practices", slug: "react-flow-best-practices", name: "React Flow Best Practices", author: "johnwayneeee", installs: 11, score: 2.867 },
  { registry: "clawhub", rawId: "react-component-review", slug: "react-component-review", name: "React Component Review", author: "ritual", installs: 1, score: 2.871 },
];

const MOCK_SKILLSSH_SEARCH: Skill[] = [
  { registry: "skills-sh", rawId: "anthropics/skills/frontend-design", slug: "frontend-design", name: "frontend-design", sourceOrg: "anthropics/skills", installs: 638300 },
  { registry: "skills-sh", rawId: "microsoft/azure-skills/azure-validate", slug: "azure-validate", name: "azure-validate", sourceOrg: "microsoft/azure-skills", installs: 434008 },
  { registry: "skills-sh", rawId: "microsoft/azure-skills/azure-aigateway", slug: "azure-aigateway", name: "azure-aigateway", sourceOrg: "microsoft/azure-skills", installs: 433645 },
  { registry: "skills-sh", rawId: "microsoft/azure-skills/azure-hosted-copilot-sdk", slug: "azure-hosted-copilot-sdk", name: "azure-hosted-copilot-sdk", sourceOrg: "microsoft/azure-skills", installs: 406637 },
  { registry: "skills-sh", rawId: "microsoft/azure-skills/azure-compute", slug: "azure-compute", name: "azure-compute", sourceOrg: "microsoft/azure-skills", installs: 377352 },
  { registry: "skills-sh", rawId: "microsoft/azure-skills/azure-cloud-migrate", slug: "azure-cloud-migrate", name: "azure-cloud-migrate", sourceOrg: "microsoft/azure-skills", installs: 367302 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-doc", slug: "lark-doc", name: "lark-doc", sourceOrg: "larksuite/cli", installs: 328502 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-base", slug: "lark-base", name: "lark-base", sourceOrg: "larksuite/cli", installs: 327270 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-im", slug: "lark-im", name: "lark-im", sourceOrg: "larksuite/cli", installs: 326905 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-drive", slug: "lark-drive", name: "lark-drive", sourceOrg: "larksuite/cli", installs: 326583 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-shared", slug: "lark-shared", name: "lark-shared", sourceOrg: "larksuite/cli", installs: 326483 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-wiki", slug: "lark-wiki", name: "lark-wiki", sourceOrg: "larksuite/cli", installs: 325482 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-whiteboard", slug: "lark-whiteboard", name: "lark-whiteboard", sourceOrg: "larksuite/cli", installs: 325396 },
  { registry: "skills-sh", rawId: "larksuite/cli/lark-calendar", slug: "lark-calendar", name: "lark-calendar", sourceOrg: "larksuite/cli", installs: 325391 },
  { registry: "skills-sh", rawId: "microsoft/azure-skills/azure-enterprise-infra-planner", slug: "azure-enterprise-infra-planner", name: "azure-enterprise-infra-planner", sourceOrg: "microsoft/azure-skills", installs: 270420 },
  { registry: "skills-sh", rawId: "microsoft/azure-skills/azure-kubernetes", slug: "azure-kubernetes", name: "azure-kubernetes", sourceOrg: "microsoft/azure-skills", installs: 263306 },
  { registry: "skills-sh", rawId: "vercel-labs/agent-skills/vercel-composition-patterns", slug: "vercel-composition-patterns", name: "vercel-composition-patterns", sourceOrg: "vercel-labs/agent-skills", installs: 240733 },
  { registry: "skills-sh", rawId: "mattpocock/skills/teach", slug: "teach", name: "teach", sourceOrg: "mattpocock/skills", installs: 182376 },
  { registry: "skills-sh", rawId: "better-auth/skills/better-auth-best-practices", slug: "better-auth-best-practices", name: "better-auth-best-practices", sourceOrg: "better-auth/skills", installs: 69947 },
  { registry: "skills-sh", rawId: "anthropics/skills/template-skill", slug: "template-skill", name: "template-skill", sourceOrg: "anthropics/skills", installs: 52121 },
];

function mockMatch(skill: Skill, keyword: string): boolean {
  if (!keyword) return true;
  const kw = keyword.toLowerCase();
  return (
    skill.name.toLowerCase().includes(kw) ||
    skill.slug.toLowerCase().includes(kw) ||
    (skill.author?.toLowerCase().includes(kw) ?? false) ||
    (skill.sourceOrg?.toLowerCase().includes(kw) ?? false)
  );
}

const MOCK_INSTALLED_STORAGE_PREFIX = "lightvela-skills-demo-installed";

/** 默认预置几个已安装技能，让「已安装」区能直接展示来源归属（ClawHub / skills.sh）。 */
const MOCK_SEED_INSTALLED: Array<{ slug: string; registry: Registry; name: string; version?: string }> = [
  { slug: "react", registry: "clawhub", name: "React", version: "1.0.4" },
  { slug: "react-best-practices", registry: "clawhub", name: "React Best Practices" },
  { slug: "frontend-design", registry: "skills-sh", name: "frontend-design" },
  { slug: "lark-doc", registry: "skills-sh", name: "lark-doc" },
];

interface MockInstalledRecord {
  slug: string;
  rawId?: string;
  registry: Registry;
  name: string;
  version?: string;
}

function readMockInstalled(): MockInstalledRecord[] {
  if (typeof window === "undefined") return [...MOCK_SEED_INSTALLED];
  try {
    const raw = window.localStorage.getItem(`${MOCK_INSTALLED_STORAGE_PREFIX}:seeded`);
    if (raw == null) {
      // 首次进入：写入种子数据，便于演示来源归属。
      const seed = JSON.stringify(MOCK_SEED_INSTALLED);
      window.localStorage.setItem(`${MOCK_INSTALLED_STORAGE_PREFIX}:seeded`, seed);
      return [...MOCK_SEED_INSTALLED];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MockInstalledRecord =>
      isRecord(item) &&
      typeof item.slug === "string" &&
      (item.registry === "clawhub" || item.registry === "skills-sh"),
    );
  } catch {
    return [...MOCK_SEED_INSTALLED];
  }
}

function writeMockInstalled(records: MockInstalledRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${MOCK_INSTALLED_STORAGE_PREFIX}:seeded`, JSON.stringify(records));
  } catch {
    /* ignore */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

// ─── Mock 数据层 ─────────────────────────────────────────────────────────────

export function createMockDataLayer(): SkillsDataLayer {
  return {
    async search(keyword: string) {
      await delay(180);
      const kw = keyword.trim();
      return {
        clawhub: MOCK_CLAWHUB_SEARCH.filter((s) => mockMatch(s, kw)),
        skillssh: MOCK_SKILLSSH_SEARCH.filter((s) => mockMatch(s, kw)),
        skillhub: [],
      };
    },
    async listInstalled() {
      await delay(120);
      const records = readMockInstalled();
      // 按注册来源分桶后走和 live 一样的合并逻辑，保证演示与真实通道一致。
      const clawhubInstalled: InstalledSkill[] = [];
      const skillsshInstalled: InstalledSkill[] = [];
      for (const rec of records) {
        const entry: InstalledSkill = {
          registry: rec.registry,
          rawId: rec.rawId ?? rec.slug,
          slug: rec.slug,
          name: rec.name,
          version: rec.version,
          registries: [rec.registry],
          sourceLabel: REGISTRY_LABEL[rec.registry],
        };
        if (rec.registry === "clawhub") clawhubInstalled.push(entry);
        else skillsshInstalled.push(entry);
      }
      return mergeInstalledSources(clawhubInstalled, skillsshInstalled);
    },
    async install(skill: Skill) {
      await delay(650);
      const records = readMockInstalled();
      const exists = records.some((r) => skillIdentity({
        registry: r.registry,
        rawId: r.rawId ?? r.slug,
      }) === skillIdentity(skill));
      if (!exists) {
        records.push({ rawId: skill.rawId, slug: skill.slug, registry: skill.registry, name: skill.name });
        writeMockInstalled(records);
      }
      return { ok: true };
    },
    async uninstall(skill: Skill) {
      await delay(500);
      let records = readMockInstalled();
      const before = records.length;
      records = records.filter((r) => skillIdentity({
        registry: r.registry,
        rawId: r.rawId ?? r.slug,
      }) !== skillIdentity(skill));
      if (records.length !== before) writeMockInstalled(records);
      return { ok: true };
    },
    async getPopular() {
      // 不加 artificial delay：默认页是落地首屏，应即时。
      return {
        clawhub: sortByPopular(MOCK_CLAWHUB_SEARCH),
        skillssh: sortByPopular(MOCK_SKILLSSH_SEARCH),
        skillhub: [],
      };
    },
  };
}

// ─── Live 数据层（通过 acli 命令 + execDebugCommand 联调） ─────────────────────

export function createLiveDataLayer(
  botId: string,
  execDebugCommand: ExpertsExecDebugCommand,
): SkillsDataLayer {
  const run = async (command: string): Promise<string> => {
    const result = await execDebugCommand(botId, command);
    // exitCode === 0 视为命令成功；失败时优先保留 stderr，便于定位实例上的真实原因。
    if (result.exitCode !== 0) {
      const detail = [result.stderr, result.output]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
        .join("\n");
      throw new Error(detail || `${result.status} (exit ${result.exitCode})`);
    }
    return result.output ?? "";
  };

  return {
    async search(keyword: string) {
      const kw = keyword.trim();
      if (!kw) return { clawhub: [], skillssh: [], skillhub: [] };
      const [clawhubRaw, skillsshRaw] = await Promise.allSettled([
        run(buildClawhubSearchCommand(kw)),
        run(buildSkillsshSearchCommand(kw)),
      ]);
      return {
        clawhub: clawhubRaw.status === "fulfilled" ? parseClawhubSearch(clawhubRaw.value) : [],
        skillssh: skillsshRaw.status === "fulfilled" ? parseSkillsshSearch(skillsshRaw.value) : [],
        skillhub: [],
      };
    },
    async listInstalled() {
      const [clawhubRaw, skillsshRaw, hermesRaw] = await Promise.allSettled([
        run(buildClawhubListCommand()),
        run(buildSkillsshListCommand()),
        run(buildHermesSkillsListCommand()),
      ]);
      const clawhubInstalled = clawhubRaw.status === "fulfilled" ? parseClawhubList(clawhubRaw.value) : [];
      const skillsshInstalled = skillsshRaw.status === "fulfilled" ? parseSkillsshList(skillsshRaw.value) : [];
      const hermesInstalled = hermesRaw.status === "fulfilled" ? parseHermesInstalledSkills(hermesRaw.value) : [];
      return mergeInstalledWithHermes(
        mergeInstalledSources(clawhubInstalled, skillsshInstalled),
        hermesInstalled,
      );
    },
    async install(skill: Skill) {
      const command =
        skill.registry === "skills-sh"
          ? buildSkillsshInstallCommand(skill.rawId)
          : buildClawhubInstallCommand(skill.rawId);
      try {
        const output = await run(command);
        const ok = parseInstallOk(output);
        return { ok, message: ok ? undefined : output.trim() || undefined };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    async uninstall(skill: Skill) {
      try {
        const command = skill.registry === "hermes"
          ? buildHermesSkillDeleteCommand(skill.rawId)
          : skill.registry === "skills-sh"
            ? buildSkillsshUninstallCommand(skill.rawId)
            : buildClawhubUninstallCommand(skill.rawId);
        const output = await run(command);
        if (skill.registry === "hermes") return { ok: true };
        const ok = parseUninstallOk(output);
        return { ok, message: ok ? undefined : output.trim() || undefined };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    async getPopular() {
      // live 通道没有「无搜索 Popular」概念；后续可接 registry 的 trending / top 排行。
      return { clawhub: [], skillssh: [], skillhub: [] };
    },
  };
}

// ─── 国内站数据层（SkillHub HTTP + acli skills） ───────────────────────────────

async function fetchSkillhubSkills(params: {
  keyword?: string;
  pageSize: number;
  sortBy?: SkillSearchSort;
  lang?: SkillhubLanguage;
}): Promise<Skill[]> {
  const query = new URLSearchParams({
    page: "1",
    pageSize: String(params.pageSize),
    sortBy: params.sortBy ?? "score",
    order: "desc",
  });
  if (params.keyword?.trim()) query.set("keyword", params.keyword.trim());
  if (params.lang) query.set("lang", params.lang);

  const response = await fetch(`${resolveSkillHubApiBase()}/api/skills?${query.toString()}`);
  if (!response.ok) throw new Error(`SkillHub ${response.status} ${response.statusText}`);
  return parseSkillhubSearch(JSON.stringify(await response.json()), params.lang);
}

export function createDomesticDataLayer(
  botId: string,
  execDebugCommand: ExpertsExecDebugCommand,
  language: SkillhubLanguage = "zh",
): SkillsDataLayer {
  const run = async (command: string): Promise<string> => {
    const result = await execDebugCommand(botId, command);
    if (result.exitCode !== 0) {
      const detail = [result.stderr, result.output]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
        .join("\n");
      throw new Error(detail || `${result.status} (exit ${result.exitCode})`);
    }
    return result.output ?? "";
  };

  return {
    async search(keyword: string, options?: SkillSearchOptions) {
      try {
        // 热门时让 SkillHub 先按 downloads 排名，避免高下载 ClawHub 镜像被 score 结果挤掉。
        return {
          clawhub: [],
          skillssh: [],
          skillhub: await fetchSkillhubSkills({ keyword, pageSize: 50, sortBy: options?.sortBy, lang: language }),
        };
      } catch {
        return { clawhub: [], skillssh: [], skillhub: [] };
      }
    },
    async listInstalled() {
      const [skillhubRaw, hermesRaw] = await Promise.allSettled([
        run(buildSkillhubListCommand()),
        run(buildHermesSkillsListCommand()),
      ]);
      const skillhubInstalled = skillhubRaw.status === "fulfilled" ? parseSkillhubList(skillhubRaw.value) : [];
      const hermesInstalled = hermesRaw.status === "fulfilled" ? parseHermesInstalledSkills(hermesRaw.value) : [];
      return mergeInstalledWithHermes(skillhubInstalled, hermesInstalled);
    },
    async install(skill: Skill) {
      try {
        const output = await run(buildSkillhubInstallCommand(skill.rawId));
        const ok = parseInstallOk(output);
        return { ok, message: ok ? undefined : output.trim() || undefined };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    async uninstall(skill: Skill) {
      try {
        const output = await run(skill.registry === "hermes"
          ? buildHermesSkillDeleteCommand(skill.rawId)
          : buildSkillhubUninstallCommand(skill.rawId));
        if (skill.registry === "hermes") return { ok: true };
        const ok = parseUninstallOk(output);
        return { ok, message: ok ? undefined : output.trim() || undefined };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    async getPopular() {
      try {
        return { clawhub: [], skillssh: [], skillhub: await fetchSkillhubSkills({ pageSize: 100, lang: language }) };
      } catch {
        return { clawhub: [], skillssh: [], skillhub: [] };
      }
    },
  };
}

export function createSkillsDataLayer(
  botId: string,
  execDebugCommand: ExpertsExecDebugCommand,
  mode: "global" | "domestic" = "global",
  language: SkillhubLanguage = "zh",
): SkillsDataLayer {
  if (mode === "domestic") return createDomesticDataLayer(botId, execDebugCommand, language);
  return SKILLS_DEMO_LIVE
    ? createLiveDataLayer(botId, execDebugCommand)
    : createMockDataLayer();
}

// ─── 展示工具 ─────────────────────────────────────────────────────────────────

export function formatInstalls(value?: number): string {
  if (typeof value !== "number") return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

/** 仅用于展示热度徽标；国际站看 installs，国内站看 SkillHub downloads。 */
export type PopularityTier = 1;

export function getPopularityTier(
  skill: Pick<Skill, "registry" | "installs" | "downloads">,
): PopularityTier | undefined {
  const value = popularitySortValue(skill);
  if (typeof value !== "number") return undefined;
  const threshold = skill.registry === "skillhub" ? 10_000 : 20_000;
  return value > threshold ? 1 : undefined;
}
