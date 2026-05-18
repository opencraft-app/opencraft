/**
 * SkillHub 公共数据接口客户端。
 *
 * SkillHub 后端 (`https://api.skillhub.cn`) 已为 `https://lightclaw.tech` 加好
 * CORS 白名单（`Access-Control-Allow-Origin` 反射 + `Allow-Credentials: true`），
 * 所以浏览器可以直连读取**公共目录数据**：人设（Soul）+ 技能包（SkillSet）。
 *
 * 鉴权类接口（活动抽卡 / 我的组合 / 一键安装）需要 SkillHub 的 JWT Cookie，
 * 跨产品场景下要走"mono2 后端代理 + service token"的方案，**不在本模块范围**。
 *
 * 参考：skillhub-git/shared/api/openclaw.ts、skillhub-git/api.md
 */

const SKILLHUB_API_BASE = "https://api.skillhub.cn";

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

/** SkillSet 列表项 */
export interface SkillHubSkillSet {
  id: number;
  slug: string;
  displayName: string;
  summary: string;
  remark: string;
  scene?: string;
  subScene?: string;
  createdAt: number;
  updatedAt: number;
}

/** SkillSet 详情 */
export interface SkillHubSkillSetDetail extends SkillHubSkillSet {
  /** 工作流配置正文，markdown + YAML frontmatter */
  content: string;
  /** 包含的子技能 slug 列表 */
  skillSlugs: string[];
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

/** 分页查询 SkillSet 列表（公共接口） */
export function fetchSkillSets(params?: {
  page?: number;
  pageSize?: number;
}): Promise<SkillHubSkillSetListResponse> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const suffix = qs.toString();
  return publicGet(`/api/v1/skillsets${suffix ? `?${suffix}` : ""}`);
}

/** 查询单个 SkillSet 详情（公共接口） */
export function fetchSkillSetDetail(slug: string): Promise<SkillHubSkillSetDetail> {
  return publicGet(`/api/v1/skillsets/${encodeURIComponent(slug)}`);
}
