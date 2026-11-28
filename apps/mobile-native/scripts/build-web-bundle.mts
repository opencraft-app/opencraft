import { parse } from "acorn";
import { build, type Plugin } from "vite";
import { createWorkbenchWebConfig } from "../../workbench-web/vite.config";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const webRoot = path.join(root, "apps/workbench-web");
const outRoot = path.join(root, "apps/mobile-native/ios/WebBundle");

interface EmittedAsset {
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

interface EmittedChunk {
  readonly fileName: string;
  readonly code: string;
  readonly isEntry: boolean;
}

function inlineReferencedAssets(code: string, assets: readonly EmittedAsset[]): string {
  const byUrl = new Map<string, EmittedAsset>();
  for (const asset of assets) {
    const candidates = [
      asset.fileName,
      `/${asset.fileName}`,
      `./${asset.fileName}`,
      `../${asset.fileName}`,
      `./${path.basename(asset.fileName)}`,
      path.basename(asset.fileName),
    ];
    for (const candidate of candidates) {
      if (!byUrl.has(candidate)) byUrl.set(candidate, asset);
    }
  }
  const memo = new Map<string, string>();
  const visiting = new Set<string>();

  const renderReplacement = (asset: EmittedAsset): string => {
    const cached = memo.get(asset.fileName);
    if (cached !== undefined) return cached;
    if (visiting.has(asset.fileName)) throw new Error(`Cyclic asset reference: ${asset.fileName}`);
    visiting.add(asset.fileName);
    const ext = path.extname(asset.fileName).toLowerCase();
    let encoded: string;
    if (ext === ".js" || ext === ".mjs") {
      const text = typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8");
      const nested = rewriteLiterals(text);
      encoded = `URL.createObjectURL(new Blob([${JSON.stringify(nested)}],{type:"text/javascript"}))`;
    } else {
      const mimeMap: Record<string, string> = {
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
        ".wasm": "application/wasm",
      };
      const mime = mimeMap[ext] ?? "application/octet-stream";
      encoded = JSON.stringify(`data:${mime};base64,${Buffer.from(asset.source).toString("base64")}`);
    }
    visiting.delete(asset.fileName);
    memo.set(asset.fileName, encoded);
    return encoded;
  };

  function rewriteLiterals(source: string): string {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const edits: Array<{ start: number; end: number; value: string }> = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as {
        type?: string;
        value?: unknown;
        start?: number;
        end?: number;
        expressions?: unknown[];
        quasis?: Array<{ value: { cooked: string } }>;
      };
      if (
        n.type === "Literal" &&
        typeof n.value === "string" &&
        byUrl.has(n.value) &&
        n.start !== undefined &&
        n.end !== undefined
      ) {
        edits.push({ start: n.start, end: n.end, value: renderReplacement(byUrl.get(n.value)!) });
        return;
      }
      if (
        n.type === "TemplateLiteral" &&
        Array.isArray(n.expressions) &&
        n.expressions.length === 0 &&
        n.quasis?.[0] &&
        byUrl.has(n.quasis[0].value.cooked) &&
        n.start !== undefined &&
        n.end !== undefined
      ) {
        edits.push({ start: n.start, end: n.end, value: renderReplacement(byUrl.get(n.quasis[0].value.cooked)!) });
        return;
      }
      for (const child of Object.values(node as Record<string, unknown>)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === "object") visit(child);
      }
    };
    visit(ast);
    let out = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
    }
    return out;
  }

  return rewriteLiterals(code);
}

