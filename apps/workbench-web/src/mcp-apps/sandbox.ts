import { boundedJson } from "./contract";
import { appCsp, type AppResource } from "./policy";

/** This function is serialized into the opaque-origin document; keep it self-contained. */
function bootstrap(initial: Record<string, unknown>, token: string) {
  let seq = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const call = (method: string, params: unknown) => new Promise((resolve, reject) => {
    if (pending.size >= 16) { reject(new Error("Too many App requests")); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("App request timed out")); }, 30000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ jsonrpc: "2.0", id: `legacy:${id}`, method, params, __opencraft: token }, "*");
  });
  const api = Object.assign({}, initial, {
    callTool: (name: string, args: unknown = {}) => call("tools/call", { name, arguments: args }),
    openExternal: (input: { href: string }) => call("ui/open-link", { url: input.href }),
    sendFollowUpMessage: (input: { prompt: string }) => call("ui/message", { role: "user", content: [{ type: "text", text: input.prompt }] }),
    setWidgetState: (state: unknown) => { api.widgetState = state; void call("opencraft/widget-state", { state }).catch(() => {}); },
    requestDisplayMode: () => Promise.resolve({ mode: "inline" }),
    updateModelContext: (params: unknown) => call("ui/update-model-context", params),
  });
  Object.defineProperty(window, "openai", { value: api, configurable: false });
  window.addEventListener("message", event => {
    if (event.source !== parent || event.data?.__opencraft !== token) return;
    // Compatibility envelopes never reach a standard SDK's strict JSON-RPC parser.
    event.stopImmediatePropagation();
    const data = event.data;
    if (typeof data.id === "string" && data.id.startsWith("legacy:")) {
      const id = Number(data.id.slice(7));
      const request = pending.get(id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(id);
      if (data.error) request.reject(new Error(data.error.message)); else request.resolve(data.result);
    }
    if (data.method === "opencraft/globals") {
      Object.assign(api, data.params);
      window.dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals: data.params } }));
    }
  });
  window.addEventListener("pagehide", () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("App closed")); }
    pending.clear();
  });
  let frame = 0;
  let lastHeight = 0;
  let lastIntrinsic = 0;
  let contentRevision = 0;
  let measuredRevision = -1;
  let viewportWidth = 0;
  let viewportHeight = 0;
  const measure = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const body = document.body;
      if (!body) return;
      // A height-only viewport response (e.g. 100vh + margins) is not a new
      // content size request. Otherwise every applied height grows the next one.
      const viewportOnly = innerWidth === viewportWidth && innerHeight !== viewportHeight
        && contentRevision === measuredRevision;
      viewportWidth = innerWidth; viewportHeight = innerHeight; measuredRevision = contentRevision;
      const style = getComputedStyle(body);
      const intrinsic = Math.max(body.scrollHeight, body.getBoundingClientRect().height)
        + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      const unchanged = intrinsic === lastIntrinsic;
      // Remember ignored viewport responses too: an unrelated DOM mutation
      // must not re-submit the same viewport-driven overflow as content growth.
      lastIntrinsic = intrinsic;
      if (viewportOnly || unchanged) return;
      const height = Math.min(1600, Math.max(80, Math.ceil(intrinsic)));
      if (height === lastHeight) return;
      lastHeight = height;
      parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height }, __opencraft: token }, "*");
    });
  };
  window.addEventListener("DOMContentLoaded", () => {
    const observer = new ResizeObserver(measure);
    const contentChanged = () => { contentRevision++; measure(); };
    const mutations = new MutationObserver(contentChanged);
    mutations.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    // Intrinsic media/font changes need no DOM mutation and may coincide with
    // the host applying a previously requested viewport height.
    document.addEventListener("load", contentChanged, true);
    document.fonts.addEventListener("loadingdone", contentChanged);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    measure();
    window.addEventListener("pagehide", () => {
      observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame);
      document.removeEventListener("load", contentChanged, true);
      document.fonts.removeEventListener("loadingdone", contentChanged);
    }, { once: true });
  }, { once: true });
}
export function sandboxDocument(resource: AppResource, globals: Record<string, unknown>, token: string): string {
  const safe = (value: unknown) => boundedJson(value).replace(/</g, "\\u003c");
  const injected = `<meta http-equiv="Content-Security-Policy" content="${appCsp(resource).replace(/"/g, "&quot;")}"><script>(${bootstrap.toString()})(${safe(globals)},${safe(token)})<\/script>`;
  // Put policy and bootstrap before any untrusted markup, including malformed heads.
  return `<!doctype html><html><head>${injected}</head><body>${resource.html}</body></html>`;
}
