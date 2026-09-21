import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceNodeModules = realpathSync(fileURLToPath(new URL("../../node_modules", import.meta.url)));
const previewBridgeBundlePath = fileURLToPath(new URL(
  "../../packages/browser-preview-bridge/dist/preview-bridge.js",
  import.meta.url,
));
const hyperNodeUser = process.env.OPENCRAFT_HYPERNODE_USER?.trim() || "skipzhang";
const buildTarget = process.env.OPENCRAFT_BUILD_TARGET?.trim() || "web";
const product = process.env.OPENCRAFT_PRODUCT?.trim() || "opencraft";
const isElectronRenderer = buildTarget === "electron";
const isLightVelaWeb = product === "lightvela-web";
const includeHyperNodePlugin = !isLightVelaWeb && !isElectronRenderer
  && process.env.VITE_HYPERNODE_PLUGIN?.trim() !== "disabled";
const includeBuiltinAgentsPlugin = isElectronRenderer;
const releaseMinification = process.env.OPENCRAFT_RELEASE_MINIFY === "standard";

// Vite's native import.meta.env projection is honored by both the dev module
// server and production bundler. Keep product identity out of ad-hoc globals:
// rolldown-vite intentionally leaves some custom `define` identifiers intact
// while serving source modules in development.
process.env.VITE_OPENCRAFT_PRODUCT_ID = product;
process.env.VITE_INCLUDE_HYPERNODE_PLUGIN = includeHyperNodePlugin ? "true" : "false";
process.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN = includeBuiltinAgentsPlugin ? "true" : "false";

interface WebReleaseMetadata {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly builtAt: string;
  readonly sourceRevision: string | null;
  readonly appServerProtocolVersion: string | null;
}

function createWebReleaseMetadata(): WebReleaseMetadata {
  const builtAt = new Date().toISOString();
  const generatedBuildId = `${builtAt.replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomBytes(6).toString("hex")}`;
  const buildId = process.env.OPENCRAFT_BUILD_ID?.trim() || generatedBuildId;
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(buildId)) {
    throw new Error("OPENCRAFT_BUILD_ID may only contain letters, numbers, dots, underscores, and hyphens");
  }

  return {
    schemaVersion: 1,
    buildId,
    builtAt,
    sourceRevision: process.env.OPENCRAFT_SOURCE_REVISION?.trim() || null,
    appServerProtocolVersion: process.env.OPENCRAFT_APPSERVER_PROTOCOL_VERSION?.trim() || null,
  };
}

const webRelease = createWebReleaseMetadata();

const appServerProxy = {
  "/appserver": {
    target: "http://127.0.0.1:9988",
    ws: true,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/appserver/u, "/rpc"),
    // Browsers cannot attach an authentication header to WebSocket(). In
    // development the same-origin Vite gateway owns that responsibility.
    // Production must replace this fixed identity with its authenticated
    // session gateway; it must never trust a username supplied by the page.
    headers: { "x-hypernode-user": hyperNodeUser },
  },
} as const;

