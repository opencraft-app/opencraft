import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";

/** Reuse the site's session and environment; never send its token to another authority. */
export function createCollaborationAccount(signal: AbortSignal) {
  const apiBase = resolveConfiguredAuthApiBaseUrl();
  const token = readStoredAuthToken();
  return {
    async requestRaw<T>(path: string, init: RequestInit = {}): Promise<T> {
      if (!path.startsWith("/v1/collaboration/")) throw new Error("协作请求路径无效。");
      if (signal.aborted || token !== readStoredAuthToken() || apiBase !== resolveConfiguredAuthApiBaseUrl()) {
        throw new Error("账户已切换，请重新打开协作聊天。");
      }
      if (apiBase !== "https://lightclaw.tech") throw new Error("协作聊天仅在北京测试环境开放。");
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(`${apiBase}${path}`, { ...init, headers, signal, credentials: "include" });
      if (signal.aborted || token !== readStoredAuthToken() || apiBase !== resolveConfiguredAuthApiBaseUrl()) throw new Error("账户已切换，请重新打开协作聊天。");
      if (!response.ok) {
        const message = response.status === 401 ? "登录已过期，请重新登录。"
          : response.status === 404 ? "当前环境尚未开放协作聊天。"
          : "协作服务暂时不可用，请重试。";
        throw Object.assign(new Error(message), { status: response.status });
      }
      return response.json() as Promise<T>;
    },
  };
}
