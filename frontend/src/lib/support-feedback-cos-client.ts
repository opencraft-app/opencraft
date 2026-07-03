/**
 * 用户反馈 - COS 浏览器直传客户端
 * ──────────────────────────────────────────────────────────────
 * 架构：静态站点直接使用 cos-js-sdk-v5 与腾讯云 COS 通讯
 *   - 用户反馈页 putObject 上传 JSON + 附件
 *   - 后台查询页 getBucket + getObject 列出并展示
 *
 * ⚠️ 安全提示：
 *   - 此模块运行在浏览器，暴露的凭证任何访问站点的人都能拿到
 *   - 生产环境请务必换成 STS 临时凭证签发或最小权限子账号
 *   - 桶保持"私有读写"，通过前端 SDK 携带签名请求
 */

import CosSdk from 'cos-js-sdk-v5';
import type COS from 'cos-js-sdk-v5';

import { isGlobal } from '@/lib/region';

const NEXT_PUBLIC_COS_BUCKET = process.env.NEXT_PUBLIC_SUPPORT_COS_BUCKET;
const NEXT_PUBLIC_COS_REGION = process.env.NEXT_PUBLIC_SUPPORT_COS_REGION;
const NEXT_PUBLIC_COS_SECRET_ID = process.env.NEXT_PUBLIC_SUPPORT_COS_SECRET_ID;
const NEXT_PUBLIC_COS_SECRET_KEY = process.env.NEXT_PUBLIC_SUPPORT_COS_SECRET_KEY;
const NEXT_PUBLIC_COS_PREFIX = (process.env.NEXT_PUBLIC_SUPPORT_COS_PREFIX ?? 'support-feedback')
  .replace(/^\/+|\/+$/g, '');

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
}

let cachedClient: COS | null = null;

export function getSupportCosConfig(): SupportCosConfig | null {
  if (!NEXT_PUBLIC_COS_BUCKET || !NEXT_PUBLIC_COS_REGION) {
    return null;
  }
  return {
    bucket: NEXT_PUBLIC_COS_BUCKET,
    region: NEXT_PUBLIC_COS_REGION,
    prefix: NEXT_PUBLIC_COS_PREFIX,
  };
}

export function isSupportCosConfigured(): boolean {
  return Boolean(
    NEXT_PUBLIC_COS_BUCKET
      && NEXT_PUBLIC_COS_REGION
      && NEXT_PUBLIC_COS_SECRET_ID
      && NEXT_PUBLIC_COS_SECRET_KEY,
  );
}

export function getCurrentFeedbackSite(): FeedbackSite {
  return isGlobal ? 'global' : 'cn';
}

function ensureClient(): COS {
  if (!isSupportCosConfigured()) {
    throw new Error('反馈系统未配置：请设置 NEXT_PUBLIC_SUPPORT_COS_* 环境变量');
  }
  if (!cachedClient) {
    cachedClient = new CosSdk({
      SecretId: NEXT_PUBLIC_COS_SECRET_ID as string,
      SecretKey: NEXT_PUBLIC_COS_SECRET_KEY as string,
    });
  }
  return cachedClient;
}

function generateId(): string {
  const rand = crypto.getRandomValues(new Uint8Array(12));
  const hex = Array.from(rand, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `fb_${hex}`;
}

function buildSubject(description: string): string {
  const firstLine = description.trim().split(/\r?\n/, 1)[0] || description.trim();
  return firstLine.slice(0, 80);
}

function safeFileName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'attachment'
  );
}

function getScopedPrefix(prefix: string, site: FeedbackSite): string {
  return `${prefix}/${site}`;
}

function getRecordKey(id: string, prefix: string, site: FeedbackSite): string {
  return `${getScopedPrefix(prefix, site)}/records/${id}.json`;
}

function getAttachmentKey(id: string, fileName: string, prefix: string, site: FeedbackSite): string {
  return `${getScopedPrefix(prefix, site)}/attachments/${id}/${Date.now()}-${safeFileName(fileName)}`;
}

function detectSiteFromKey(key: string, prefix: string): FeedbackSite {
  return key.startsWith(`${prefix}/global/`) ? 'global' : 'cn';
}

function normalizeAttachmentRecord(raw: unknown): FeedbackAttachmentRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const attachment = raw as Partial<FeedbackAttachmentRecord>;
  if (!attachment.storageKey || typeof attachment.storageKey !== 'string') return null;

  return {
    fileName: typeof attachment.fileName === 'string' && attachment.fileName.trim()
      ? attachment.fileName
      : 'attachment',
    contentType: typeof attachment.contentType === 'string' && attachment.contentType.trim()
      ? attachment.contentType
      : 'application/octet-stream',
    size: typeof attachment.size === 'number' && Number.isFinite(attachment.size)
      ? attachment.size
      : 0,
    storageKey: attachment.storageKey,
  };
}