function runtimeErrorCapture(): Plugin {
  const reports: unknown[] = [];

  const attach = (middlewares: Connect.Server, reload?: () => void) => {
    if (reload !== undefined) {
      middlewares.use("/__opencraft_reload", (_request, response) => {
        reload();
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ ok: true }));
      });
    }

    middlewares.use("/__opencraft_runtime_error", (request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");

      if (request.method === "DELETE") {
        reports.length = 0;
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method !== "POST") {
        response.end(JSON.stringify(reports));
        return;
      }

      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          const report = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          reports.push({ receivedAt: new Date().toISOString(), report });
          reports.splice(0, Math.max(0, reports.length - 20));
          console.error("[opencraft runtime error]", report);
          response.end(JSON.stringify({ ok: true }));
        } catch (error) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, error: String(error) }));
        }
      });
    });
  };

  return {
    name: "opencraft-runtime-error-capture",
    configureServer(server) {
      attach(server.middlewares, () => server.ws.send({ type: "full-reload" }));
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}

function releaseMetadata(metadata: WebReleaseMetadata): Plugin {
  return {
    name: "opencraft-release-metadata",
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          {
            tag: "meta",
            attrs: {
              name: "opencraft-build-id",
              content: metadata.buildId,
            },
            injectTo: "head",
          },
        ];
      },
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify(metadata, null, 2)}\n`,
      });
    },
  };
}

function previewBridgeAsset(): Plugin {
  const contents = () => readFileSync(previewBridgeBundlePath);
  const attach = (middlewares: Connect.Server) => {
    middlewares.use("/__opencraft/preview-bridge.js", (_request, response) => {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.setHeader("cross-origin-resource-policy", "cross-origin");
      response.end(contents());
    });
  };
  return {
    name: "vela-preview-bridge-asset",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "__opencraft/preview-bridge.js",
        source: contents(),
      });
    },
  };
}

export default defineConfig({
  // Both targets are served at their origin root. Root-relative assets also
  // survive direct loading/reloading /views/:id and /settings/:id routes.
  // The Electron static server maps that root to the relocatable signed bundle.
  base: "/",
  plugins: [
    releaseMetadata(webRelease),
    previewBridgeAsset(),
    runtimeErrorCapture(),
    react(),
  ],
  resolve: {
    // Mermaid keeps KaTeX optional, but when a diagram uses math it should
    // reuse the renderer already owned by chat-render-web.
    dedupe: ["react", "react-dom", "katex"],
  },
  optimizeDeps: {
    // The workbench activates large optional workspace plugins at runtime.
    // Letting Vite discover every transitive ESM dependency after the server
    // has started publishes temporary hashes and causes 504 responses while
    // the optimizer is still replacing its cache. Only React requires the
    // compatibility prebundle; the remaining dependencies ship browser ESM
    // and are served directly.
    noDiscovery: true,
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
    // `bson` is browser-native ESM and is reached through an optional
    // workspace plugin. Vite's discovery optimizer can encounter it after the
    // initial graph has already been published, leaving clients with an
    // outdated hash and a 504. Serving its ESM directly keeps the optional
    // plugin boundary stable across activation and HMR.
    exclude: ["bson", "mermaid"],
  },
  server: {
    host: "0.0.0.0",
    // The local LightVela HTTPS gateway preserves its public Host header while
    // proxying module requests to this development server. Keep the allowlist
    // explicit: `true` would also admit DNS-rebinding hosts.
    allowedHosts: ["localhost.lightvela.ai"],
    port: 10000,
    strictPort: true,
    // ResizeObserver reports its delivery-loop warning through window.onerror.
    // It is not an application exception and must never replace the workbench
    // with Vite's development overlay while virtualized rows are measuring.
    hmr: { overlay: false },
    proxy: appServerProxy,
    fs: {
      allow: [workspaceRoot, workspaceNodeModules],
    },
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: ["localhost.lightvela.ai"],
    port: 10000,
    strictPort: true,
    proxy: appServerProxy,
  },
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/a-[hash].js",
        chunkFileNames: "assets/a-[hash].js",
        assetFileNames: "assets/a-[hash][extname]",
      },
    },
  },
  build: {
    target: "es2022",
    // Vite 8 uses Rolldown + Oxc. Release builds keep the standard Oxc
    // minifier; aggressive secondary compression/mangling has caused
    // renderer hangs and is intentionally not part of the release contract.
    minify: "oxc",
    rolldownOptions: releaseMinification ? {
      output: {
        // Hardened releases expose only opaque content identities. Human
        // chunk/module names remain available in source builds and private
        // observability metadata, never in the public asset topology.
        entryFileNames: "assets/a-[hash].js",
        chunkFileNames: "assets/a-[hash].js",
        assetFileNames: "assets/a-[hash][extname]",
      },
    } : undefined,
    // Hidden maps remain available to an error collector, while the release
    // publisher deliberately excludes them from the public static tree.
    sourcemap: releaseMinification ? false : "hidden",
    manifest: true,
    assetsDir: "assets",
    outDir: isElectronRenderer
      ? "dist-electron"
      : isLightVelaWeb
        ? "dist-lightvela-web"
        : "dist",
  },
});
