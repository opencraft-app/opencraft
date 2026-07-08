export const isLightVelaEdgeOnePreviewHostname = (hostname: string): boolean =>
  hostname.startsWith("lightvela-preview-") && hostname.endsWith(".edgeone.cool");

/**
 * 已知的 lightclaw.pages.dev 前端子域到对应 sandbox 后端 host 的映射。
 *
 * 用途：非 production 环境下（例如 bj82.lightclaw.pages.dev），前端不能一律
 * 落回 https://lightclaw.tech；需要落到与自己同环境的 service-gateway 公网
 * host，例如 https://api-bj82.lightclaw.tech，否则 session cookie 与 CORS
 * 白名单都对不上。
 *
 * 该映射来自仓库现网配置（argocd/services/service-gateway/*）：
 *   - beijing-sandbox    → lightclaw.tech
 *   - beijing-sandbox-2  → api-bj82.lightclaw.tech
 *   - sandbox-bj-7       → api-sandbox-bj-7.lightclaw.tech
 */
/** @internal 暴露给单测使用；运行时应通过 resolveConfiguredAuthApiBaseUrl 间接访问。 */
export const PAGES_DEV_SUBDOMAIN_TO_API_HOST: Record<string, string> = {
  "bj82.lightclaw.pages.dev": "https://api-bj82.lightclaw.tech",
  "sandbox-bj-7.lightclaw.pages.dev": "https://api-sandbox-bj-7.lightclaw.tech",
};

export const resolveConfiguredAuthApiBaseUrl = () => {
  const configured = (
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AUTH_API_BASE_URL : undefined)
    ?? import.meta.env?.VITE_AUTH_API_BASE_URL
  )?.trim();

  if (configured && configured.length > 0) {
    if (configured.toLowerCase() === "mock") {
      return null;
    }
    // 本地开发通过 vite proxy 代理，请求发到当前域名
    if (configured.toLowerCase() === "local-proxy") {
      return "";
    }
    return configured.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "https://lightclaw.tech";
    }
    // 命中 sandbox 专属子域时，路由到对应 sandbox 后端 host。
    // 合法性校验：必须以 https:// 开头，防止映射表配置错误时返回无效值。
    const sandboxHost = PAGES_DEV_SUBDOMAIN_TO_API_HOST[hostname];
    if (sandboxHost && sandboxHost.startsWith("https://")) {
      return sandboxHost;
    }
    if (
      hostname === "lightclaw.tech"
      || hostname === "www.lightclaw.tech"
      || hostname === "lightclaw.pages.dev"
      || hostname.endsWith(".lightclaw.pages.dev")
      || isLightVelaEdgeOnePreviewHostname(hostname)
    ) {
      return "https://lightclaw.tech";
    }
    if (hostname === "preview.lightclaw.cn" || hostname === "lightclaw.cn") {
      return "https://api.lightclaw.cn";
    }
    if (hostname === "lightclaw.site" || hostname === "www.lightclaw.site") {
      return "https://api.lightclaw.site";
    }
    if (
      hostname === "lightvela.com"
      || hostname === "www.lightvela.com"
      || hostname === "lightvela.tencent.com"
      || hostname === "www.lightvela.tencent.com"
    ) {
      return "https://api.lightvela.com";
    }
  }

  return null;
};

/**
 * 反馈后台（/support/feedback/list、/sign）专用 base。
 * 优先使用 NEXT_PUBLIC_SUPPORT_ADMIN_API_BASE_URL 显式覆盖；
 * 其次在 admin.lightclaw.tech（含预览子域）上同域回指；
 * 兜底沿用主站鉴权 base（本地开发 / 主站直连仍可工作）。
 *
 * 与 resolveConfiguredAuthApiBaseUrl 的区别：反馈后台的读取接口
 * 经 admin-gateway(admin.lightclaw.tech) 暴露，由运营白名单(SUPPORT_AGENT_IDS)
 * 控制；而用户提交(presign) 经主站 service-gateway。两者鉴权链不同。
 */
export const resolveSupportAdminApiBaseUrl = () => {
  const configured = (
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_SUPPORT_ADMIN_API_BASE_URL : undefined)
    ?? import.meta.env?.VITE_SUPPORT_ADMIN_API_BASE_URL
  )?.trim();

  if (configured && configured.length > 0) {
    if (configured.toLowerCase() === "mock") {
      return null;
    }
    if (configured.toLowerCase() === "local-proxy") {
      return "";
    }
    return configured.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname === "admin.lightclaw.tech" || hostname.endsWith(".admin.lightclaw.tech")) {
      return "https://admin.lightclaw.tech";
    }
  }

  return resolveConfiguredAuthApiBaseUrl();
};
