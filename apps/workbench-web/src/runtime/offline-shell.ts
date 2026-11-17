import { waitForOptionalFeatureWindow } from "./optional-feature-startup";
import { browserServerContext, serverUrl } from "./server-context";

/** Called after the usable Shell paint. Static preparation grants no account authority. */
export async function prepareOfflineShell(signal: AbortSignal): Promise<void> {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return;
  await waitForOfflinePreparation(signal);
  const buildId = document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content;
  if (!buildId) return;
  const workerUrl = new URL(serverUrl("/opencraft-app-sw.js"), location.origin);
  const scope = new URL("./", workerUrl).href;
  let registration = await owned(navigator.serviceWorker.getRegistration(scope), signal);
  signal.throwIfAborted();
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const constrained = connection?.saveData || /^(slow-)?2g$/.test(connection?.effectiveType ?? "");
  if (navigator.onLine !== false && !constrained) {
    registration = await owned(navigator.serviceWorker.register(workerUrl, { scope, updateViaCache: "none" }), signal);
  }
  if (!registration) return;
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) return;
  if (worker.state === "installing") await new Promise<void>((resolve, reject) => {
    const cleanup = () => { worker.removeEventListener("statechange", changed); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const changed = () => {
      if (worker.state === "installed" || worker.state === "activated") { cleanup(); resolve(); }
      else if (worker.state === "redundant") { cleanup(); reject(new Error("Offline shell installation failed")); }
    };
    worker.addEventListener("statechange", changed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else changed();
  });
  signal.throwIfAborted();
  const raw = document.getElementById("opencraft-deployment-config")?.textContent;
  const deployment = raw ? JSON.parse(raw) : null;
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); channel.port1.onmessage = null; channel.port1.close(); channel.port2.close(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Offline shell configuration timed out")); }, 10000);
    signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = event => {
      cleanup();
      if (event.data?.ok === true && event.data.buildId === buildId) resolve();
      else reject(new Error("Offline shell configuration rejected"));
    };
    try {
      signal.throwIfAborted();
      worker.postMessage({ type: "opencraft-offline-configure", buildId,
        browserBackend: document.querySelector<HTMLMetaElement>('meta[name="opencraft-browser-backend"]')?.content,
        deployment, server: browserServerContext() }, [channel.port2]);
    } catch (error) { cleanup(); reject(error); }
  });
  signal.throwIfAborted();
  document.documentElement.dataset.offlineReady = buildId;
}

/** A retired page stops waiting, even when browser registration cannot be cancelled. */
function owned<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) { operation.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Wait for page load, a ten-second startup grace period, then visible idle. */
export async function waitForOfflinePreparation(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (document.readyState !== "complete") await new Promise<void>((resolve, reject) => {
    const cleanup = () => { window.removeEventListener("load", loaded); signal.removeEventListener("abort", abort); };
    const loaded = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    window.addEventListener("load", loaded, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 10_000);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  await waitForOptionalFeatureWindow(signal);
  signal.throwIfAborted();
}
