import { browserServerContext, serverUrl } from "./server-context";

/** Called after the usable Shell paint. Static preparation grants no account authority. */
export async function prepareOfflineShell(): Promise<void> {
  if (!("serviceWorker" in navigator) || !globalThis.isSecureContext) return;
  const buildId = document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content;
  if (!buildId) return;
  const workerUrl = new URL(serverUrl("/opencraft-app-sw.js"), location.origin);
  const scope = new URL("./", workerUrl).href;
  let registration = await navigator.serviceWorker.getRegistration(scope);
  if (navigator.onLine !== false) registration = await navigator.serviceWorker.register(workerUrl, { scope, updateViaCache: "none" });
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
    worker.postMessage({ type: "opencraft-offline-configure", buildId, deployment: raw ? JSON.parse(raw) : null, server: browserServerContext() }, [channel.port2]);
  });
  document.documentElement.dataset.offlineReady = buildId;
}
