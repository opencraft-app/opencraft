import {PlatformError} from "./errors.js";

export function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PlatformError("CONFIG", "API 地址必须是有效的 HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PlatformError("CONFIG", "API 地址必须使用 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new PlatformError("CONFIG", "API 地址不能包含 HTTP 凭证");
  }
  if (url.search || url.hash) {
    throw new PlatformError("CONFIG", "API 地址不能包含查询参数或片段");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/$/, "");
}
