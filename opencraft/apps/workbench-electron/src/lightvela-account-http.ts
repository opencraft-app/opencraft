import type { DesktopLoginSession } from "./lightvela-login.js";

const bases = { cn: "https://api.lightvela.com", intl: "https://api.lightvela.ai" };
class DesktopAccountRequestError extends Error {}

/** IPC exposes only allowlisted explanations, never a URL, body or fetch cause. */
export function desktopAccountPublicError(error: unknown): Error {
  if (error instanceof DesktopAccountRequestError) return new Error(error.message);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Error("账号请求超时，请检查网络后重试；Bot 管理操作请先刷新列表核对结果。");
  }
  return new Error("无法连接账号服务，请检查网络后重试。");
}
export interface DesktopAccountRequest {
  url: string;
  method: string;
  contentType?: string;
  body?: Uint8Array;
}

/** Account control-plane requests only; this is not an arbitrary network proxy. */
export function validateDesktopAccountRequest(input: DesktopAccountRequest, session: DesktopLoginSession): URL {
  if (!input || typeof input.url !== "string" || typeof input.method !== "string") throw new DesktopAccountRequestError("账号请求格式无效。");
  let url: URL;
  try { url = new URL(input.url); } catch { throw new DesktopAccountRequestError("账号请求地址无效。"); }
  const method = input.method.toUpperCase();
  if (url.origin !== bases[session.region] || url.username || url.password || url.hash) throw new DesktopAccountRequestError("账号站点不匹配，请使用此实例所属站点的账号登录。");
  const instancePath = /^\/v1\/instances\/[a-zA-Z0-9_-]+$/;
  const botCollection = /^\/v1\/instances\/[a-zA-Z0-9_-]+\/bots$/;
  const botItem = /^\/v1\/instances\/[a-zA-Z0-9_-]+\/bots\/[a-zA-Z0-9_-]+$/;
  const isBotRequest = botCollection.test(url.pathname) || botItem.test(url.pathname);
  const allowed = (method === "GET" && (["/auth/profile", "/subscriptions/current", "/v1/passes", "/v1/instances"].includes(url.pathname) || instancePath.test(url.pathname)))
    || (method === "PUT" && url.pathname === "/auth/profile")
    || (method === "POST" && (url.pathname === "/v1/instances" || url.pathname === "/auth/profile/avatar" || /^\/v1\/instances\/[^/]+\/(tat\/session|config\/reset)$/.test(url.pathname)))
    || ((method === "GET" || method === "POST") && botCollection.test(url.pathname))
    || ((method === "PUT" || method === "DELETE") && botItem.test(url.pathname));
  if (!allowed || (input.body !== undefined && (!(input.body instanceof Uint8Array) || input.body.byteLength > 8 * 1024 * 1024))) throw new DesktopAccountRequestError("桌面客户端不支持此账号操作，请更新客户端后重试。");
  if (input.contentType !== undefined && (typeof input.contentType !== "string" || input.contentType.length > 300 || /[\r\n]/.test(input.contentType))) throw new DesktopAccountRequestError("账号请求内容类型无效。");
  if (isBotRequest) {
    const invalid = () => new DesktopAccountRequestError("Bot 管理请求格式无效。");
    if (url.search || input.url !== url.href) throw invalid();
    if (method === "GET" || method === "DELETE") {
      if (input.body !== undefined) throw invalid();
    } else {
      if (input.contentType !== "application/json" || !input.body) throw invalid();
      let body: Record<string, unknown>;
      try { body = JSON.parse(new TextDecoder().decode(input.body)); } catch { throw invalid(); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
      const validName = typeof body.name === "string" && [...body.name.trim()].length >= 1 && [...body.name.trim()].length <= 60;
      if (method === "POST") {
        if (!validName || Object.keys(body).some(key => !["name", "create_mode", "source_bot_id"].includes(key))) throw invalid();
        if (body.create_mode === "blank") { if (body.source_bot_id !== undefined) throw invalid(); }
        else if (body.create_mode !== "clone" || typeof body.source_bot_id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(body.source_bot_id)) throw invalid();
      } else if (!Object.keys(body).length || Object.keys(body).some(key => !["name", "description"].includes(key))
        || (body.name !== undefined && !validName) || (body.description !== undefined && typeof body.description !== "string")) throw invalid();
    }
  }
  if (method === "POST" && url.pathname === "/v1/instances") {
    if (url.search || input.contentType !== "application/json" || !input.body) throw new DesktopAccountRequestError("实例创建请求格式无效。");
    const body = JSON.parse(new TextDecoder().decode(input.body));
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["name", "timeout"].includes(key))
      || typeof body.name !== "string" || !body.name.trim() || [...body.name].length > 64 || body.timeout !== 3600) throw new DesktopAccountRequestError("实例创建请求格式无效。");
  }
  return url;
}

export async function requestDesktopAccount(input: DesktopAccountRequest, session: DesktopLoginSession, fetchImpl: typeof fetch = fetch) {
  const url = validateDesktopAccountRequest(input, session);
  const response = await fetchImpl(url, {
    method: input.method.toUpperCase(), redirect: "error", cache: "no-store",
    headers: { Authorization: `Bearer ${session.token}`, ...(input.contentType ? { "Content-Type": input.contentType } : {}) },
    body: input.body ? new Uint8Array(input.body).buffer : undefined,
    signal: AbortSignal.timeout(/\/bots(?:\/|$)/.test(url.pathname) && input.method.toUpperCase() !== "GET" ? 90_000 : 30_000),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > 8 * 1024 * 1024) throw new DesktopAccountRequestError("账号服务响应过大，无法读取。");
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}
