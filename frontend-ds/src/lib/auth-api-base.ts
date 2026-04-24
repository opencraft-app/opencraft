export const resolveConfiguredAuthApiBaseUrl = () => {
  const configured = import.meta.env.VITE_AUTH_API_BASE_URL?.trim();

  if (configured && configured.length > 0) {
    if (configured.toLowerCase() === "mock") {
      return null;
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
    ) {
      return "https://lightclaw.tech";
    }
    if (hostname === "preview.lightclaw.cn" || hostname === "lightclaw.cn") {
      return "https://api.lightclaw.cn";
    }
    if (hostname === "lightclaw.site" || hostname === "www.lightclaw.site") {
      return "https://api.lightclaw.site";
    }
  }

  return null;
};
