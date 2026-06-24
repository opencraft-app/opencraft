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
