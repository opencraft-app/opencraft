/**
 * 用户反馈 - ticket MySQL 上传客户端
 * ──────────────────────────────────────────────────────────────
 * 架构变更（相比旧版）：
 * 反馈主记录与附件都由 ticket 写入 MySQL，避免浏览器篡改 accountId/site/status。
 * 后台列表：GET /support/feedback/list
 * 后台附件：GET /support/feedback/attachment/:id
 *
 * 鉴权：依赖登录态（cookie session），与 /tickets 一致。
 */

import { resolveConfiguredAuthApiBaseUrl, resolveSupportAdminApiBaseUrl } from '@/lib/auth-api-base';
import { isGlobal } from '@/lib/region';

const SUPPORT_API_PREFIX = '/support';
const SUPPORT_FEEDBACK_SUBMIT_TIMEOUT_MS = 30_000;

export interface SupportCosConfig {
  bucket: string;
  region: string;
  prefix: string;
}

export type FeedbackStatus = 'open' | 'reviewing' | 'resolved';
export type FeedbackSite = 'cn' | 'global';

/** 当前上线的反馈站点标识；避免魔法字符串直接散落在调用处。 */
export const FEEDBACK_SITE_CN = 'cn' as const satisfies FeedbackSite;
export const FEEDBACK_SITE_GLOBAL = 'global' as const satisfies FeedbackSite;

export interface FeedbackAttachmentRecord {
  fileName: string;
  contentType: string;
  size: number;
  storageKey: string;
}

/** 用户画像（调研问卷，可选填写；仅收集高信号字段）。 */
export interface SupportFeedbackProfile {
  /** 从哪里了解到 LightVela */
  source: string;
  /** 角色/身份 */
  role: string;
  /** 希望用 AI 做什么 */
  aiGoal: string;
  /** 使用频率（活跃度画像） */
  frequency: string;
  /** 所在行业（行业画像） */
  industry: string;
}

/** 反馈大类：建议/反馈（带用户画像）或 Bug（带排障信息）。 */
export type FeedbackCategory = 'suggestion' | 'bug';

/** Bug 类反馈的排障信息（关键排查字段）。 */
export interface SupportBugInfo {
  /** 发生频率 */
  frequency: string;
  /** 期望结果 */
  expected: string;
}

export interface SupportFeedbackRecord {
  id: string;
  accountId: string;
  feedbackType: string;
  otherText: string | null;
  description: string;
  subject: string;
  status: FeedbackStatus;
  source: 'support-page';
  site: FeedbackSite;
  createdAt: string;
  updatedAt: string;
  attachments: FeedbackAttachmentRecord[];
  contactInfo: string | null;
  profile?: SupportFeedbackProfile | null;
  /** 反馈大类（suggestion / bug），用于前端分流与后台筛选。 */
  category?: FeedbackCategory | null;
  /** Bug 类排障信息，仅 category==='bug' 时有意义。 */
  bugInfo?: SupportBugInfo | null;
}

/**
 * 反馈系统是否可用（取决于后端 API base 是否可达）。
 * 旧版依赖 NEXT_PUBLIC_COS_* 明文密钥，现已移除——前端不再持有任何 COS 凭证。
 * 主站提交链或 admin 后台链任一可达即视为可用。
 */
export function isSupportCosConfigured(): boolean {
  return resolveConfiguredAuthApiBaseUrl() !== null || resolveSupportAdminApiBaseUrl() !== null;
}

/**
 * 兼容旧调用：返回最小配置占位（bucket/region 现由后端决定）。
 * 后端不可达时返回 null，调用方据此展示「未配置」提示。
 */
export function getSupportCosConfig(): SupportCosConfig | null {
  if (!isSupportCosConfigured()) {
    return null;
  }
  return { bucket: '', region: '', prefix: 'support-feedback' };
}

export function getCurrentFeedbackSite(): FeedbackSite {
  return isGlobal ? FEEDBACK_SITE_GLOBAL : FEEDBACK_SITE_CN;
}

function supportApiBase(): string {
  const base = resolveConfiguredAuthApiBaseUrl();
  if (base === null) {
    throw new Error('反馈系统未配置：缺少后端 API 地址');
  }
  return `${base}${SUPPORT_API_PREFIX}`;
}

/** 反馈后台 base（list/sign），经 admin.lightclaw.tech 暴露。 */
function supportAdminApiBase(): string {
  const base = resolveSupportAdminApiBaseUrl();
  if (base === null) {
    throw new Error('反馈后台未配置：缺少后台 API 地址');
  }
  return `${base}${SUPPORT_API_PREFIX}`;
}

export interface CreateSupportFeedbackInput {
  accountId: string;
  feedbackType: string;
  otherText?: string | null;
  description: string;
  files?: File[];
  contactInfo?: string | null;
  profile?: SupportFeedbackProfile | null;
  category?: FeedbackCategory | null;
  bugInfo?: SupportBugInfo | null;
}

/**
 * 提交反馈：由 ticket 后端把主记录和附件一起写入 MySQL。
 */
export async function createSupportFeedback(
  input: CreateSupportFeedbackInput,
): Promise<SupportFeedbackRecord> {
  const base = supportApiBase();
  const site = getCurrentFeedbackSite();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SUPPORT_FEEDBACK_SUBMIT_TIMEOUT_MS);

  const body = new FormData();
  body.set('site', site);
  body.set('feedbackType', input.feedbackType.trim());
  body.set('otherText', input.otherText?.trim() ? input.otherText.trim() : '');
  body.set('description', input.description.trim());
  body.set('contactInfo', input.contactInfo?.trim() ? input.contactInfo.trim() : '');
  body.set('category', input.category ?? '');
  if (input.profile && hasProfile(input.profile)) {
    body.set('profile', JSON.stringify(input.profile));
  }
  if (input.bugInfo) {
    body.set('bugInfo', JSON.stringify(input.bugInfo));
  }
  for (const file of input.files ?? []) {
    body.append('attachments', file, file.name);
  }

  try {
    const res = await fetch(`${base}/feedback/submit`, {
      method: 'POST',
      credentials: 'include',
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error('反馈提交失败，请稍后重试');
    }

    return (await res.json()) as SupportFeedbackRecord;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('反馈提交超时，请检查网络或稍后重试');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function hasProfile(p: SupportFeedbackProfile): boolean {
  return Boolean(
    p.source?.trim()
    || p.role?.trim()
    || p.aiGoal?.trim()
    || p.frequency?.trim()
    || p.industry?.trim(),
  );
}

/**
 * 后台列表：由后端服务端聚合 COS 记录，前端不再直读 COS。
 */
export async function listSupportFeedback(): Promise<SupportFeedbackRecord[]> {
  const base = supportAdminApiBase();
  const site = getCurrentFeedbackSite();
  const res = await fetch(`${base}/feedback/list?site=${encodeURIComponent(site)}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error('读取反馈列表失败');
  }
  const data = (await res.json()) as { items: SupportFeedbackRecord[] };
  return (data.items ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 后台附件：向后端申请短期下载签名 URL。
 * 注意：现返回 Promise（需 await），调用方拿到 string | null。
 */
export async function getSignedAttachmentUrl(storageKey: string): Promise<string | null> {
  try {
    const base = supportAdminApiBase();
    const res = await fetch(`${base}/feedback/sign?id=${encodeURIComponent(storageKey)}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { url: string };
    return data.url ?? null;
  } catch {
    return null;
  }
}
