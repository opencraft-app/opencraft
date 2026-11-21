const { getDefaultConfig } = require("expo/metro-config");
const compression = require("compression");
const path = require("node:path");

// Expo SDK 52+ discovers npm workspaces automatically. Keep this file free of
// nodeModulesPaths overrides so Metro and npm resolve one graph.
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("html", "ocasset");
const appDependencies = Object.keys(require("./package.json").dependencies);
const i18nRoot = path.resolve(__dirname, "../../packages/i18n/src") + path.sep;
const resolveDefault = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Shared ESM source uses .js specifiers for NodeNext. Metro consumes the
  // TypeScript source directly; translate only missing local files in our i18n owner.
  if (context.originModulePath.startsWith(i18nRoot) && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const typed = path.resolve(path.dirname(context.originModulePath), moduleName.slice(0, -3) + ".ts");
    if (require("node:fs").existsSync(typed)) moduleName = moduleName.slice(0, -3);
  }
  // A workspace can use a different React patch for its Web renderer. Native
  // components, shared hooks and RN's renderer must all use this app's React.
  const packageName = moduleName.startsWith("@") ? moduleName.split("/").slice(0, 2).join("/") : moduleName.split("/")[0];
  const origin = (packageName === "react" || packageName === "react-dom") && appDependencies.includes(packageName)
    ? { ...context, originModulePath: path.join(__dirname, "index.ts") } : context;
  return resolveDefault ? resolveDefault(origin, moduleName, platform) : origin.resolveRequest(origin, moduleName, platform);
};

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
