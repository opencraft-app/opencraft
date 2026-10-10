const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const compression = require("compression");

// Expo SDK 52+ discovers npm workspaces automatically. Keep this file free of
// watchFolders/nodeModulesPaths overrides so Metro and npm resolve one graph.
const config = withUniwindConfig(getDefaultConfig(__dirname), {
  cssEntryFile: "./global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
config.resolver.assetExts.push("html");
// Adapt only HeroUI's Web theme reader; keep Uniwind's existing resolver chain.
const resolveThemeRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = resolveThemeRequest
    ? resolveThemeRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
  if (platform === "web" && resolved.type === "sourceFile"
    && /heroui-native\/.*\/hooks\/use-theme-color\.(?:js|ts)$/.test(resolved.filePath.replaceAll("\\", "/"))) {
    return { type: "sourceFile", filePath: require("node:path").join(__dirname, "src/runtime/heroui-theme-color.web.ts") };
  }
  return resolved;
};
// A separate export surface, using the same Expo graph and shared controls.
if (process.env.OPENCRAFT_EXPO_SURFACE === "agents-next") {
  const path = require("node:path");
  const resolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (platform === "web" && moduleName === "./src/runtime/app-entry") {
      return { type: "sourceFile", filePath: path.join(__dirname, "src/runtime/agents-web-entry.tsx") };
    }
    return resolveRequest
      ? resolveRequest(context, moduleName, platform)
      : context.resolveRequest(context, moduleName, platform);
  };
}

const enhanceMiddleware = config.server.enhanceMiddleware;
const gzipBundle = compression({ level: 1 });
const bundleRedirectOrigin = process.env.OPENCRAFT_EXPO_BUNDLE_ORIGIN;
if (bundleRedirectOrigin && new URL(bundleRedirectOrigin).protocol !== "https:") {
  throw new Error("OPENCRAFT_EXPO_BUNDLE_ORIGIN must be an HTTPS origin");
}
config.server.enhanceMiddleware = (middleware, server) => {
  const enhanced = enhanceMiddleware(middleware, server);
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const isBundle = url.pathname.endsWith(".bundle");
    if (isBundle && bundleRedirectOrigin && /^[-\w]+\.exp\.direct(?::\d+)?$/i.test(request.headers.host ?? "")) {
      const target = new URL(url.pathname + url.search, bundleRedirectOrigin);
      response.writeHead(307, { Location: target.href, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (isBundle) {
      return gzipBundle(request, response, () => enhanced(request, response, next));
    }
    return enhanced(request, response, next);
  };
};

module.exports = config;
