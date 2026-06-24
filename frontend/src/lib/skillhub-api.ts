/**
 * SkillHub 公共数据接口客户端。
 *
 * SkillHub 正式环境是 `https://api.skillhub.cn`，浏览器直连读取公共目录数据：
 * 人设（Soul）。本地开发环境通过 Vite proxy 转发，避免 localhost 不在 CORS
 * 白名单内。
 *
 * 鉴权类接口（活动抽卡 / 我的组合 / 一键安装）需要 SkillHub 的 JWT Cookie，
 * 跨产品场景下要走"mono2 后端代理 + service token"的方案，**不在本模块范围**。
 *
 * 参考：skillhub-git/shared/api/openclaw.ts、skillhub-git/api.md
 */

interface SkillHubRuntimeEnv {
  DEV?: boolean;
}

export function resolveSkillHubApiBase(
  env: SkillHubRuntimeEnv | undefined = import.meta.env,
): string {
  return env?.DEV ? "/__skillhub" : "https://api.skillhub.cn";
}

const SKILLHUB_API_BASE = resolveSkillHubApiBase();

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
