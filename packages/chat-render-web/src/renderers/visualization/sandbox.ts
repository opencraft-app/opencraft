const cdns = ["https://cdnjs.cloudflare.com", "https://esm.sh", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://fonts.bunny.net"].join(" ");
export const visualizationCsp = `default-src 'none'; script-src 'unsafe-inline' ${cdns}; style-src 'unsafe-inline' ${cdns}; img-src data: blob: ${cdns}; font-src data: ${cdns}; media-src data: blob: ${cdns}; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

function bootstrap(theme: string) {
  const globals = { theme };
  Object.defineProperty(window, "openai", { value: globals });
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "opencraft:visualization-theme") return;
    globals.theme = event.data.theme === "dark" ? "dark" : "light";
    document.documentElement.style.colorScheme = globals.theme;
    for (const [name, value] of Object.entries(event.data.colors ?? {})) {
      if (/^[a-z][a-z0-9-]*$/u.test(name) && typeof value === "string") document.documentElement.style.setProperty(`--${name}`, value);
    }
    dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals } }));
  });
  let pending = false;
  let previous = 0;
  let intrinsic = 0;
  let width = 0, viewport = 0, revision = 0, measured = -1;
  const measure = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const viewportOnly = width === innerWidth && viewport !== innerHeight && measured === revision;
      width = innerWidth; viewport = innerHeight; measured = revision;
      const height = Math.ceil(document.body.getBoundingClientRect().height);
      if (viewportOnly) { intrinsic = height; return; }
      // Ignore viewport-only changes from min-height:100vh and similar fragments.
      if (height === intrinsic) return;
      intrinsic = height;
      const next = Math.max(80, Math.min(1600, height));
      if (next === previous) return;
      previous = next;
      parent.postMessage({ type: "opencraft:visualization-size", height: next }, "*");
    });
  };
  addEventListener("DOMContentLoaded", () => {
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    const mutations = new MutationObserver(() => { revision++; measure(); });
    mutations.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    measure();
    addEventListener("pagehide", () => { observer.disconnect(); mutations.disconnect(); }, { once: true });
  }, { once: true });
}

/** Opaque origin: HTML never inherits the Workbench origin, credentials or bridge. */
export function visualizationDocument(html: string, theme: string, colors: Record<string, string>): string {
  const palette = Object.entries(colors).map(([name, value]) => `--${name}:${value.replace(/[<>;{}]/gu, "")}`).join(";");
  const css = `:root{color-scheme:${theme === "dark" ? "dark" : "light"};${palette}}*{box-sizing:border-box}body{display:flow-root;margin:0;background:transparent;color:var(--foreground);font:400 var(--font-size-base,14px)/1.5 system-ui;overflow-wrap:anywhere}svg,canvas,img{max-width:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}.card{background:var(--card);color:var(--card-foreground);padding:16px;border-radius:12px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px}.viz-row,.viz-controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.btn{padding:6px 12px;border:1px solid var(--border);border-radius:8px;color:var(--foreground);background:var(--secondary)}.btn[aria-pressed="true"],.btn[aria-selected="true"],.btn-primary{color:var(--primary-foreground);background:var(--primary)}.btn-ghost{border-color:transparent;background:transparent}.btn-block{width:100%}.form-label{display:grid;gap:4px}.form-control,.form-select{padding:6px 8px;color:var(--foreground);background:var(--input);border:1px solid var(--border);border-radius:6px;max-width:100%}.form-check{display:flex;align-items:center;gap:8px}.text-small{font-size:12px}.text-muted{color:var(--muted-foreground)}.text-end{text-align:end}.text-center{text-align:center}.tabular-nums{font-variant-numeric:tabular-nums}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:8px;text-align:start;border-bottom:1px solid var(--border)}.table-responsive{max-width:100%;overflow:auto}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}@media(pointer:coarse){.btn,input,select{min-height:44px}.form-control,.form-select{font-size:16px}}`;
  const safeTheme = JSON.stringify(theme).replace(/</gu, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${visualizationCsp}"><style>${css}</style><script>(${bootstrap.toString()})(${safeTheme})<\/script></head><body>${html}</body></html>`;
}
