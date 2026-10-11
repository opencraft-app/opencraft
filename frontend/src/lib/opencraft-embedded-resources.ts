import { useEffect } from "react";

export const EMBEDDED_WORKBENCH_ELEMENT_NAME = "opencraft-embedded-workbench";
const scriptLoads = new Map<string, Promise<void>>();
const MODULE_RELOAD_ATTEMPT_KEY = "lightvela:opencraft-module-reload-attempt";

/** A failed module may stay failed in the browser's module cache until navigation. */
export function markEmbeddedWorkbenchModuleReload(): boolean {
  try {
    if (window.sessionStorage.getItem(MODULE_RELOAD_ATTEMPT_KEY)) return false;
    window.sessionStorage.setItem(MODULE_RELOAD_ATTEMPT_KEY, "1");
    return true;
  } catch {
    // Without a persistent guard, an automatic reload could loop forever.
    return false;
  }
}

export function clearEmbeddedWorkbenchModuleReload(): void {
  try { window.sessionStorage.removeItem(MODULE_RELOAD_ATTEMPT_KEY); }
  catch { /* Storage may be unavailable in private browsing. */ }
}

/** Navigation retains the selected Bot in the current URL and reloads failed JS modules. */
export function reloadEmbeddedWorkbenchPage(): void {
  window.location.reload();
}

export function embeddedWorkbenchScriptUrl(): string | null {
  const configured = (typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL : undefined)?.trim();
  if (configured) return configured;
  if (typeof window !== "undefined" && ["127.0.0.1", "localhost", "localhost.lightvela.ai"].includes(window.location.hostname)) {
    return "http://127.0.0.1:10000/__opencraft/embedded-workbench.js";
  }
  return null;
}

/** Shared code loader only. It never constructs an Application or acquires a Host. */
export function loadEmbeddedWorkbench(url: string): Promise<void> {
  // Expo pre-registers the same Web element from a local, packaged module.
  // A missing packaged element is a build failure, never a remote fallback.
  if (url === 'bundled:opencraft') {
    return customElements.get(EMBEDDED_WORKBENCH_ELEMENT_NAME)
      ? Promise.resolve()
      : Promise.reject(new Error('Packaged OpenCraft Chat is missing'));
  }
  const existing = scriptLoads.get(url);
  if (existing) return existing;
  const operation = new Promise<void>((resolve, reject) => {
    if (customElements.get(EMBEDDED_WORKBENCH_ELEMENT_NAME)) { resolve(); return; }
    const script = document.createElement("script");
    script.type = "module";
    script.src = url;
    script.crossOrigin = "anonymous";
    script.dataset.opencraftEmbeddedWorkbench = "true";
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error("Embedded Workbench loading timed out"));
    }, 30_000);
    script.addEventListener("load", () => {
      void customElements.whenDefined(EMBEDDED_WORKBENCH_ELEMENT_NAME).then(() => {
        window.clearTimeout(timer);
        resolve();
      }, reject);
    }, { once: true });
    script.addEventListener("error", () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error("Could not load Embedded Workbench"));
    }, { once: true });
    document.head.append(script);
  });
  scriptLoads.set(url, operation);
  operation.catch(() => scriptLoads.delete(url));
  return operation;
}

export function useEmbeddedWorkbenchResourcePreparation(enabled: boolean, active: boolean): void {
  useEffect(() => {
    if (!enabled || !active) return;
    const url = embeddedWorkbenchScriptUrl();
    if (url) void loadEmbeddedWorkbench(url).catch(() => {
      // The actual migration surface owns error UI and retries failed loads.
    });
  }, [enabled, active]);
}