function buildNativeModuleGraph(chunks: readonly EmittedChunk[], assets: readonly EmittedAsset[]) {
  const names = new Set(chunks.map((chunk) => chunk.fileName));
  const entries = chunks.filter((chunk) => chunk.isEntry);
  if (entries.length !== 1) throw new Error(`Expected exactly 1 mobile entry chunk, found ${entries.length}`);
  const entry = entries[0]!;
  const modules: Record<string, { resourceId: string; imports: Array<[string, string]> }> = {};
  const resources = new Map<string, string>();

  for (const chunk of chunks) {
    const imports: Array<[string, string]> = [];
    const edits: Array<{ start: number; end: number; value: string }> = [];
    const resolveChunk = (specifier: string) => {
      const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(chunk.fileName), specifier));
      if (!names.has(normalized)) throw new Error(`Unpackaged module ${specifier} in ${chunk.fileName}`);
      return normalized;
    };
    const visit = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as {
        type?: string;
        start?: number;
        end?: number;
        source?: {
          type?: string;
          value?: unknown;
          start?: number;
          end?: number;
          expressions?: unknown[];
          quasis?: Array<{ value: { cooked: string } }>;
        };
      };
      if (
        (n.type === "ImportDeclaration" || n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") &&
        n.source &&
        typeof n.source.value === "string" &&
        n.source.start !== undefined &&
        n.source.end !== undefined
      ) {
        const target = resolveChunk(n.source.value);
        const token = `opencraft-module:${imports.length}:${target}`;
        imports.push([token, target]);
        edits.push({ start: n.source.start, end: n.source.end, value: JSON.stringify(token) });
        return;
      }
      if (n.type === "ImportExpression" && n.source && n.start !== undefined && n.end !== undefined) {
        const literal =
          n.source.type === "Literal" && typeof n.source.value === "string"
            ? n.source.value
            : n.source.type === "TemplateLiteral" &&
                Array.isArray(n.source.expressions) &&
                n.source.expressions.length === 0 &&
                n.source.quasis?.[0]
              ? n.source.quasis[0].value.cooked
              : null;
        const arg =
          literal === null && n.source.start !== undefined && n.source.end !== undefined
            ? chunk.code.slice(n.source.start, n.source.end)
            : JSON.stringify(resolveChunk(literal!));
        edits.push({ start: n.start, end: n.end, value: `globalThis.__opencraftPackagedImport(${arg})` });
        return;
      }
      for (const child of Object.values(node as Record<string, unknown>)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === "object") visit(child);
      }
    };
    visit(parse(chunk.code, { ecmaVersion: "latest", sourceType: "module" }));
    let code = chunk.code;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      code = code.slice(0, edit.start) + edit.value + code.slice(edit.end);
    }
    code = inlineReferencedAssets(code, assets);
    const resourceId = createHash("sha256").update(code).digest("hex");
    resources.set(resourceId, code);
    modules[chunk.fileName] = { resourceId, imports };
  }

  return { manifest: { entry: entry.fileName, modules }, resources };
}

function renderBootstrapScript(manifestJson: string): string {
  return `((manifest) => {
  const modules = new Map();
  const identity = window.opencraftMobile;
  const read = (resourceId) => {
    if (typeof window.__opencraftNativeReadAsset === "function") {
      return window.__opencraftNativeReadAsset(resourceId);
    }
    return fetch("./resources/" + resourceId + ".ocasset").then((response) => {
      if (!response.ok) throw new Error("Packaged resource unavailable");
      return response.text();
    });
  };
  const load = (id) => {
    if (modules.has(id)) return modules.get(id);
    if (typeof id !== "string" || !Object.hasOwn(manifest.modules, id)) {
      return Promise.reject(new Error("Unknown packaged module"));
    }
    const definition = manifest.modules[id];
    const result = (async () => {
      const [text, imports] = await Promise.all([
        read(definition.resourceId),
        Promise.all(definition.imports.map(async ([token, child]) => [token, await load(child)])),
      ]);
      let source = text;
      for (const [token, uri] of imports) source = source.split(token).join(uri);
      return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    })();
    modules.set(id, result);
    result.catch(() => modules.delete(id));
    return result;
  };
  window.__opencraftPackagedImport = async (id) => import(await load(id));
  window.__opencraftPackagedImport(manifest.entry).catch((error) => {
    console.error("Native Packaged Workbench startup failed", error);
    if (identity && window.opencraftMobileHost) {
      window.opencraftMobileHost.postMessage(JSON.stringify({ ...identity, type: "startup-error" }));
    }
    window.dispatchEvent(new Event("opencraft-packaged-error"));
  });
})(${manifestJson});`.replace(/<\/script/giu, "<\\/script");
}

process.env.OPENCRAFT_BUILD_TARGET = "mobile";
const config = createWorkbenchWebConfig({ mode: "production", command: "build" }, { pluginBranding: false });
const plugins = (config.plugins ?? [])
  .flat()
  .filter(
    (plugin) =>
      plugin &&
      !(
        typeof plugin === "object" &&
        "name" in plugin &&
        [
          "opencraft-startup-resources",
          "opencraft-optional-web-assets",
          "opencraft-preview-bridge-asset",
          "opencraft-release-metadata",
        ].includes(plugin.name)
      ),
  );

