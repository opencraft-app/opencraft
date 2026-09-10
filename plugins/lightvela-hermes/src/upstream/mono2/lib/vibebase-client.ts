// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * Vibebase 客户端 —— 用户级 KV 存储的薄封装。
 *
 * 公网入口：`{authApiBase}/v1/vibebase/namespaces/{ns}/kv/{key}`
 *   - `authApiBase` 来自 `resolveConfiguredAuthApiBaseUrl()`：
 *       国内：https://lightclaw.tech
 *       国际：https://api.lightclaw.site
 *       企业：https://api.lightclaw.cn / https://api.lightvela.com
 *   - `service-gateway` 配置 `prefix: /v1/vibebase` + `rewrite_prefix: /v1` +
 *     `auth_strategy: session`：自动从 cookie 解出 user_id，注入
 *     `X-Lightclaw-User-ID` + `Authorization: Bearer <internal_token>` 后转发到
 *     `vibebase` 服务的 `/v1/namespaces/...`。
 *
 * ⚠️ 部署提示：vibebase 后端及 service-gateway 的 vibebase 路由需要在每个
 *    环境（lightclaw.tech / lightclaw.site / lightclaw.cn / lightvela.tencent.com）
 *    都部署到位，本客户端才能在该环境使用。当前若调用某个未部署 vibebase 的
 *    站点会得到 404 / 502 等响应。
 *
 * 服务端约束（与 vibebase/internal/httpapi/server.go 保持同步）：
 *   - namespace ≤ 128 bytes（utf-8）
 *   - key       ≤ 128 bytes（utf-8）
 *   - value     ≤ 5000 bytes（utf-8）
 *   - per user  ≤ 5000 keys
 *
 * 鉴权：cookie session（`credentials: "include"`）。
 *   - 401：未登录或 session 失效，调用方应弹"请先登录"提示
 *   - 404 in GET：key 不存在 → `getValue` / `getJSON` 返回 null（其他方法保留 404 抛错）
 *   - 409：quota_exceeded（达到 5000 keys 上限）
 *   - 413：value_too_large（> 5000 bytes）
 *
 * 编码：value 走 `text/plain; charset=utf-8`。结构化数据请用 `getJSON` / `setJSON`，
 *      由本模块负责 JSON.stringify / parse 与字节长度校验。
 */

import { resolveConfiguredAuthApiBaseUrl } from "./auth-api-base";
import { readStoredAuthToken } from "../repositories/http-repositories";

/** Vibebase 路径前缀（拼到 `authApiBase` 之后）。 */
const PATH_PREFIX = "/v1/vibebase";

/** value 字节上限，与服务端 `MaxValueBytes` 保持一致。 */
export const VIBEBASE_MAX_VALUE_BYTES = 5000;

/** namespace / key 字节上限，与服务端 `maxNameBytes` 保持一致。 */
export const VIBEBASE_MAX_NAME_BYTES = 128;

