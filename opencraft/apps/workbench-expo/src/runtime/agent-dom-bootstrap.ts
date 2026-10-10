import { MOBILE_BOT_BRIDGE_VERSION } from "@opencraft/mobile-bot-bridge";
/** Local DOM bootstrap. Credentials are passed in memory, never in URLs or logs. */
export function agentDomBootstrap({ runtimeId, region, apiBase, siteOrigin, token, locale, nativeAudio = false }: {
  runtimeId: string; region: "cn" | "global"; apiBase: string; siteOrigin: string; token: string; locale: string; nativeAudio?: boolean;
}) {
  return `(() => {
    window.__OPENCRAFT_NATIVE_AUDIO__ = ${JSON.stringify(nativeAudio)};
    window.__LIGHTVELA_BOT_RUNTIME_ID__ = ${JSON.stringify(runtimeId)};
    window.__LIGHTVELA_BOT_POST__ = payload => window.ReactNativeWebView?.postMessage(JSON.stringify({ protocol: ${MOBILE_BOT_BRIDGE_VERSION}, runtimeId: ${JSON.stringify(runtimeId)}, payload }));
    window.__LIGHTVELA_EMBEDDED_REGION__ = ${JSON.stringify(region)};
    window.__LIGHTVELA_EMBEDDED_API_BASE__ = ${JSON.stringify(apiBase)};
    window.__LIGHTVELA_EMBEDDED_SITE_BASE__ = ${JSON.stringify(siteOrigin)};
    window.__LIGHTVELA_EMBEDDED_TOKEN__ = ${JSON.stringify(token)};
    // Native Shell swipes must yield to editing, controls and horizontal content.
    const ownsTouch = event => window.getSelection?.()?.isCollapsed === false || (event.composedPath?.() ?? []).some(node => {
      if (!(node instanceof Element)) return false;
      if (node.matches('input,textarea,select,button,[role="button"],[role="slider"],[role="tab"],a,[contenteditable]:not([contenteditable="false"])')) return true;
      const style = getComputedStyle(node);
      return /auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
    });
    document.addEventListener('touchstart', event => {
      window.__LIGHTVELA_BOT_POST__({ type: 'bot-touch-ownership', owned: ownsTouch(event) });
    }, { capture: true, passive: true });
    const releaseTouch = event => {
      if (!event.touches.length) window.__LIGHTVELA_BOT_POST__({ type: 'bot-touch-ownership', owned: false });
    };
    document.addEventListener('touchend', releaseTouch, { capture: true, passive: true });
    document.addEventListener('touchcancel', releaseTouch, { capture: true, passive: true });
    const apiBase = ${JSON.stringify(apiBase)};
    const originalFetch = window.fetch.bind(window);
    const endpointKind = url => {
      try {
        const path = new URL(url).pathname;
        if (path.endsWith('/debug/exec')) return 1;
        if (path.startsWith('/v1/instances/')) return 2;
        if (path.includes('/subscription') || path.includes('/passes') || path.includes('/plans')) return 3;
        if (path.startsWith('/auth/')) return 4;
      } catch {}
      return 0;
    };
    window.fetch = (input, init) => {
      const requestUrl = typeof input === 'string' ? input : input?.url;
      const isApi = typeof requestUrl === 'string' && requestUrl.startsWith(apiBase + '/');
      return originalFetch(input, init).then(response => {
        if (isApi && !response.ok) window.__LIGHTVELA_BOT_POST__({ type: 'bot-api-http-failed', status: response.status, endpoint: endpointKind(requestUrl) });
        return response;
      }, error => {
        if (isApi) window.__LIGHTVELA_BOT_POST__({ type: 'bot-api-network-failed' });
        throw error;
      });
    };
    let reportedRuntimeFailure = false;
    const reportRuntimeFailure = event => {
      if (reportedRuntimeFailure) return;
      reportedRuntimeFailure = true;
      const name = event?.error?.name ?? event?.reason?.name;
      const kind = name === 'ReferenceError' ? 1 : name === 'TypeError' ? 2 : name === 'SyntaxError' ? 3 : name === 'RangeError' ? 4 : 0;
      window.__LIGHTVELA_BOT_POST__({
        type: 'bot-runtime-script-failed', kind,
        line: Number.isSafeInteger(event?.lineno) ? event.lineno : 0,
        column: Number.isSafeInteger(event?.colno) ? event.colno : 0,
      });
    };
    window.addEventListener('error', reportRuntimeFailure);
    window.addEventListener('unhandledrejection', reportRuntimeFailure);
    try { localStorage.setItem('lightclaw-auth-token-v1', ${JSON.stringify(token)}); localStorage.setItem('lw-locale', ${JSON.stringify(locale)}); localStorage.setItem('lw-locale-explicit', '1'); } catch {}
  })(); true;`;
}
