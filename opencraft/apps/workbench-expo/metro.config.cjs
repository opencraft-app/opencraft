const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const compression = require("compression");

// Expo SDK 52+ discovers npm workspaces automatically. Keep this file free of
// watchFolders/nodeModulesPaths overrides so Metro and npm resolve one graph.
const config = withUniwindConfig(getDefaultConfig(__dirname), {
  cssEntryFile: "./global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});

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