/** Vibebase API 错误。`status === 0` 表示网络异常（fetch 直接失败）。 */
export class VibebaseError extends Error {
  readonly status: number;
  /** 服务端返回的 `error` code（如 `"value_too_large"`），无则为空串。 */
  readonly code: string;
  readonly namespace?: string;
  readonly key?: string;
  constructor(
    message: string,
    status: number,
    code: string,
    namespace?: string,
    key?: string,
  ) {
    super(message);
    this.name = "VibebaseError";
    this.status = status;
    this.code = code;
    this.namespace = namespace;
    this.key = key;
  }
  /** 是否未登录 / session 失效 —— 常用来切到"请先登录"态。 */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
  /** 是否 key 不存在（仅 GET 才有意义）。 */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** 服务端 Entry（与 `vibebase/internal/store/store.go` `type Entry` 同步）。 */
export interface VibebaseEntry {
  namespace: string;
  key: string;
  value?: string;
  size: number;
  /** ISO 时间字符串（Go `time.Time` 序列化结果）。前端如需毫秒数自行 `new Date(updatedAt).getTime()`。 */
  updatedAt: string;
}

/** PUT 响应：包含 created 标志。 */
export interface VibebasePutResult {
  namespace: string;
  key: string;
  size: number;
  updatedAt: string;
  /** true = 首次写入（HTTP 201），false = 更新已存在的 key（HTTP 200）。 */
  created: boolean;
}

/** list 响应。`nextCursor === ""` 表示已经是最后一页。 */
export interface VibebaseListPage {
  items: VibebaseEntry[];
  nextCursor: string;
}

interface RawEntry {
  namespace: string;
  key: string;
  value?: string;
  size: number;
  updated_at: string;
}

interface RawPutResult extends RawEntry {
  created: boolean;
}

interface RawListResponse {
  items: RawEntry[];
  next_cursor: string;
}

interface RawError {
  error?: string;
}

function entryFromRaw(raw: RawEntry): VibebaseEntry {
  return {
    namespace: raw.namespace,
    key: raw.key,
    value: raw.value,
    size: raw.size,
    updatedAt: raw.updated_at,
  };
}

/**
 * 解析 baseUrl，拼上 vibebase 前缀。
 * 抛 `VibebaseError` 时调用方应静默退化（多见于本地 mock 模式：env=mock）。
 */
function resolveVibebaseBase(): string {
  const base = resolveConfiguredAuthApiBaseUrl();
  if (base === null) {
    throw new VibebaseError(
      "vibebase: api base unavailable (mock mode)",
      0,
      "no_api_base",
    );
  }
  // base === "" → 走 vite proxy，前端同源直发，path 必须保留前导斜杠
  return `${base}${PATH_PREFIX}`;
}

/** 把 namespace / key 拼进 URL，必须 encode 防止特殊字符炸路由。 */
function buildKvUrl(namespace: string, key?: string, query?: string): string {
  const root = `${resolveVibebaseBase()}/namespaces/${encodeURIComponent(namespace)}`;
  const path = key === undefined
    ? `${root}/kv`
    : `${root}/kv/${encodeURIComponent(key)}`;
  return query ? `${path}?${query}` : path;
}

/** 计算 utf-8 字节长度，用于客户端预校验，避免无谓的网络请求。 */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function validateName(kind: "namespace" | "key", name: string): void {
  if (!name) {
    throw new VibebaseError(`${kind} is required`, 0, `${kind}_required`);
  }
  if (utf8ByteLength(name) > VIBEBASE_MAX_NAME_BYTES) {
    throw new VibebaseError(
      `${kind} too large (max ${VIBEBASE_MAX_NAME_BYTES} bytes)`,
      0,
      `${kind}_too_large`,
    );
  }
}

/** 解析错误响应体，提取 `error` code（解析失败回退到状态码文案）。 */
async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as RawError;
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}

interface RequestContext {
  namespace: string;
  key?: string;
}

/**
 * 统一 fetch + 错误处理。
 * - 网络异常（TypeError 等）→ `VibebaseError(status=0)`
 * - 非 2xx → `VibebaseError(status=res.status)`，code 取响应体 `error` 字段
 */