function normalizeFeedbackRecord(raw: unknown, fallbackSite: FeedbackSite): SupportFeedbackRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<SupportFeedbackRecord>;
  if (!record.id || typeof record.id !== 'string') return null;
  if (!record.accountId || typeof record.accountId !== 'string') return null;
  if (!record.feedbackType || typeof record.feedbackType !== 'string') return null;
  if (!record.description || typeof record.description !== 'string') return null;

  const createdAt = typeof record.createdAt === 'string' && record.createdAt
    ? record.createdAt
    : new Date().toISOString();
  const status: FeedbackStatus = record.status === 'reviewing' || record.status === 'resolved'
    ? record.status
    : 'open';
  const site: FeedbackSite = record.site === 'global' || record.site === 'cn'
    ? record.site
    : fallbackSite;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.map(normalizeAttachmentRecord).filter((item): item is FeedbackAttachmentRecord => item !== null)
    : [];

  return {
    id: record.id,
    accountId: record.accountId.trim(),
    feedbackType: record.feedbackType.trim(),
    otherText: typeof record.otherText === 'string' && record.otherText.trim() ? record.otherText.trim() : null,
    description: record.description,
    subject: typeof record.subject === 'string' && record.subject.trim()
      ? record.subject
      : buildSubject(record.description),
    status,
    source: 'support-page',
    site,
    createdAt,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : createdAt,
    attachments,
    contactInfo: typeof record.contactInfo === 'string' && record.contactInfo.trim()
      ? record.contactInfo.trim()
      : null,
  };
}

async function putObject(
  client: COS,
  config: SupportCosConfig,
  key: string,
  body: File | Blob,
  contentType?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.putObject(
      {
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

async function listKeysByPrefix(
  client: COS,
  config: SupportCosConfig,
  prefix: string,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    client.getBucket(
      {
        Bucket: config.bucket,
        Region: config.region,
        Prefix: prefix,
        MaxKeys: 1000,
      },
      (error, data) => {
        if (error) {
          reject(error);
          return;
        }
        const list = (data?.Contents || [])
          .map((item) => item?.Key)
          .filter((key): key is string => Boolean(key));
        resolve(list);
      },
    );
  });
}

export interface CreateSupportFeedbackInput {
  accountId: string;
  feedbackType: string;
  otherText?: string | null;
  description: string;
  files?: File[];
  contactInfo?: string | null;
}

export async function createSupportFeedback(
  input: CreateSupportFeedbackInput,
): Promise<SupportFeedbackRecord> {
  const config = getSupportCosConfig();
  if (!config) {
    throw new Error('反馈系统未配置：缺少 COS bucket/region');
  }
  const client = ensureClient();
  const id = generateId();
  const now = new Date().toISOString();
  const site = getCurrentFeedbackSite();

  const attachments: FeedbackAttachmentRecord[] = [];
  for (const file of input.files ?? []) {
    const storageKey = getAttachmentKey(id, file.name, config.prefix, site);
    await putObject(client, config, storageKey, file, file.type || 'application/octet-stream');
    attachments.push({
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      storageKey,
    });
  }

  const record: SupportFeedbackRecord = {
    id,
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
  };

  const recordBlob = new Blob([JSON.stringify(record, null, 2)], {
    type: 'application/json',
  });
  await putObject(
    client,
    config,
    getRecordKey(id, config.prefix, site),
    recordBlob,
    'application/json; charset=utf-8',
  );

  return record;
}

async function getObjectAsText(
  client: COS,
  config: SupportCosConfig,
  key: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    client.getObject(
      {
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      },
      (error, data) => {
        if (error) {
          reject(error);
          return;
        }
        const body = (data as { Body?: unknown })?.Body;
        if (typeof body === 'string') {
          resolve(body);
          return;
        }
        if (body instanceof Blob) {
          body.text().then(resolve, reject);
          return;
        }
        resolve(String(body ?? ''));
      },
    );
  });
}

export async function listSupportFeedback(): Promise<SupportFeedbackRecord[]> {
  const config = getSupportCosConfig();
  if (!config) {
    throw new Error('反馈系统未配置：缺少 COS bucket/region');
  }
  const client = ensureClient();
  const site = getCurrentFeedbackSite();
  const prefixes = site === 'global'
    ? [`${config.prefix}/global/records/`]
    : [`${config.prefix}/cn/records/`, `${config.prefix}/records/`];

  const keys = Array.from(
    new Set((await Promise.all(prefixes.map((prefix) => listKeysByPrefix(client, config, prefix)))).flat()),
  );

  const records = await Promise.all(
    keys.map(async (key) => {
      const raw = await getObjectAsText(client, config, key);
      const normalized = normalizeFeedbackRecord(JSON.parse(raw) as unknown, detectSiteFromKey(key, config.prefix));
      return normalized;
    }),
  );

  return records
    .filter((record): record is SupportFeedbackRecord => record !== null)
    .filter((record) => record.site === site)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getSignedAttachmentUrl(storageKey: string): string | null {
  const config = getSupportCosConfig();
  if (!config) return null;
  try {
    const client = ensureClient();
    return client.getObjectUrl({
      Bucket: config.bucket,
      Region: config.region,
      Key: storageKey,
      Sign: true,
      Expires: 900,
    } as unknown as Parameters<COS['getObjectUrl']>[0]) as unknown as string;
  } catch {
    return null;
  }
}
