const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveProductEntry, resolveProductRouterContext, resolveProductStyles, withProductEntryResolver, configureProduct } = require("../../apps/mobile/product-entry.cjs");
const appRoot = path.resolve(__dirname, "../../apps/mobile");
const base = require("../../apps/mobile/app.json").expo;

test("public Expo defaults preserve core config and do not select a product", () => {
  assert.equal(resolveProductEntry(appRoot, {}), null);
  assert.equal(configureProduct(appRoot, { config: base }, {}), base);
  assert.equal(configureProduct(appRoot, { config: base }, { OPENCRAFT_IOS_RELEASE: "1" }), base);
});

test("product route contexts and styles require existing trusted local files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "expo product resources "));
  try {
    for (const [resolve, key, extension] of [[resolveProductRouterContext, "OPENCRAFT_EXPO_ROUTER_CONTEXT_ENTRY", ".js"], [resolveProductStyles, "OPENCRAFT_EXPO_PRODUCT_STYLES", ".css"]]) {
      assert.equal(resolve(appRoot, {}), null);
      const file = path.join(temp, "resource" + extension);
      fs.writeFileSync(file, "/* fixture */");
      assert.equal(resolve(appRoot, { [key]: file }), fs.realpathSync(file));
      for (const invalid of ["https://example.test/resource" + extension, temp, file + ".missing"]) {
        assert.throws(() => resolve(appRoot, { [key]: invalid }));
      }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("downstream routes retain Router entry and share one host SDK without redirecting private modules", () => {
  const calls = [];
  const delegate = (context, name, platform) => { calls.push({ context, name, platform }); return { type: "sourceFile", filePath: "delegated" }; };
  const context = { originModulePath: "/product/view.tsx", marker: "preserved" };
  const resolve = withProductEntryResolver(appRoot, "/product/entry.ts", delegate, "/product/routes.js", ["react", "react-native", "@expo/metro-runtime"]);
  for (const platform of ["web", "ios", "android"]) {
    assert.equal(resolve(context, "expo-router/_ctx", platform).filePath, "/product/routes.js");
    for (const name of ["react", "react/jsx-runtime", "react-native", "@expo/metro-runtime"]) {
      assert.equal(resolve(context, name, platform).filePath, "delegated");
      assert.equal(calls.at(-1).context.originModulePath, path.join(appRoot, "index.ts"));
      assert.equal(calls.at(-1).context.marker, "preserved");
    }
    for (const name of ["./local", "@private/account", "expo-router/build/qualified-entry"]) {
      resolve(context, name, platform);
      assert.equal(calls.at(-1).context, context);
    }
  }
  // SDK resolvers inspect their caller to avoid wrapping their own adapters.
  // Replacing that origin makes Uniwind's CSS sheet wrapper import itself.
  const sdkContext = { originModulePath: path.resolve(appRoot, "../../node_modules/uniwind/dist/module/components/web/createOrderedCSSStyleSheet.js"), marker: "sdk" };
  resolve(sdkContext, "react-native", "web");
  assert.equal(calls.at(-1).context, sdkContext);
  assert.equal(context.originModulePath, "/product/view.tsx");
  const publicResolve = withProductEntryResolver(appRoot, null, delegate, "/product/routes.js", ["react"]);
  publicResolve(context, "react", "ios");
  assert.equal(calls.at(-1).context.originModulePath, path.join(appRoot, "index.ts"));
  publicResolve(context, "expo-router/_ctx", "ios");
  assert.equal(calls.at(-1).name, "expo-router/_ctx");
});

test("explicit local product files resolve from the workspace and reject URL/missing/directory inputs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "expo product "));
  try {
    const entry = path.join(temp, "entry.tsx");
    fs.writeFileSync(entry, "export {};\n");
    assert.equal(resolveProductEntry(appRoot, { OPENCRAFT_EXPO_PRODUCT_ENTRY: path.relative(path.resolve(appRoot, "../.."), entry) }), fs.realpathSync(entry));
    for (const invalid of ["https://example.test/entry.tsx", path.join(temp, "missing.ts"), temp]) {
      assert.throws(() => resolveProductEntry(appRoot, { OPENCRAFT_EXPO_PRODUCT_ENTRY: invalid }));
    }
    const config = path.join(temp, "config.cjs");
    fs.writeFileSync(config, "module.exports = ({config}) => ({...config, name:'Selected product'});\n");
    assert.equal(configureProduct(appRoot, { config: base }, { OPENCRAFT_EXPO_PRODUCT_CONFIG: config }).name, "Selected product");
    fs.writeFileSync(path.join(temp, "invalid.cjs"), "module.exports = {};\n");
    assert.throws(() => configureProduct(appRoot, { config: base }, { OPENCRAFT_EXPO_PRODUCT_CONFIG: path.join(temp, "invalid.cjs") }), /function/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Metro replaces only the root entry and delegates the existing resolver on every platform", () => {
  const calls = [];
  const delegate = (...args) => { calls.push(args); return { type: "sourceFile", filePath: "original" }; };
  const context = { originModulePath: path.join(appRoot, "index.ts") };
  const resolve = withProductEntryResolver(appRoot, "/trusted/product.ts", delegate);
  for (const platform of ["web", "ios", "android"]) {
    assert.equal(resolve(context, "./src/runtime/app-entry", platform).filePath, "/trusted/product.ts");
    assert.equal(resolve(context, "other", platform).filePath, "original");
    assert.equal(resolve({ ...context, originModulePath: path.join(appRoot, "other.ts") }, "./src/runtime/app-entry", platform).filePath, "original");
  }
  assert.equal(calls.length, 6);
  const fallback = withProductEntryResolver(appRoot, null, null);
  assert.equal(fallback({ ...context, resolveRequest: delegate }, "./src/runtime/app-entry", "web").filePath, "original");
});

// Multiple workspace React versions must not split hooks from the native renderer.
test("shared hooks and the native renderer resolve React from the mobile host", () => {
  const calls = [];
  const delegate = (context, name) => { calls.push({ context, name }); return { type: "sourceFile", filePath: "delegated" }; };
  const resolve = withProductEntryResolver(appRoot, null, delegate, null, ["react", "react-dom", "react-native"]);
  for (const relative of ["../../packages/i18n/src/react.tsx", "../../node_modules/react-native/Libraries/Renderer/ReactFabric.js"]) {
    const context = { originModulePath: path.resolve(appRoot, relative) };
    for (const name of ["react", "react/jsx-runtime", "react-dom"]) {
      resolve(context, name, "ios");
      assert.equal(calls.at(-1).context.originModulePath, path.join(appRoot, "index.ts"));
    }
    resolve(context, "./local-helper", "ios");
    assert.equal(calls.at(-1).context, context);
  }
});