const endpoint =
  process.env.OPENCRAFT_MOBILE_APPSERVER_WS_URL?.trim() || process.env.EXPO_PUBLIC_APPSERVER_WS_URL?.trim();
if (endpoint) {
  const url = new URL(endpoint);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Mobile AppServer must be a credential-free ws/wss URL");
  }
}
const hostId = process.env.OPENCRAFT_MOBILE_APPSERVER_HOST_ID?.trim() || "local";
const hosts = endpoint ? [{ hostId, label: "AppServer", kind: "remote-control", url: endpoint }] : [];

const capture: Plugin = {
  name: "opencraft-native-mobile-web-bundle",
  enforce: "post",
  generateBundle: {
    order: "post",
    async handler(_options, bundle) {
      const chunks = Object.values(bundle).filter(
        (item): item is Extract<typeof item, { type: "chunk" }> => item.type === "chunk",
      );
      const css = Object.values(bundle)
        .filter(
          (item): item is Extract<typeof item, { type: "asset" }> =>
            item.type === "asset" && item.fileName.endsWith(".css"),
        )
        .map((item) => (typeof item.source === "string" ? item.source : Buffer.from(item.source).toString("utf8")))
        .join("\n");
      const unbundled: EmittedAsset[] = Object.values(bundle)
        .filter(
          (item): item is Extract<typeof item, { type: "asset" }> =>
            item.type === "asset" && !item.fileName.endsWith(".css") && !item.fileName.endsWith(".md"),
        )
        .map((item) => ({ fileName: item.fileName, source: item.source }));
      unbundled.push({
        fileName: "opencraft-icon.svg",
        source: await readFile(path.join(webRoot, "public/opencraft-icon.svg")),
      });

      const { manifest, resources } = buildNativeModuleGraph(chunks, unbundled);
      const script = renderBootstrapScript(JSON.stringify(manifest));

      const resourcesDir = path.join(outRoot, "resources");
      await rm(outRoot, { recursive: true, force: true });
      await mkdir(resourcesDir, { recursive: true });
      for (const [id, code] of resources) {
        await writeFile(path.join(resourcesDir, `${id}.ocasset`), code);
      }
      await writeFile(path.join(outRoot, "manifest.json"), JSON.stringify(manifest));

      const zhLocale = await readFile(path.join(webRoot, "src/i18n/locales/zh-CN.json"), "utf8");
      await writeFile(path.join(outRoot, "zh-CN.json"), zhLocale);

      const styles = css.replace(/<\/style/giu, "<\\/style");
      const csp =
        "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src https: http: data: blob:; font-src data:; connect-src https: http: wss: ws: data: blob:; media-src https: http: data: blob:; worker-src blob: data:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'";
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>OpenCraft</title><style>${styles}</style></head><body><div id="root"></div><script type="module">${script}</script></body></html>`;
      await writeFile(path.join(outRoot, "mobile-workbench.html"), html);

      const totalBytes = [...resources.values()].reduce(
        (sum, code) => sum + Buffer.byteLength(code),
        Buffer.byteLength(html),
      );
      console.log(
        `Native WebBundle ready: bootstrap ${Buffer.byteLength(html)} bytes, ${resources.size} modules, total ${totalBytes} bytes -> ${outRoot}`,
      );
    },
  },
};

await build({
  ...config,
  configFile: false,
  root: webRoot,
  base: "./",
  publicDir: false,
  plugins: [...plugins, capture],
  define: {
    ...config.define,
    "import.meta.env.VITE_APPSERVER_HOSTS_JSON": JSON.stringify(hosts.length ? JSON.stringify(hosts) : ""),
    "import.meta.env.VITE_APPSERVER_WS_URL": JSON.stringify(endpoint ?? ""),
    "import.meta.env.VITE_HYPERNODE_PLUGIN": JSON.stringify("disabled"),
  },
  build: {
    ...config.build,
    write: false,
    manifest: false,
    sourcemap: false,
    outDir: path.join(root, "apps/mobile-native/.cache/web-workbench"),
    copyPublicDir: false,
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: { input: path.join(webRoot, "src/mobile-main.ts"), output: { format: "es" } },
  },
});
