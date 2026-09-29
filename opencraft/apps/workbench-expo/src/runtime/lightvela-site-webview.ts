import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

export const lightVelaSiteUrl = (region: LightVelaRegion) => `${LIGHTVELA_REGIONS[region].frontendBase}/agents`;
export const LIGHTVELA_SITE_URL = lightVelaSiteUrl("intl");
export type LightVelaSiteTab = "agents" | "account" | "billing";
const SITE_TAB_PATHS: Record<LightVelaSiteTab, string> = {
  agents: "/agents",
  account: "/account",
  billing: "/account/billing",
};
export const lightVelaSiteTabUrl = (region: LightVelaRegion, tab: LightVelaSiteTab) =>
  `${LIGHTVELA_REGIONS[region].frontendBase}${SITE_TAB_PATHS[tab]}`;

export function lightVelaSiteTabForUrl(raw: string, region: LightVelaRegion): LightVelaSiteTab | null {
  try {
    const origin = LIGHTVELA_REGIONS[region].frontendBase;
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === SITE_TAB_PATHS.billing || path.startsWith(`${SITE_TAB_PATHS.billing}/`)) return "billing";
    if (path === SITE_TAB_PATHS.account || path.startsWith(`${SITE_TAB_PATHS.account}/`)) return "account";
    if (path === SITE_TAB_PATHS.agents || path.startsWith(`${SITE_TAB_PATHS.agents}/`)) return "agents";
  } catch { /* Untrusted location is not a tab. */ }
  return null;
}
const WEB_TOKEN_KEY = "lightclaw-auth-token-v1";

/** Runs only in the first-party page before its application JavaScript starts. */
export function createLightVelaSiteBootstrap(token: string, region: LightVelaRegion = "intl"): string {
  const siteOrigin = LIGHTVELA_REGIONS[region].frontendBase;
  return `(() => {
    if (window.location.origin !== ${JSON.stringify(siteOrigin)}) return;
    const key = ${JSON.stringify(WEB_TOKEN_KEY)};
    const signedOutKey = "opencraft.native-web-signed-out";
    try {
      if (window.sessionStorage.getItem(signedOutKey) === "1") {
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "signed-out" }));
        return;
      }
      window.localStorage.setItem(key, ${JSON.stringify(token)});
    } catch {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "session-unavailable" }));
      return;
    }
    let lastLocation = "";
    const reportLocation = () => {
      const href = window.location.href;
      if (typeof href !== "string") return;
      const lang = typeof document !== "undefined" ? document.documentElement?.lang || "" : "";
      const locationKey = href + "|" + lang;
      if (locationKey !== lastLocation) {
        lastLocation = locationKey;
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "site-location", href, lang }));
      }
    };
    reportLocation();
    window.addEventListener("popstate", reportLocation);
    let reported = false;
    const reportSignOut = () => {
      window.sessionStorage.setItem(signedOutKey, "1");
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "signed-out" }));
    };
    window.addEventListener("pagehide", () => {
      if (!window.localStorage.getItem(key)) reportSignOut();
    });
    window.setInterval(() => {
      try {
        reportLocation();
        const absent = !window.localStorage.getItem(key);
        if (absent && !reported) {
          reported = true;
          reportSignOut();
        } else if (!absent) {
          reported = false;
        }
      } catch { /* The page will surface a storage error itself. */ }
    }, 1500);
  })(); true;`;
}

/** Keep website content usable under the native tab bar without its duplicate header. */
export function createLightVelaMobileShellBootstrap(region: LightVelaRegion): string {
  const siteOrigin = LIGHTVELA_REGIONS[region].frontendBase;
  return `(() => {
    if (window.location.origin !== ${JSON.stringify(siteOrigin)}) return;
    const install = () => {
      if (!document.documentElement || document.getElementById('opencraft-mobile-shell')) return;
      const style = document.createElement('style');
      style.id = 'opencraft-mobile-shell';
      style.textContent = [
        '.lw-public-site-header { display: none !important; }',
        '.lw-app-top-pad { padding-top: 0 !important; }',
        '.landing-page > main { padding-top: 16px !important; }',
        '@media (max-width: 1023px) { .lv-agents-sidebar { max-height: 36dvh !important; overflow-y: auto !important; padding-bottom: 12px; border-bottom: 1px solid #eee9f5; } }'
      ].join('\\n');
      document.documentElement.appendChild(style);
    };
    install();
    document.addEventListener('DOMContentLoaded', install, { once: true });
  })(); true;`;
}

/** Warm only public, versioned site assets. Private API responses remain online. */
export function createLightVelaStaticPrefetch(region: LightVelaRegion): string {
  const siteOrigin = LIGHTVELA_REGIONS[region].frontendBase;
  return `(() => {
  if (window.location.origin !== ${JSON.stringify(siteOrigin)}) return;
  const assetUrls = new Set();
  const addAsset = (raw) => {
    try {
      const url = new URL(raw, window.location.href);
      if (url.origin !== ${JSON.stringify(siteOrigin)}) return;
      if (!url.pathname.includes('/_next/static/') && !url.pathname.startsWith('/lightvela-intl-home/assets/')) return;
      assetUrls.add(url.href);
    } catch { /* Ignore malformed asset URLs. */ }
  };
  for (const image of document.querySelectorAll('img[loading="lazy"][src]')) {
    addAsset(image.getAttribute('src'));
    if (assetUrls.size >= 4) break;
  }
  const routes = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    try {
      const url = new URL(anchor.href);
      if (url.origin === ${JSON.stringify(siteOrigin)} && url.pathname.startsWith('/agents/')) routes.add(url.pathname);
      if (routes.size >= 2) break;
    } catch { /* Ignore malformed links. */ }
  }
  if (routes.size === 0) {
    routes.add('/agents/files');
    routes.add('/agents/automations');
  }
  void (async () => {
    for (const route of routes) {
      try {
        // Read public HTML without cookies and never retain the response itself.
        const response = await fetch(route, { cache: 'no-store', credentials: 'omit' });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) continue;
        const html = await response.text();
        for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
          addAsset(match[1]);
          if (assetUrls.size >= 16) break;
        }
      } catch { /* Prefetch is best effort. */ }
      if (assetUrls.size >= 16) break;
    }
    const urls = [...assetUrls].slice(0, 16);
    let workerAccepted = false;
    try {
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.register('/tat-hermes-web-proxy-sw.js', { scope: '/' });
        await registration.update().catch(() => {});
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
        const worker = registration.active ?? (await navigator.serviceWorker.ready).active;
        if (worker && typeof MessageChannel !== 'undefined') {
          workerAccepted = await new Promise(resolve => {
            const channel = new MessageChannel();
            const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 1200);
            channel.port1.onmessage = event => {
              clearTimeout(timeout);
              channel.port1.close();
              resolve(event.data?.type === 'OPENCRAFT_STATIC_PREFETCH_ACCEPTED');
            };
            worker.postMessage({ type: 'OPENCRAFT_PREFETCH_STATIC', urls }, [channel.port2]);
          });
        }
      }
    } catch { /* Keep HTTP cache warming when service workers are unavailable. */ }
    for (const url of urls) {
      if (workerAccepted && new URL(url).pathname.startsWith('/__releases/')) continue;
      void fetch(url, { cache: 'force-cache', credentials: 'omit' }).catch(() => {});
    }
  })();
})(); true;`;
}

export const LIGHTVELA_STATIC_PREFETCH = createLightVelaStaticPrefetch("intl");
