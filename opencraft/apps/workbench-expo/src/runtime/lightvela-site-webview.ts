export const LIGHTVELA_SITE_URL = "https://lightvela.ai/agents";

export const EXPO_GO_AUTH_ORIGINS = [
  "https://api.lightvela.ai",
  "https://github.com",
  "https://sites-auth.lightvela.site",
] as const;

export function isExpoGoAuthNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.origin === "https://github.com") return true;
    if (url.origin === "https://sites-auth.lightvela.site" && url.pathname === "/auth/lightvela/callback") return true;
    if (url.origin === "https://api.lightvela.ai" || url.origin === "https://sites-auth.lightvela.site") {
      return url.pathname.startsWith("/auth/oauth/github/");
    }
    return false;
  } catch { return false; }
}

export function isExpoGoGoogleAuthStart(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.origin === "https://api.lightvela.ai" || url.origin === "https://sites-auth.lightvela.site")
      && url.pathname === "/auth/oauth/google/start";
  } catch { return false; }
}

const SITE_ORIGIN = "https://lightvela.ai";
const WEB_TOKEN_KEY = "lightclaw-auth-token-v1";

/** Runs only in the first-party page before its application JavaScript starts. */
export function createLightVelaSiteBootstrap(token: string): string {
  return `(() => {
    if (window.location.origin !== ${JSON.stringify(SITE_ORIGIN)}) return;
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

/** Warm only public, versioned site assets. Private API responses remain online. */
export const LIGHTVELA_STATIC_PREFETCH = `(() => {
  if (window.location.origin !== ${JSON.stringify(SITE_ORIGIN)}) return;
  const assetUrls = new Set();
  const addAsset = (raw) => {
    try {
      const url = new URL(raw, window.location.href);
      if (url.origin !== ${JSON.stringify(SITE_ORIGIN)}) return;
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
      if (url.origin === ${JSON.stringify(SITE_ORIGIN)} && url.pathname.startsWith('/agents/')) routes.add(url.pathname);
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
