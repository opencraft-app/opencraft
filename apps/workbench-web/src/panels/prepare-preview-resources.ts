import { serverFetch } from "../runtime/server-context";
/** Prepare the fixed build's optional JS/Worker/WASM before dynamic import.
 * A failed resource fetch must not poison the browser's module cache. */
export async function preparePreviewResources(signal?: AbortSignal): Promise<void> {
  const build = document.querySelector<HTMLMetaElement>('meta[name="opencraft-web-resources"]')?.content;
  if (!build) return;
  const response = await serverFetch(`/__opencraft_resources/${encodeURIComponent(build)}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Optional preview resources unavailable");
}
