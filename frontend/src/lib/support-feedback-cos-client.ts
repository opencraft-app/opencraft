/**
 * 用户反馈 - COS 上传客户端（后端预签名模式）
 * ──────────────────────────────────────────────────────────────
 * 架构变更（相比旧版）：
 *   - 旧版：浏览器直接用 cos-js-sdk-v5 + NEXT_PUBLIC_COS_SECRET_KEY 上传，
 *           永久密钥暴露在客户端 bundle，任何访客都能拿到。
 *   - 新版：上传/读取权限一律由 ticket 后端（持有私有密钥）通过预签名 URL 下发。
 *           浏览器只拿到「短时有效的上传/下载链接」，永远不接触 SecretKey。
 *
 * 流程：
 *   提交：POST /support/feedback/presign → 拿到 record + 各附件的预签名 PUT URL
 *        → 浏览器直接 PUT 内容到 COS（不经过后端流量）
 *   后台列表：GET /support/feedback/list（后端服务端聚合 COS 记录）
 *   后台附件：GET /support/feedback/sign?key= → 拿短期下载链接
 *
 * 鉴权：依赖登录态（cookie session），与 /tickets 一致。
 */

import { resolveConfiguredAuthApiBaseUrl, resolveSupportAdminApiBaseUrl } from '@/lib/auth-api-base';
import { isGlobal } from '@/lib/region';

const SUPPORT_API_PREFIX = '/support';

export interface SupportCosConfig {
  bucket: string;
  region: string;
  prefix: string;
}

export type FeedbackStatus = 'open' | 'reviewing' | 'resolved';
export type FeedbackSite = 'cn' | 'global';

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
  return isGlobal ? 'global' : 'cn';
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

function buildSubject(description: string): string {
  const firstLine = description.trim().split(/\r?\n/, 1)[0] || description.trim();
  return firstLine.slice(0, 80);
}

interface PresignTarget {
  fileName?: string;
  key: string;
  uploadUrl: string;
}

interface PresignResponse {
  id: string;
  record: PresignTarget;
  attachments: PresignTarget[];
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
 * 提交反馈：向后端申请预签名 URL → 浏览器直传 COS。
 * 前端全程不持有 COS 密钥。
 */
export async function createSupportFeedback(
  input: CreateSupportFeedbackInput,
): Promise<SupportFeedbackRecord> {
  const base = supportApiBase();
  const site = getCurrentFeedbackSite();

  const presignRes = await fetch(`${base}/feedback/presign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      site,
      attachmentFileNames: (input.files ?? []).map((file) => file.name),
    }),
  });
  if (!presignRes.ok) {
    throw new Error('获取上传签名失败，请稍后重试');
  }
  const presign = (await presignRes.json()) as PresignResponse;

  // 1) 上传附件（按文件名顺序对应后端返回的预签名 URL）
  const attachments: FeedbackAttachmentRecord[] = [];
  const files = input.files ?? [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const target = presign.attachments[i];
    if (!target) continue;
    const putRes = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!putRes.ok) {
      throw new Error('附件上传失败，请重试');
    }
    attachments.push({
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      storageKey: target.key,
    });
  }

  // 2) 组装并上传记录 JSON
  const now = new Date().toISOString();
  const record: SupportFeedbackRecord = {
    id: presign.id,
    accountId: input.accountId.trim(),
    feedbackType: input.feedbackType.trim(),
    otherText: input.otherText?.trim() ? input.otherText.trim() : null,
    description: input.description.trim(),
    subject: buildSubject(input.description),
    status: 'open',
    source: 'support-page',
    site,
    createdAt: now,
    updatedAt: now,
    attachments,
    contactInfo: input.contactInfo?.trim() ? input.contactInfo.trim() : null,
    profile: input.profile && hasProfile(input.profile) ? input.profile : null,
    category: input.category ?? null,
    bugInfo: input.bugInfo ?? null,
  };

  const recordRes = await fetch(presign.record.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(record, null, 2),
  });
  if (!recordRes.ok) {
    throw new Error('反馈记录上传失败，请重试');
  }

  return record;
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
    const res = await fetch(`${base}/feedback/sign?key=${encodeURIComponent(storageKey)}`, {
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
