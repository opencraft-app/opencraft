import { waitForOptionalFeatureWindow } from "./optional-feature-startup";
import { browserServerContext, serverUrl } from "./server-context";

/** Called after the usable Shell paint. Static preparation grants no account authority. */
export async function prepareOfflineShell(signal: AbortSignal): Promise<void> {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return;
  // Full-build offline preparation is optional, not part of the opening waterfall.
  await waitForOfflinePreparation(signal);
  const buildId = document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content;
  if (!buildId) return;
  const workerUrl = new URL(serverUrl("/opencraft-app-sw.js"), location.origin);
  const scope = new URL("./", workerUrl).href;
  let registration = await navigator.serviceWorker.getRegistration(scope);
  signal.throwIfAborted();
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const constrained = connection?.saveData || /^(slow-)?2g$/.test(connection?.effectiveType ?? "");
  if (navigator.onLine !== false && !constrained) registration = await navigator.serviceWorker.register(workerUrl, { scope, updateViaCache: "none" });
  if (!registration) return;
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) return;
  if (worker.state === "installing") await new Promise<void>((resolve, reject) => {
    const changed = () => {
      if (worker.state === "installed" || worker.state === "activated") { worker.removeEventListener("statechange", changed); resolve(); }
      else if (worker.state === "redundant") { worker.removeEventListener("statechange", changed); reject(new Error("Offline shell installation failed")); }
    };
    worker.addEventListener("statechange", changed); changed();
  });
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { channel.port1.close(); reject(new Error("Offline shell configuration timed out")); }, 10000);
    channel.port1.onmessage = event => {
      clearTimeout(timeout); channel.port1.close();
      if (event.data?.ok === true && event.data.buildId === buildId) resolve();
      else reject(new Error("Offline shell configuration rejected"));
    };
    const raw = document.getElementById("opencraft-deployment-config")?.textContent;
    worker.postMessage({ type: "opencraft-offline-configure", buildId, browserBackend: document.querySelector<HTMLMetaElement>('meta[name="opencraft-browser-backend"]')?.content, deployment: raw ? JSON.parse(raw) : null, server: browserServerContext() }, [channel.port2]);
  });
  document.documentElement.dataset.offlineReady = buildId;
}

/** Wait for page load, a ten-second startup grace period, then browser idle. */
export async function waitForOfflinePreparation(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (document.readyState !== "complete") await new Promise<void>((resolve, reject) => {
    const cleanup = () => { window.removeEventListener("load", loaded); signal.removeEventListener("abort", abort); };
    const loaded = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    window.addEventListener("load", loaded, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 10_000);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  await waitForOptionalFeatureWindow(signal);
  signal.throwIfAborted();
}
