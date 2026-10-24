import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { createWorkbenchWebConfig } from "../../../apps/workbench-web/vite.config";

// Exercise released modules in a real engine, not a spoofed user agent. No
// authentication, remote Host, private profile or model is needed for startup.
const temporary = await mkdtemp(path.join(tmpdir(), "opencraft-browser-bootstrap-"));
const previousTarget = process.env.OPENCRAFT_BUILD_TARGET;
const previousEntry = process.env.OPENCRAFT_EMBEDDED_PRODUCT_ENTRY;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;
try {
  process.env.OPENCRAFT_BUILD_TARGET = "embedded-workbench";
  process.env.OPENCRAFT_EMBEDDED_PRODUCT_ENTRY = "tests/fixtures/browser-bootstrap-product.js";
  const config = createWorkbenchWebConfig({ mode: "production", command: "build" });
  await build({ ...config, configFile: false, logLevel: "error",
    // This synthetic product intentionally calls APIs forbidden in owned app
    // sources, to catch dependency evaluation before the compatibility boundary.
    plugins: (config.plugins ?? []).filter(plugin => !plugin || !("name" in plugin) || plugin.name !== "opencraft-browser-compatibility"),
    build: { ...config.build, outDir: temporary, emptyOutDir: true },
  });
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/fixture" || url.pathname === "/without-shims") {
        response.setHeader("content-type", "text/html");
        const entry = url.pathname === "/fixture" ? "/__opencraft/embedded-workbench.js" : "/unshimmed.js";
        response.end(`<script type="module">import(${JSON.stringify(entry)}).catch(e => { globalThis.fixtureError = String(e); });</script>`);
        return;
      }
      if (url.pathname === "/unshimmed.js") {
        response.setHeader("content-type", "text/javascript");
        response.end(await readFile("tests/fixtures/browser-bootstrap-product.js"));
        return;
      }
      const embedded = url.pathname.startsWith("/__opencraft/");
      const relative = embedded ? url.pathname.slice("/__opencraft/".length) : url.pathname.slice(1) || "index.html";
      const root = embedded ? temporary : path.resolve("apps/workbench-web/dist");
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) throw new Error("Invalid asset path");
      response.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2" } as Record<string, string>)[path.extname(file)] ?? "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox"],
  });
  const version = browser.version();
  if (process.env.OPENCRAFT_EXPECT_CHROMIUM_MAJOR) {
    assert.equal(version.split(".")[0], process.env.OPENCRAFT_EXPECT_CHROMIUM_MAJOR, "The minimum-engine check must use a real pinned browser");
  }
  for (const removeApis of [false, true]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.addInitScript(({ removeApis }) => {
      const root = globalThis as typeof globalThis & { Iterator?: { prototype: object }; compatNative?: unknown };
      if (removeApis) {
        const iterator = root.Iterator?.prototype;
        if (iterator) for (const name of ["map", "filter", "take", "toArray"]) Reflect.deleteProperty(iterator, name);
        Reflect.deleteProperty(Promise, "withResolvers");
        Reflect.deleteProperty(Object, "groupBy");
        Reflect.deleteProperty(Map, "groupBy");
        for (const name of ["union", "difference", "intersection"]) Reflect.deleteProperty(Set.prototype, name);
      }
      root.compatNative = {
        map: root.Iterator && Reflect.get(root.Iterator.prototype, "map"),
        withResolvers: Reflect.get(Promise, "withResolvers"),
      };
    }, { removeApis });
    // Negative control in its own page/realm: the same product must fail when
    // evaluated without the boundary in the old engine or with APIs removed.
    const control = await context.newPage();
    await control.goto(`http://127.0.0.1:${port}/without-shims`);
    const lacksMap = await control.evaluate("typeof new Map().values().map !== 'function'");
    await control.waitForFunction("globalThis.fixtureResult || globalThis.fixtureError");
    if (lacksMap || removeApis) assert.match(await control.evaluate("globalThis.fixtureError"), /not a function/);
    await control.close();
    // Top-level product API use must work before custom-element registration.
    await page.goto(`http://127.0.0.1:${port}/fixture`);
    await page.waitForFunction("globalThis.fixtureResult || globalThis.fixtureError");
    assert.equal(await page.evaluate("globalThis.fixtureError"), undefined);
    assert.deepEqual(await page.evaluate("globalThis.fixtureResult"), {
      pages: ["page-1"], grouped: [1, 3], mapGrouped: [2], union: [1, 2], resolved: 7,
      nativeMapRetained: true, nativePromiseRetained: true, registered: true,
    });
    await page.reload();
    await page.waitForFunction("globalThis.fixtureResult || globalThis.fixtureError");
    assert.equal(await page.evaluate("globalThis.fixtureError"), undefined);
    assert.deepEqual(errors, []);
    // Actual built public Workbench, including application creation/restore.
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator(".app-shell-root").waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await page.locator(".runtime-error, .startup-shell").count(), 0);
    assert.equal(await page.locator("#opencraft-release-failure").count(), 0);
    await page.reload();
    await page.locator(".app-shell-root").waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await page.locator(".runtime-error, .startup-shell").count(), 0);
    assert.equal(await page.locator("#opencraft-release-failure").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ version, embeddedTopLevelAndReload: true, workbenchStartupAndReload: true, missingAndNativeApis: true }));
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  await rm(temporary, { recursive: true, force: true });
  if (previousTarget === undefined) delete process.env.OPENCRAFT_BUILD_TARGET;
  else process.env.OPENCRAFT_BUILD_TARGET = previousTarget;
  if (previousEntry === undefined) delete process.env.OPENCRAFT_EMBEDDED_PRODUCT_ENTRY;
  else process.env.OPENCRAFT_EMBEDDED_PRODUCT_ENTRY = previousEntry;
}
