import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import type { ServerWorkbenchExtension } from "./server-product-extensions";
import { serverUrl } from "./server-context";

export interface ProductPluginDescriptor {
  readonly id: string;
  readonly version: string;
  readonly manifest: string;
  readonly locales: readonly { locale: string; label: string; messages: Readonly<Record<string, string>> }[];
}
interface PackManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  entry: string;
  css: string[];
}
interface Ports {
  fetch(url: string): Promise<Response>;
  importModule(url: string): Promise<{ default: ServerWorkbenchExtension }>;
  acquireStyles(urls: readonly string[], signal: AbortSignal): Promise<() => void>;
}
const styles = new Map<string, { promise: Promise<void>; release(): void; count: number }>();
function interrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Product plugin activation cancelled"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}
async function acquireStyles(urls: readonly string[], signal: AbortSignal): Promise<() => void> {
  const acquired = urls.map((url) => {
    let record = styles.get(url);
    if (!record) {
      const existing = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find(
        (link) => link.href === url,
      );
      const link = existing ?? document.createElement("link");
      const promise = existing?.sheet
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            link.addEventListener("load", () => resolve(), { once: true });
            link.addEventListener("error", () => reject(new Error("Product plugin stylesheet unavailable")), {
              once: true,
            });
          });
      if (!existing) {
        link.rel = "stylesheet";
        link.href = url;
        link.dataset.opencraftProductPluginStyle = "true";
        document.head.appendChild(link);
      }
      record = {
        promise,
        count: 0,
        release() {
          if (!existing) link.remove();
        },
      };
      styles.set(url, record);
    }
    record.count++;
    return { url, record };
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const { url, record } of acquired)
      if (--record.count === 0) {
        record.release();
        styles.delete(url);
      }
  };
  try {
    await interrupted(Promise.all(acquired.map((item) => item.record.promise)), signal);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
const browserPorts: Ports = {
  fetch: (url) => fetch(url, { credentials: "same-origin", cache: "force-cache", signal: AbortSignal.timeout(15000) }),
  importModule: (url) => import(/* @vite-ignore */ url),
  acquireStyles,
};
const path = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:assets|__opencraft_product_plugins)\/[A-Za-z0-9._/-]+$/.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

/** The build owner selects this trusted factory. Runtime activation remains
 * exclusively owned by ExtensionSupervisor; public module-URL ABI is unchanged. */
export function createProductPluginExtension(
  descriptor: ProductPluginDescriptor,
  ports: Ports = browserPorts,
): ServerWorkbenchExtension {
  const url = (path: string) => new URL(serverUrl(path.startsWith("/") ? path : "/" + path), document.baseURI).href;
  let prepared: Promise<{ extension: ServerWorkbenchExtension; manifest: PackManifest }> | undefined;
  const prepare = () =>
    (prepared ??= (async () => {
      const response = await ports.fetch(url(descriptor.manifest));
      if (!response.ok) throw new Error(`Product plugin unavailable: ${descriptor.id}`);
      const raw = await response.text();
      if (raw.length > 65536) throw new Error("Product plugin manifest too large");
      const manifest = JSON.parse(raw) as PackManifest;
      const namespace = descriptor.manifest.slice(1, descriptor.manifest.lastIndexOf("/") + 1);
      if (
        manifest.schemaVersion !== 1 ||
        manifest.id !== descriptor.id ||
        manifest.version !== descriptor.version ||
        !path(manifest.entry) ||
        !manifest.entry.startsWith(namespace) ||
        !manifest.entry.endsWith(".js") ||
        !Array.isArray(manifest.css) ||
        manifest.css.length > 128 ||
        !manifest.css.every((file) => path(file) && file.endsWith(".css"))
      )
        throw new Error("Product plugin identity or resources mismatch");
      const extension = (await ports.importModule(url(manifest.entry))).default;
      if (
        !extension ||
        extension.id !== descriptor.id ||
        typeof extension.load !== "function" ||
        descriptor.locales.some(
          (locale) => !extension.localeCatalogs?.some((catalog) => catalog.locale === locale.locale),
        )
      )
        throw new Error("Product plugin factory mismatch");
      return { extension, manifest };
    })().catch((error) => {
      prepared = undefined;
      throw error;
    }));
  return {
    id: descriptor.id,
    // A same-build data projection, not a network dependency of core startup.
    // The external factory remains the only owner of its code and activation.
    localeCatalogs: descriptor.locales.map((locale) => ({
      locale: locale.locale,
      label: locale.label,
      load: async () => locale.messages,
    })),
    preload: () => prepare().then(({ extension }) => extension.preload?.()),
    async load(context) {
      const { extension, manifest } = await prepare();
      const definition = await extension.load(context);
      if (definition.manifest.id !== descriptor.id || definition.manifest.version !== descriptor.version)
        throw new Error("Product plugin activation identity mismatch");
      return {
        ...definition,
        async activate(api) {
          const release = await ports.acquireStyles(manifest.css.map(url), api.signal);
          let dispose: Awaited<ReturnType<TrustedExtensionDefinition["activate"]>>;
          try {
            api.signal.throwIfAborted();
            dispose = await definition.activate(api);
          } catch (error) {
            release();
            throw error;
          }
          return async () => {
            try {
              await dispose?.();
            } finally {
              release();
            }
          };
        },
      };
    },
  };
}
