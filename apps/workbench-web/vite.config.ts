import { resolveWorkbenchPresentation, type WorkbenchPresentationOptions } from "./src/workbench-presentation";
import browserslistToEsbuild from "browserslist-to-esbuild";
import { browserTargets } from "../../config/browser-compatibility.mjs";
import { browserCompatibility } from "./browser-compatibility.vite";
import { workspaceDependencies } from "./workspace-dependencies.vite";
import { startupResources } from "./startup-resources.vite";
import { startupResourceHints } from "./startup-resource-hints.vite";
import { offlineShell } from "./offline-shell.vite";
import type { StartupResourcePolicy } from "./startup-resource-policy.vite";
import { optionalWebAssets } from "./optional-web-assets";
import { productPublicAssets } from "./product-public-assets.mjs";
import { resolveServerProductEntry, resolveClientProductEntry, resolveEmbeddedProductEntry } from "./server-product-entry.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { appearanceBootstrap } from "./appearance-bootstrap.vite";
import { pluginBranding } from "./plugin-branding.vite";
import { loadEnv, defineConfig, type ConfigEnv, type Connect, type Plugin, type UserConfig } from "vite";

/** Trusted build composition; platform constraints still belong to core. */
export interface WorkbenchWebBuildFeatures {
  readonly presentation?: WorkbenchPresentationOptions;
  readonly startupResourcePolicy?: StartupResourcePolicy;
  readonly hyperNode?: boolean;
  readonly builtinAgents?: boolean;
  readonly tasks?: boolean;
  readonly pluginBranding?: boolean;
}

