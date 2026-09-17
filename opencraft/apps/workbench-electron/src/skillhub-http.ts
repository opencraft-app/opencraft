const SKILLHUB_ORIGIN = "https://api.skillhub.cn";
const SKILLHUB_ARTIFACT_ORIGIN = "https://skillhub-1388575217.cos.accelerate.myqcloud.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 1;

class DesktopSkillHubRequestError extends Error {}

export function desktopSkillHubPublicError(error: unknown): Error {
  if (error instanceof DesktopSkillHubRequestError) return new Error(error.message);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Error("SkillHub 请求超时，请检查网络后重试。");
  }
  return new Error("无法连接 SkillHub，请稍后重试。");
}

export function validateDesktopSkillHubPath(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new DesktopSkillHubRequestError("SkillHub 请求格式无效。");
  }
  let url: URL;
  try { url = new URL(value, SKILLHUB_ORIGIN); }
  catch { throw new DesktopSkillHubRequestError("SkillHub 请求地址无效。"); }
  if (!value.startsWith("/api/") || url.origin !== SKILLHUB_ORIGIN || url.username || url.password || url.hash) {
    throw new DesktopSkillHubRequestError("桌面客户端不支持此 SkillHub 请求。");
  }
  return url;
}

function validateSkillHubRedirect(current: URL, response: Response): URL | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get("location");
  if (!location) throw new DesktopSkillHubRequestError("SkillHub 返回了无效的下载地址。");
  let redirect: URL;
  try { redirect = new URL(location, current); }
  catch { throw new DesktopSkillHubRequestError("SkillHub 返回了无效的下载地址。"); }
  if (redirect.origin !== SKILLHUB_ARTIFACT_ORIGIN
    || redirect.username
    || redirect.password
    || redirect.hash) {
    throw new DesktopSkillHubRequestError("SkillHub 返回了不受支持的下载地址。");
  }
  return redirect;
}

/** Fixed public SkillHub read capability; never a renderer-controlled proxy. */
export async function requestDesktopSkillHub(path: unknown, fetchImpl: typeof fetch = fetch) {
  let url = validateDesktopSkillHubPath(path);
  const signal = AbortSignal.timeout(15_000);
  let response: Response | null = null;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
      signal,
    });
    const redirect = validateSkillHubRedirect(url, response);
    if (!redirect) break;
    if (redirects === MAX_REDIRECTS) {
      throw new DesktopSkillHubRequestError("SkillHub 下载重定向次数过多。");
    }
    url = redirect;
  }
  if (!response) throw new DesktopSkillHubRequestError("SkillHub 未返回响应。");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new DesktopSkillHubRequestError("SkillHub 响应过大，无法读取。");
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new DesktopSkillHubRequestError("SkillHub 响应过大，无法读取。");
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}
