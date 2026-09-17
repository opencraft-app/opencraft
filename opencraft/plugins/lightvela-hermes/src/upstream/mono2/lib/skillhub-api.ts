// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * SkillHub 公共数据接口客户端。
 *
 * 正式环境使用 SkillHub API (`https://api.skillhub.cn`) 读取公共目录数据：
 * 人设（Soul）与技能包（SkillSet）。本地开发通过 Next dev rewrite 访问同一个
 * SkillHub 正式 API，避免 localhost 直连 api.skillhub.cn 时被浏览器 CORS 拦截。
 *
 * 鉴权类接口（活动抽卡 / 我的组合 / 一键安装）需要 SkillHub 的 JWT Cookie，
 * 跨产品场景下要走"mono2 后端代理 + service token"的方案，**不在本模块范围**。
 *
 * 参考：skillhub-git/shared/api/openclaw.ts、skillhub-git/api.md
 */

interface SkillHubRuntimeEnv {
  DEV?: boolean;
}

interface DesktopSkillHubPort {
  get(path: string): Promise<{ status: number; contentType: string | null; body: Uint8Array }>;
}

function desktopSkillHubPort(): DesktopSkillHubPort | null {
  const desktop = (globalThis as { opencraftDesktop?: { kind?: unknown; skillHub?: DesktopSkillHubPort } }).opencraftDesktop;
  return desktop?.kind === "electron" && desktop.skillHub ? desktop.skillHub : null;
}

export function resolveSkillHubApiBase(env: SkillHubRuntimeEnv | undefined = import.meta.env): string {
  const isDev = env?.DEV ?? (typeof process !== "undefined" && process.env.NODE_ENV === "development");
  return isDev ? "/__skillhub_api" : "https://api.skillhub.cn";
}

const SKILLHUB_API_BASE = resolveSkillHubApiBase();
const soulsListCache = new Map<string, Promise<SkillHubSoulListResponse>>();

// ─── 类型 ───────────────────────────────────────────────────────────────────

/** Soul 列表项（精简字段，不含 content） */
export interface SkillHubSoul {
  id: number;
  slug: string;
  displayName: string;
  summary: string;
  remark: string;
  version: string;
  createdAt: number;
  updatedAt: number;
}

/** Soul 详情（带正文 content） */
export interface SkillHubSoulDetail extends SkillHubSoul {
  /** 人设介绍正文，markdown 形式 */
  content: string;
}

export interface SkillHubSoulListResponse {
  total?: number;
  souls: SkillHubSoul[];
}

export type SkillHubKnownSkillSetScene =
  | "academic"
  | "content-creation"
  | "design"
  | "ecommerce"
  | "education"
  | "finance"
  | "healthcare"
  | "hr"
  | "legal"
  | "lifestyle"
  | "marketing"
  | "media"
  | "mysticism"
  | "tech";

export type SkillHubSkillSetScene = SkillHubKnownSkillSetScene | (string & {});

/** SkillHub 技能包列表项（SkillSet） */
export interface SkillHubSkillSet {
  id: number;
  slug: string;
  displayName: string;
  displayNameEn?: string;
  summary: string;
  summaryEn?: string;
  remark: string;
  contentEn?: string;
  scope?: number;
  scene?: SkillHubSkillSetScene;
  subScene?: string;
  avatarUrl?: string | null;
  skillCount?: number;
  skillSlugs?: string[];
  missing?: string[];
  createdAt: number;
  updatedAt: number;
}

/** SkillHub 技能包详情，包含待安装的 skill slug 列表 */
export interface SkillHubSkillSetDetail extends SkillHubSkillSet {
  skillSlugs: string[];
  content?: string;
}

export interface SkillHubSkillSetListResponse {
  total?: number;
  skillSets: SkillHubSkillSet[];
}

export interface SkillHubSkill {
  id?: number;
  slug: string;
  displayName: string;
  displayNameEn?: string;
  summary?: string;
  summaryEn?: string;
  summary_zh?: string;
}

export interface SkillHubSkillDetailResponse {
  skill: SkillHubSkill;
}

