export const isLightVelaEdgeOnePreviewHostname = (hostname: string): boolean =>
  hostname.startsWith("lightvela-preview-") && hostname.endsWith(".edgeone.cool");

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