async function fetchVibebase(
  url: string,
  init: RequestInit,
  ctx: RequestContext,
): Promise<Response> {
  let res: Response;
  try {
    const headers = new Headers(init.headers);
    const authToken = readStoredAuthToken();
    if (authToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }
    res = await fetch(url, { ...init, headers, credentials: "include" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new VibebaseError(
      `vibebase network error: ${msg}`,
      0,
      "network_error",
      ctx.namespace,
      ctx.key,
    );
  }
  if (!res.ok) {
    const code = await readErrorCode(res);
    throw new VibebaseError(
      `vibebase ${init.method ?? "GET"} ${ctx.namespace}${ctx.key ? `/${ctx.key}` : ""} failed: ${res.status} ${code}`,
      res.status,
      code,
      ctx.namespace,
      ctx.key,
    );
  }
  return res;
}

// ─── 原始 KV 操作（value 是 string） ────────────────────────────────────────────

/**
 * 读取一个 key。
 * @returns 不存在时返回 null（404 不抛错）
 */
export async function getValue(
  namespace: string,
  key: string,
): Promise<VibebaseEntry | null> {
  validateName("namespace", namespace);
  validateName("key", key);
  try {
    const res = await fetchVibebase(
      buildKvUrl(namespace, key),
      { method: "GET" },
      { namespace, key },
    );
    const raw = (await res.json()) as RawEntry;
    return entryFromRaw(raw);
  } catch (err) {
    if (err instanceof VibebaseError && err.isNotFound) return null;
    throw err;
  }
}

/**
 * 写入 / 覆盖一个 key。
 * @throws `VibebaseError(status=413, code="value_too_large")` 当 value > 5000 字节
 * @throws `VibebaseError(status=409, code="quota_exceeded")` 当达到 5000 keys 上限
 */
export async function setValue(
  namespace: string,
  key: string,
  value: string,
): Promise<VibebasePutResult> {
  validateName("namespace", namespace);
  validateName("key", key);
  // 客户端预校验：节省一次往返，且更早暴露问题
  if (utf8ByteLength(value) > VIBEBASE_MAX_VALUE_BYTES) {
    throw new VibebaseError(
      `value too large (max ${VIBEBASE_MAX_VALUE_BYTES} bytes)`,
      413,
      "value_too_large",
      namespace,
      key,
    );
  }
  const res = await fetchVibebase(
    buildKvUrl(namespace, key),
    {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: value,
    },
    { namespace, key },
  );
  const raw = (await res.json()) as RawPutResult;
  return {
    namespace: raw.namespace,
    key: raw.key,
    size: raw.size,
    updatedAt: raw.updated_at,
    created: raw.created,
  };
}

/**
 * 删除一个 key。
 * @returns 是否真的删除（false = key 本来就不存在）
 */
export async function deleteValue(
  namespace: string,
  key: string,
): Promise<boolean> {
  validateName("namespace", namespace);
  validateName("key", key);
  try {
    await fetchVibebase(
      buildKvUrl(namespace, key),
      { method: "DELETE" },
      { namespace, key },
    );
    return true;
  } catch (err) {
    if (err instanceof VibebaseError && err.isNotFound) return false;
    throw err;
  }
}

/**
 * 列出 namespace 下的 key（单页）。需要翻页就传 `cursor = page.nextCursor`。
 * 服务端 `limit` 上限 100。
 */
export async function listKeys(
  namespace: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<VibebaseListPage> {
  validateName("namespace", namespace);
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const res = await fetchVibebase(
    buildKvUrl(namespace, undefined, params.toString() || undefined),
    { method: "GET" },
    { namespace },
  );
  const raw = (await res.json()) as RawListResponse;
  return {
    items: (raw.items ?? []).map(entryFromRaw),
    nextCursor: raw.next_cursor ?? "",
  };
}

// ─── JSON 便利方法 ──────────────────────────────────────────────────────────────

/**
 * 读取一个 JSON 序列化的 key。
 * @returns 不存在 / 解析失败 → null
 */
export async function getJSON<T>(
  namespace: string,
  key: string,
): Promise<T | null> {
  const entry = await getValue(namespace, key);
  if (!entry || entry.value === undefined) return null;
  try {
    return JSON.parse(entry.value) as T;
  } catch {
    // 旧数据格式不兼容 → 当作没有，不抛
    // eslint-disable-next-line no-console
    console.warn(
      `[vibebase] failed to parse JSON for ${namespace}/${key}, treating as absent`,
    );
    return null;
  }
}

/**
 * 写入一个 JSON 序列化的 key。
 * @throws 同 setValue，且 stringify 后超过 5000 字节会在客户端就抛 413
 */
export async function setJSON<T>(
  namespace: string,
  key: string,
  data: T,
): Promise<VibebasePutResult> {
  return setValue(namespace, key, JSON.stringify(data));
}
