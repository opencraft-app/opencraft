import { fileDownloadUrl } from "./blob-files";
import { parseWebDeploymentConfig } from "./web-deployment-config";
import { serverUrl } from "./server-context";

export function htmlFilePreviewAvailable(hostId: string, path: string): boolean {
  return /\.html?$/iu.test(path) && fileDownloadUrl(hostId, path) !== null
    && parseWebDeploymentConfig(document.getElementById("opencraft-deployment-config")?.textContent ?? null)?.htmlPreviews === true;
}

/** Open a real gateway page synchronously; no popup WindowProxy is required. */
export function htmlFilePreviewUrl(hostId: string, path: string): string {
  if (!htmlFilePreviewAvailable(hostId, path)) throw new Error("HTML preview unavailable");
  return serverUrl("/__opencraft_preview/#open=" + encodeURIComponent(JSON.stringify({ hostId, path })));
}
