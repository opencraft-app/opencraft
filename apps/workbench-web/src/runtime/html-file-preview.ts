import { fileDownloadUrl } from "./blob-files";
import { parseWebDeploymentConfig } from "./web-deployment-config";
import { serverFetch, serverUrl } from "./server-context";

export function htmlFilePreviewAvailable(hostId: string, path: string): boolean {
  return /\.html?$/iu.test(path) && fileDownloadUrl(hostId, path) !== null
    && parseWebDeploymentConfig(document.getElementById("opencraft-deployment-config")?.textContent ?? null)?.htmlPreviews === true;
}

/** The host returns a path; the browser owns its actual public gateway origin. */
export async function createHtmlFilePreview(hostId: string, path: string, signal: AbortSignal): Promise<string> {
  if (!htmlFilePreviewAvailable(hostId, path)) throw new Error("HTML preview unavailable");
  const response = await serverFetch("/__opencraft_preview/tickets", {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId, path }), signal,
  });
  if (!response.ok) throw new Error("HTML preview unavailable");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("path" in result) || typeof result.path !== "string"
    || !/^\/__opencraft_preview\/#ticket=[A-Za-z0-9_-]{32}$/u.test(result.path)) throw new Error("Invalid HTML preview entry");
  signal.throwIfAborted();
  return serverUrl(result.path);
}
