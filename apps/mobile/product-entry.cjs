const fs = require("node:fs");
const path = require("node:path");

// These are trusted local build inputs, never runtime URL parameters.
function localProductFile(value, { workspaceRoot, extensions, name }) {
  if (!value) return null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error(`${name} must be a local file`);
  const filename = path.resolve(workspaceRoot, value);
  if (!extensions.includes(path.extname(filename)) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    throw new Error(`${name} must name an existing ${extensions.join("/")} file`);
  }
  return fs.realpathSync(filename);
}

function resolveProductEntry(appRoot, env = process.env) {
  return localProductFile(env.OPENCRAFT_EXPO_PRODUCT_ENTRY, {
    workspaceRoot: path.resolve(appRoot, "../.."),
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    name: "OPENCRAFT_EXPO_PRODUCT_ENTRY",
  });
}

function resolveProductRouterContext(appRoot, env = process.env) {
  return localProductFile(env.OPENCRAFT_EXPO_ROUTER_CONTEXT_ENTRY, {
    workspaceRoot: path.resolve(appRoot, "../.."),
    extensions: [".ts", ".tsx", ".js"], name: "OPENCRAFT_EXPO_ROUTER_CONTEXT_ENTRY",
  });
}

function resolveProductStyles(appRoot, env = process.env) {
  return localProductFile(env.OPENCRAFT_EXPO_PRODUCT_STYLES, {
    workspaceRoot: path.resolve(appRoot, "../.."),
    extensions: [".css"], name: "OPENCRAFT_EXPO_PRODUCT_STYLES",
  });
}

function withProductEntryResolver(appRoot, entry, delegate, routerContext = null, hostDependencies = []) {
  return (context, moduleName, platform) => {
    if (entry && routerContext && moduleName === "expo-router/_ctx") {
      return { type: "sourceFile", filePath: routerContext };
    }
    if (entry && moduleName === "./src/runtime/app-entry"
      && path.resolve(context.originModulePath) === path.join(appRoot, "index.ts")) {
      return { type: "sourceFile", filePath: entry };
    }
    // Shared native components and downstream views consume the host's SDK,
    // including React/provider contexts, even across source-workspace roots.
    // Private dependencies remain resolved from their actual product owner.
    const packageName = moduleName.startsWith("@") ? moduleName.split("/").slice(0, 2).join("/") : moduleName.split("/")[0];
    const relativeOrigin = path.relative(path.resolve(appRoot, "../.."), context.originModulePath);
    const isDownstreamOrigin = relativeOrigin === ".." || relativeOrigin.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOrigin);
    const origin = entry && isDownstreamOrigin && hostDependencies.includes(packageName)
      ? { ...context, originModulePath: path.join(appRoot, "index.ts") } : context;
    return delegate ? delegate(origin, moduleName, platform) : origin.resolveRequest(origin, moduleName, platform);
  };
}

function configureProduct(appRoot, context, env = process.env) {
  const filename = localProductFile(env.OPENCRAFT_EXPO_PRODUCT_CONFIG, {
    workspaceRoot: path.resolve(appRoot, "../.."), extensions: [".cjs"], name: "OPENCRAFT_EXPO_PRODUCT_CONFIG",
  });
  if (!filename) return context.config;
  const configure = require(filename);
  if (typeof configure !== "function") throw new Error("Expo product config must export a function");
  return configure(context);
}

module.exports = { resolveProductEntry, resolveProductRouterContext, resolveProductStyles, withProductEntryResolver, configureProduct };
