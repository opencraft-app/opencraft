/**
 * SkillHub 公共数据接口客户端。
 *
 * SkillHub 后端 (`https://lightmake.cloud`) 已为 lightclaw.tech 和 EO Pages
 * 预览域名（如 *.edgeone.cool）做好 CORS 反射（`Access-Control-Allow-Origin`
 * 反射 + `Allow-Credentials: true`），所以浏览器可以直连读取**公共目录数据**：
 * 人设（Soul）。本地开发环境通过 Vite proxy 转发，避免 localhost 不在 CORS
 * 白名单内。
 *
 * 注：原来用的 `https://api.skillhub.cn` CORS 白名单只覆盖 lightclaw.tech，
 * EO 预览域名不在内（不反射 ACAO），切到 lightmake.cloud。
 *
 * 鉴权类接口（活动抽卡 / 我的组合 / 一键安装）需要 SkillHub 的 JWT Cookie，
 * 跨产品场景下要走"mono2 后端代理 + service token"的方案，**不在本模块范围**。
 *
 * 参考：skillhub-git/shared/api/openclaw.ts、skillhub-git/api.md
 */

const SKILLHUB_API_BASE = import.meta.env.DEV ? "/__skillhub" : "https://lightmake.cloud";

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

export type SkillHubSkillSetScene =
  | "academic"
  | "design"
  | "ecommerce"
  | "education"
  | "finance"
  | "healthcare"
  | "hr"
  | "legal"
  | "marketing"
  | "media"
  | "tech";

/** SkillHub 技能包列表项（SkillSet） */
export interface SkillHubSkillSet {
  id: number;
  slug: string;
  displayName: string;
  summary: string;
  remark: string;
  skillCount?: number;
  skillSlugs?: string[];
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

// ─── 请求工具 ───────────────────────────────────────────────────────────────

async function publicGet<T>(path: string): Promise<T> {
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
  return publicGet(`/api/v1/souls${suffix ? `?${suffix}` : ""}`);
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
}): Promise<SkillHubSkillSetListResponse> {
  const qs = new URLSearchParams();
  if (params?.keyword?.trim()) qs.set("keyword", params.keyword.trim());
  if (params?.scene) qs.set("scene", params.scene);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString();
  return publicGet(`/api/v1/skillsets${suffix ? `?${suffix}` : ""}`);
}

/** 查询单个 SkillHub 技能包详情 */
export function fetchSkillSetDetail(slug: string): Promise<SkillHubSkillSetDetail> {
  return publicGet(`/api/v1/skillsets/${encodeURIComponent(slug)}`);
}