export interface SkillHubSkillFileItem {
  path: string;
  size: number;
  sha256: string;
}

// ─── 请求工具 ───────────────────────────────────────────────────────────────

async function publicGet<T>(path: string): Promise<T> {
  const desktop = desktopSkillHubPort();
  if (desktop) {
    const response = await desktop.get(path);
    const body = new TextDecoder().decode(response.body);
    if (response.status < 200 || response.status >= 300) throw new Error(`${response.status} SkillHub request failed`);
    return JSON.parse(body) as T;
  }
  const res = await fetch(`${SKILLHUB_API_BASE}${path}`);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 非 JSON 错误体，沿用 status text */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ─── 接口 ────────────────────────────────────────────────────────────────────

/** 分页查询 Soul 列表（公共接口，无需鉴权） */
export function fetchSouls(params?: {
  page?: number;
  pageSize?: number;
}): Promise<SkillHubSoulListResponse> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString();
  const path = `/api/v1/souls${suffix ? `?${suffix}` : ""}`;
  const cached = soulsListCache.get(path);
  if (cached) return cached;
  const request = publicGet<SkillHubSoulListResponse>(path).catch((error) => {
    soulsListCache.delete(path);
    throw error;
  });
  soulsListCache.set(path, request);
  return request;
}

/** 查询单个 Soul 详情（公共接口） */
export function fetchSoulDetail(slug: string): Promise<SkillHubSoulDetail> {
  return publicGet(`/api/v1/souls/${encodeURIComponent(slug)}`);
}

/** 分页查询 SkillHub 技能包（SkillSet）列表 */
export function fetchSkillSets(params?: {
  keyword?: string;
  scene?: SkillHubSkillSetScene;
  page?: number;
  pageSize?: number;
  lang?: string;
}): Promise<SkillHubSkillSetListResponse> {
  const qs = new URLSearchParams();
  if (params?.keyword?.trim()) qs.set("keyword", params.keyword.trim());
  if (params?.scene) qs.set("scene", params.scene);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  if (params?.lang?.trim()) qs.set("lang", params.lang.trim());
  const suffix = qs.toString();
  return publicGet(`/api/v1/skillsets${suffix ? `?${suffix}` : ""}`);
}

/** 查询单个 SkillHub 技能包详情 */
export function fetchSkillSetDetail(slug: string, params?: { lang?: string }): Promise<SkillHubSkillSetDetail> {
  const lang = params?.lang?.trim();
  const suffix = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  return publicGet(`/api/v1/skillsets/${encodeURIComponent(slug)}${suffix}`);
}

/** 查询单个 Skill 详情，包含 SkillHub 后端维护的展示名称 */
export function fetchSkillDetail(slug: string, params?: { lang?: string }): Promise<SkillHubSkill> {
  const lang = params?.lang?.trim();
  const suffix = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  return publicGet<SkillHubSkillDetailResponse>(`/api/v1/skills/${encodeURIComponent(slug)}${suffix}`)
    .then((response) => response.skill);
}

/** 获取单个 Skill 的文件列表 */
export function fetchSkillFiles(slug: string): Promise<SkillHubSkillFileItem[]> {
  return publicGet<{ files?: SkillHubSkillFileItem[] }>(`/api/v1/skills/${encodeURIComponent(slug)}/files`)
    .then((response) => response.files ?? []);
}

/** 读取单个 Skill 的指定文件内容 */
export async function fetchSkillFile(slug: string, path: string): Promise<string> {
  const requestPath = `/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`;
  const desktop = desktopSkillHubPort();
  if (desktop) {
    const response = await desktop.get(requestPath);
    if (response.status < 200 || response.status >= 300) throw new Error(response.status === 404 ? "file not found" : `${response.status} SkillHub request failed`);
    return new TextDecoder().decode(response.body);
  }
  const res = await fetch(
    `${SKILLHUB_API_BASE}${requestPath}`,
  );
  if (!res.ok) {
    throw new Error(res.status === 404 ? "file not found" : `${res.status} ${res.statusText}`);
  }
  return res.text();
}
