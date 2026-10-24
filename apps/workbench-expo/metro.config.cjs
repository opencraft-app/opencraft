const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const compression = require("compression");
const path = require("node:path");
const { resolveProductEntry, resolveProductRouterContext, resolveProductStyles, withProductEntryResolver } = require("./product-entry.cjs");

// Expo SDK 52+ discovers npm workspaces automatically. Keep this file free of
// nodeModulesPaths overrides so Metro and npm resolve one graph. An explicit
// downstream entry adds only its own directory to the watched graph.
const productStyles = resolveProductStyles(__dirname);
const config = withUniwindConfig(getDefaultConfig(__dirname), {
  // Uniwind joins this input with cwd; an absolute path bypasses its CSS transformer.
  cssEntryFile: productStyles ? path.relative(__dirname, productStyles) : "./global.css",
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
const productEntry = resolveProductEntry(__dirname);
if (productEntry) {
  config.watchFolders = [...new Set([...config.watchFolders, require("node:path").dirname(productEntry)])];
}
config.resolver.resolveRequest = withProductEntryResolver(__dirname, productEntry, config.resolver.resolveRequest, resolveProductRouterContext(__dirname), Object.keys(require("./package.json").dependencies));

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