export function createWorkbenchWebConfig(
  { mode }: ConfigEnv,
  features: WorkbenchWebBuildFeatures = {},
): UserConfig {
  const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
  const clientProductEntry = resolveClientProductEntry(workspaceRoot, process.env.OPENCRAFT_CLIENT_PRODUCT_ENTRY);
  const serverProductEntry = resolveServerProductEntry(workspaceRoot, process.env.OPENCRAFT_SERVER_EXTENSIONS_ENTRY);
  const workspaceNodeModules = realpathSync(fileURLToPath(new URL("../../node_modules", import.meta.url)));
  const previewBridgeBundlePath = fileURLToPath(new URL(
    "../../packages/browser-preview-bridge/dist/preview-bridge.js",
    import.meta.url,
  ));
  const workbenchHtmlPath = fileURLToPath(new URL("./index.html", import.meta.url));
  const embeddedWorkbenchEntryPath = resolveEmbeddedProductEntry(workspaceRoot, process.env.OPENCRAFT_EMBEDDED_PRODUCT_ENTRY);
  const embeddedBootstrapId = "\0opencraft:embedded-bootstrap";
  const browserCompatibilityPath = fileURLToPath(new URL("./src/runtime/browser-compatibility.ts", import.meta.url));
  const hostProxyServiceWorkerPath = fileURLToPath(new URL(
    "./public/opencraft-host-proxy-sw.js",
    import.meta.url,
  ));
  const buildTarget = process.env.OPENCRAFT_BUILD_TARGET?.trim() || "web";
  const product = process.env.OPENCRAFT_PRODUCT?.trim() || "opencraft";
  const isElectronRenderer = buildTarget === "electron";
  const isEmbeddedWorkbenchBuild = buildTarget === "embedded-workbench";
  if (isEmbeddedWorkbenchBuild && !embeddedWorkbenchEntryPath) {
    throw new Error("Embedded Workbench build requires OPENCRAFT_EMBEDDED_PRODUCT_ENTRY");
  }
  const includeHyperNodePlugin = !isElectronRenderer
    && (features.hyperNode ?? process.env.VITE_HYPERNODE_PLUGIN?.trim() !== "disabled");
  const includeBuiltinAgentsPlugin = isElectronRenderer || (features.builtinAgents ?? true);
  const includeHeadlessModelServices = process.env.OPENCRAFT_HEADLESS_SERVER_BUILD === "true";
  const releaseMinification = process.env.OPENCRAFT_RELEASE_MINIFY === "standard";
  if (includeHeadlessModelServices) {
    let hosts: unknown;
    try { hosts = JSON.parse(process.env.VITE_APPSERVER_HOSTS_JSON ?? "null"); }
    catch { throw new Error("Headless Web build requires valid VITE_APPSERVER_HOSTS_JSON"); }
    if (!Array.isArray(hosts) || !hosts.some((host: unknown) =>
      host !== null && typeof host === "object"
        && "hostId" in host && host.hostId === "opencraft-server"
        && "url" in host && host.url === "/appserver")) {
      throw new Error("Headless Web build requires the opencraft-server /appserver Host profile");
    }
  }

  // Vite's native import.meta.env projection is honored by both the dev module
  // server and production bundler. Keep product identity out of ad-hoc globals:
  // rolldown-vite intentionally leaves some custom `define` identifiers intact
  // while serving source modules in development.
  process.env.VITE_OPENCRAFT_PRODUCT_ID = product;
  process.env.VITE_OPENCRAFT_PRESENTATION = JSON.stringify(resolveWorkbenchPresentation(features.presentation));
  process.env.VITE_INCLUDE_HYPERNODE_PLUGIN = includeHyperNodePlugin ? "true" : "false";
  process.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN = includeBuiltinAgentsPlugin ? "true" : "false";
  process.env.VITE_INCLUDE_HEADLESS_MODEL_SERVICES = includeHeadlessModelServices ? "true" : "false";
  process.env.VITE_INCLUDE_HEADLESS_APPHOST = includeHeadlessModelServices ? "true" : "false";
  process.env.VITE_INCLUDE_TASKS_PLUGIN = !isEmbeddedWorkbenchBuild && (features.tasks ?? true) ? "true" : "false";

  interface WebReleaseMetadata {
    readonly schemaVersion: 1;
    readonly buildId: string;
    readonly builtAt: string;
    readonly sourceRevision: string | null;
    readonly appServerProtocolVersion: string | null;
    readonly headlessServer: boolean;
    readonly headlessHostId: string | null;
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
      headlessServer: includeHeadlessModelServices,
      headlessHostId: includeHeadlessModelServices ? "opencraft-server" : null,
    };
  }

  const webRelease = createWebReleaseMetadata();

  // With `optimizeDeps.noDiscovery` enabled, Vite never prebundles a dependency
  // unless it is listed here. Several runtime dependencies ship CJS only (no
  // `module`, no `exports` map with ESM entries, no `type: "module"`); serving
  // them raw makes the browser fail with `does not provide an export named ...`.
  // Instead of maintaining that list by hand, walk the workbench runtime
  // dependency tree (`dependencies` only — the devDependencies tree is
  // build-tooling like vite/babel and must stay out of the browser prebundle)
  // and include every CJS-only package automatically. Packages whose entry is
  // CSS (`@fontsource-*`) and type-only entries take no part in JS prebundling
  // and are skipped.
  function collectCjsOnlyDependencies(): string[] {
    const workspaceRootDir = fileURLToPath(new URL("../..", import.meta.url));
    const webPackage = JSON.parse(readFileSync(
      fileURLToPath(new URL("./package.json", import.meta.url)),
      "utf8",
    )) as { dependencies?: Record<string, string> };
    const visited = new Set<string>();
    const cjsOnly = new Set<string>();
    const queue = Object.keys(webPackage.dependencies ?? {});
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (visited.has(name)) continue;
      visited.add(name);
      let info: {
        main?: string;
        module?: string;
        type?: string;
        exports?: unknown;
        dependencies?: Record<string, string>;
      };
      try {
        info = JSON.parse(readFileSync(
          path.join(workspaceRootDir, "node_modules", name, "package.json"),
          "utf8",
        ));
      } catch {
        continue;
      }
      const main = typeof info.main === "string" ? info.main : "";
      const hasEsm = Boolean(info.module)
        || info.type === "module"
        || JSON.stringify(info.exports ?? "").includes(".mjs");
      const entryIsCss = main.endsWith(".css");
      const entryIsTypes = main.endsWith(".d.ts") || main.endsWith(".d.mts");
      if (!hasEsm && !entryIsCss && !entryIsTypes && main !== "") {
        cjsOnly.add(name);
      }
      for (const dependency of Object.keys(info.dependencies ?? {})) {
        if (!visited.has(dependency)) queue.push(dependency);
      }
    }
    return [...cjsOnly].sort();
  }

  const cjsOnlyInclude = collectCjsOnlyDependencies();
  console.log(`[opencraft] optimizeDeps.include auto CJS packages (${cjsOnlyInclude.length}):`, cjsOnlyInclude.join(", "));

  // A local execution service can supply a private RPC URL. Only the dev
  // server consumes its token; it never enters the renderer's Host recipe.
  const developmentAppServer = new URL(process.env.OPENCRAFT_APPSERVER_URL || "ws://127.0.0.1:9988/rpc");
  if (!["ws:", "wss:", "http:", "https:"].includes(developmentAppServer.protocol)
    || developmentAppServer.username || developmentAppServer.password || developmentAppServer.hash) throw new Error("Invalid development AppServer URL");
  const appServerProxy = {
    "/appserver": {
      target: developmentAppServer.origin.replace(/^ws/u, "http"),
      ws: true,
      changeOrigin: true,
      rewrite: () => developmentAppServer.pathname + developmentAppServer.search,
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
            {tag:"meta",attrs:{name:"opencraft-source-revision",content:metadata.sourceRevision??""},injectTo:"head"},
          ];
        },
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: `${JSON.stringify(metadata, null, 2)}\n`,
        });
        this.emitFile({
          type: "asset",
          fileName: isEmbeddedWorkbenchBuild
            ? "opencraft-host-proxy-sw.js"
            : "__opencraft/opencraft-host-proxy-sw.js",
          source: readFileSync(hostProxyServiceWorkerPath, "utf8"),
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
      name: "opencraft-preview-bridge-asset",
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

  function embeddedWorkbenchDevEntry(entryPath: string): Plugin {
    return {
      name: "opencraft-embedded-workbench-dev-entry",
      resolveId(id) {
        if (id === embeddedBootstrapId) return id;
      },
      load(id) {
        if (id !== embeddedBootstrapId) return;
        return `import ${JSON.stringify(browserCompatibilityPath)};\nawait import(${JSON.stringify(entryPath)});\n`;
      },
      configureServer(server) {
        server.middlewares.use("/__opencraft/embedded-workbench.js", (_request, response) => {
          response.setHeader("content-type", "text/javascript; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.end(
            'const base = new URL("/", import.meta.url);\n'
            + 'globalThis.__OPENCRAFT_EMBED_ASSET_BASE__ = base.href;\n'
            + 'globalThis.process ??= { env: {} };\n'
            + 'globalThis.global ??= globalThis;\n'
            + 'const RefreshRuntime = (await import(new URL("@react-refresh", base).href)).default;\n'
            + 'RefreshRuntime.injectIntoGlobalHook(globalThis);\n'
            + 'globalThis.$RefreshReg$ = () => {};\n'
            + 'globalThis.$RefreshSig$ = () => (type) => type;\n'
            + 'globalThis.__vite_plugin_react_preamble_installed__ = true;\n'
            + `await import(new URL(${JSON.stringify(`/@fs/${browserCompatibilityPath}`)}, base).href);\n`
            + `await import(new URL(${JSON.stringify(`/@fs/${entryPath}`)}, base).href);\n`,
          );
        });
      },
      generateBundle(_options, bundle) {
        const entry = Object.values(bundle).find((item) => (
          item.type === "chunk"
          && item.isEntry
          && item.facadeModuleId === embeddedBootstrapId
        ));
        if (entry === undefined || entry.type !== "chunk") {
          throw new Error("Embedded Workbench entry chunk was not generated");
        }
        this.emitFile({
          type: "asset",
          fileName: isEmbeddedWorkbenchBuild
            ? "embedded-workbench.js"
            : "__opencraft/embedded-workbench.js",
          source: isEmbeddedWorkbenchBuild
            ? 'globalThis.__OPENCRAFT_EMBED_ASSET_BASE__ = new URL("./", import.meta.url).href;\n'
              + `await import("./${entry.fileName}");\n`
            : 'globalThis.__OPENCRAFT_EMBED_ASSET_BASE__ = new URL("../", import.meta.url).href;\n'
              + `await import("../${entry.fileName}");\n`,
        });
      },
    };
  }

  // Keep absent entries out of Rolldown's input map, rather than assigning undefined.
  const rolldownInput: Record<string, string> = {
    ...(!isEmbeddedWorkbenchBuild ? { workbench: workbenchHtmlPath } : {}),
    ...(embeddedWorkbenchEntryPath ? { "embedded-workbench": embeddedBootstrapId } : {}),
  };

  return {
    // Both targets are served at their origin root. Root-relative assets also
    // survive direct loading/reloading /views/:id and /settings/:id routes.
    // The Electron static server maps that root to the relocatable signed bundle.
    base: isEmbeddedWorkbenchBuild ? "/__opencraft/" : process.env.VITE_INCLUDE_HEADLESS_APPHOST === "true" ? "./" : "/",
    define: { "process.env.NODE_ENV": JSON.stringify(mode), "process.env.PROD": JSON.stringify(mode === "production") },
    plugins: [
      appearanceBootstrap(resolveWorkbenchPresentation(features.presentation)),
      ...(!isElectronRenderer && !isEmbeddedWorkbenchBuild && (features.pluginBranding ?? true) ? [pluginBranding(workspaceRoot,
        (process.env.VITE_WEB_EXTENSIONS ?? loadEnv(mode, process.cwd()).VITE_WEB_EXTENSIONS ?? "").split(",").map(id => id.trim()).filter(Boolean),
      )] : []),
      releaseMetadata(webRelease),
      productPublicAssets(workspaceRoot, process.env.OPENCRAFT_PRODUCT_PUBLIC_DIR),
      ...(!isElectronRenderer ? [startupResources(features.startupResourcePolicy)] : []),
      ...(!isElectronRenderer && !isEmbeddedWorkbenchBuild ? [startupResourceHints(features.startupResourcePolicy)] : []),
      ...(!isElectronRenderer && !isEmbeddedWorkbenchBuild ? [optionalWebAssets()] : []),
      ...(!isEmbeddedWorkbenchBuild ? [previewBridgeAsset()] : []),
      ...(!isElectronRenderer && !isEmbeddedWorkbenchBuild ? [offlineShell(webRelease.buildId)] : []),
      ...(embeddedWorkbenchEntryPath ? [embeddedWorkbenchDevEntry(embeddedWorkbenchEntryPath)] : []),
      runtimeErrorCapture(),
      react(),
      workspaceDependencies(workspaceRoot),
      browserCompatibility(workspaceRoot),
    ],
    resolve: {
      alias: [
        { find: /^\.\/runtime\/client-product-entry$/, replacement: clientProductEntry },
        { find: /^\.{1,2}\/runtime\/server-product-extensions$/, replacement: serverProductEntry },
        { find: /^\.\/fonts$/, replacement: path.resolve(import.meta.dirname, "src", isElectronRenderer || isEmbeddedWorkbenchBuild ? "fonts.desktop.ts" : "fonts.ts") },
      ],
      // Mermaid keeps KaTeX optional, but when a diagram uses math it should
      // reuse the renderer already owned by chat-render-web.
      dedupe: ["react", "react-dom", "katex"],
    },
    optimizeDeps: {
      // The workbench activates large optional workspace plugins at runtime.
      // Letting Vite discover every transitive ESM dependency after the server
      // has started publishes temporary hashes and causes 504 responses while
      // the optimizer is still replacing its cache. React and the CJS-only
      // packages reached through react-router require the compatibility
      // prebundle; every other dependency ships browser ESM and is served
      // directly. Adding a browser-reachable CJS dependency means adding it here
      // as well, otherwise it is served as raw CJS and its named exports fail.
      noDiscovery: true,
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "fastdom/extensions/fastdom-promised.js",
        "elkjs/lib/elk.bundled.js",
        // This linked ESM workspace also exposes browser CommonJS modules.
        // Package-level CJS discovery skips them, so prebundle these entries.
        "@opencraft/remote-interaction",
        "@opencraft/remote-interaction/touch",
        "@opencraft/remote-interaction/websocket",
        // Some source compositions export this optional CommonJS leaf.
        ...(existsSync(fileURLToPath(new URL("../../packages/browser-core/src/metadata-limits.cjs", import.meta.url)))
          ? ["@opencraft/browser-core/metadata-limits"] : []),
        // Deep CJS shim entries need explicit prebundling with noDiscovery.
        "core-js/es/iterator/index.js",
        "core-js/es/promise/with-resolvers.js",
        "core-js/es/object/group-by.js",
        "core-js/es/map/group-by.js",
        "core-js/es/set/difference.js",
        "core-js/es/set/intersection.js",
        "core-js/es/set/is-disjoint-from.js",
        "core-js/es/set/is-subset-of.js",
        "core-js/es/set/is-superset-of.js",
        "core-js/es/set/symmetric-difference.js",
        "core-js/es/set/union.js",
        // CJS-only runtime dependencies, collected automatically — see
        // collectCjsOnlyDependencies(). Covers the packages the embedded
        // workbench previously had to list by hand (cookie,
        // set-cookie-parser, tim-upload-plugin, void-elements,
        // @tencentcloud/chat) plus every other CJS-only package in the
        // runtime dependency tree (dayjs, @xterm, cytoscape layouts, ...),
        // so adding a new CJS dependency no longer requires editing this
        // file.
        ...cjsOnlyInclude,
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
      // Additional gateway hosts belong to an explicitly selected build config.
      allowedHosts: [],
      port: 10000,
      strictPort: true,
      // ResizeObserver reports its delivery-loop warning through window.onerror.
      // It is not an application exception and must never replace the workbench
      // with Vite's development overlay while virtualized rows are measuring.
      hmr: { overlay: false },
      proxy: appServerProxy,
      fs: {
        allow: [workspaceRoot, workspaceNodeModules, ...(embeddedWorkbenchEntryPath ? [path.dirname(embeddedWorkbenchEntryPath)] : [])],
      },
    },
    preview: {
      host: "0.0.0.0",
      allowedHosts: [],
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
      // Ship complete dependency notices with Web and Electron renderer assets.
      license: { fileName: "licenses/dependencies.md" },
      target: browserslistToEsbuild(browserTargets),
      // Vite 8 uses Rolldown + Oxc. Release builds keep the standard Oxc
      // minifier; aggressive secondary compression/mangling has caused
      // renderer hangs and is intentionally not part of the release contract.
      minify: "oxc",
      rolldownOptions: {
        preserveEntrySignatures: "allow-extension",
        input: rolldownInput,
        output: {
          // Explicit groups can create chunk cycles; preserve source ESM order.
          strictExecutionOrder: true,
          // Isolate stable third-party runtime from application/plugin hash churn.
          codeSplitting: { groups: [
            // Optional document engines also import server rendering helpers; keep those
            // with their lazy consumers instead of the startup React runtime.
            { name: "react-runtime", test: id => /\/node_modules\/(?:react|react-dom|scheduler)\//.test(id) && !/\/react-dom\/(?:server(?:[./-])|cjs\/react-dom-server)/.test(id), includeDependenciesRecursively: false },
            { name: "startup-composition", test: /\/runtime\/(?:web-workbench-supervisor|web-workbench-application)\.ts$/, includeDependenciesRecursively: false },
            // Keep the shared dynamic-import helper separate from entry-only
            // modulepreload side effects and their application hash references.
            { name: "vite-preload-runtime", test: /\0vite\/preload-helper\.js$/, includeDependenciesRecursively: false },
            { name: "workbench-entry", test: /\/src\/workbench-(?:entry\.ts|root\.tsx)(?:\?.*)?$/, includeDependenciesRecursively: false },
            { name: "workbench-shell", test: /\/apps\/workbench-web\/src\/app\.tsx$/, includeDependenciesRecursively: false },
            { name: "embedded-styles", test: /\.(?:scss|css)\?inline$/, includeDependenciesRecursively: false },
            // Notices and rename dialogs share generated typography. Keep their
            // styles together when another lazy management page shares a Modal,
            // so the common typography sheet is emitted once at startup.
            { name: "workbench-feedback-styles", test: /\/components\/(?:async-notices|conversation-rename-dialog)\.scss$/, includeDependenciesRecursively: false },
            { name: "workbench-context", test: /\/runtime\/(?:appserver-runtime-context\.tsx|workbench-application-services\.ts)$/, includeDependenciesRecursively: false },
            { name: "vendor", test: /\/node_modules\//, entriesAware: true, includeDependenciesRecursively: false },
            // Keep the demand-loaded math renderer out of small shared protocol
            // chunks. Their CSS otherwise becomes part of every startup closure.
            { name: "math-renderer", test: /\/packages\/chat-render-web\/src\/extensions\/katex\/(?:katex-math\.tsx|katex\.scss)$/, includeDependenciesRecursively: false },
            // Keep small demand-loaded information styles out of the shared
            // platform chunk; entriesAware's merge threshold would hoist them.
            { name: "information-panel", test: /\/packages\/design-system\/src\/information-panel\.web\.scss$/, includeDependenciesRecursively: false },
            { name: "platform", test: /\/packages\//, entriesAware: true, entriesAwareMergeThreshold: 4_000, includeDependenciesRecursively: false },
          ] },
          entryFileNames: releaseMinification ? "assets/a-[hash].js" : "assets/[name]-[hash].js",
          ...(releaseMinification ? {
          // Hardened releases expose only opaque content identities. Human
          // chunk/module names remain available in source builds and private
          // observability metadata, never in the public asset topology.
          chunkFileNames: "assets/a-[hash].js",
          assetFileNames: "assets/a-[hash][extname]",
          } : {}),
        },
      },
      // Hidden maps remain available to an error collector, while the release
      // publisher deliberately excludes them from the public static tree.
      sourcemap: releaseMinification ? false : "hidden",
      manifest: true,
      assetsDir: "assets",
      outDir: isElectronRenderer
        ? "dist-electron"
        : isEmbeddedWorkbenchBuild
          ? "dist-embedded-workbench"
          : "dist",
      copyPublicDir: !isEmbeddedWorkbenchBuild,
    },
  };
}

export default defineConfig(environment => createWorkbenchWebConfig(environment));
