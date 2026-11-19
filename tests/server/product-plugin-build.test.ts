import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { productPluginPacks } from "../../apps/workbench-web/product-plugin-packs.vite";
import {
  splitProductPluginPacks,
  prepareProductPluginRelease,
} from "../../scripts/web-deployment/product-plugin-packs.mjs";
import { createWorkbenchWebServer } from "../../scripts/workbench-web-server.mjs";

test("actual Vite graph externalizes /@fs registrations and refuses leaked implementation", async (t) => {
  const root = await mkdtemp("/tmp/product-plugin-build-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const feature = join(root, "feature");
  await mkdir(feature);
  await writeFile(
    join(root, "index.html"),
    '<html><head></head><body><script type="module" src="/host.js"></script></body></html>',
  );
  const host = `import extension from '/@fs/${root}/registration.ts';import {singleton}from './shared.js';globalThis.fixture={extension,singleton};`;
  await writeFile(join(root, "host.js"), host);
  await writeFile(join(root, "registration.ts"), "export {default} from './feature/entry.js';");
  await writeFile(join(root, "shared.js"), "export const singleton={token:'shared_module_identity_fixture',count:0};");
  await writeFile(
    join(feature, "entry.js"),
    `import{singleton}from'../shared.js';import './style.css';export default{id:'fixture.app',load:()=>{singleton.count++;return {token:singleton.token,
    manifest:{id:'fixture.app',version:'0.1.0'},activate(){const node=document.createElement('div');node.className='fixture-owned';node.textContent=singleton.token;document.body.append(node);return()=>node.remove()}}}};`,
  );
  await writeFile(
    join(feature, "style.css"),
    ".fixture-owned{background-image:url(./image.svg);color:var(--color-text)}",
  );
  await writeFile(join(feature, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const config = () => ({
    configFile: false as const,
    root,
    logLevel: "silent" as const,
    plugins: [
      productPluginPacks([
        {
          id: "fixture.app",
          version: "0.1.0",
          registration: join(root, "registration.ts"),
          entry: join(feature, "entry.js"),
          implementationRoots: [feature],
          locales: [],
        },
      ]),
    ],
    build: { assetsInlineLimit: 0, outDir: join(root, "dist"), emptyOutDir: true },
  });
  await build(config());
  const inventory = JSON.parse(await readFile(join(root, "dist/product-plugins.json"), "utf8")),
    pack = inventory.packages[0];
  const files = await Promise.all(
    pack.files.map(async (file: any) => ({ ...file, code: await readFile(join(root, "dist", file.path), "utf8") })),
  );
  assert.ok(
    files.some((file) => file.path.endsWith(".svg")),
    "CSS asset dependency must be retained",
  );
  assert.equal(
    files.filter((file) => file.path.endsWith(".js") && file.code.includes("shared_module_identity_fixture")).length,
    1,
  );
  const manifest = JSON.parse(await readFile(join(root, "dist", pack.manifest), "utf8"));
  const factory = (await import(pathToFileURL(join(root, "dist", manifest.entry)).href)).default;
  assert.equal(factory.id, "fixture.app");
  assert.equal(factory.load().token, "shared_module_identity_fixture");
  assert.ok(pack.external.includes(manifest.entry));
  assert.ok(manifest.css.every((css: string) => pack.external.includes(css)));
  const index = await readFile(join(root, "dist/index.html"), "utf8");
  assert.ok(!index.includes("style.css"));
  if (process.env.OPENCRAFT_TEST_PRODUCT_PLUGIN_BROWSER === "1") {
    const metadata = await splitProductPluginPacks(join(root, "dist"), join(root, "runtime/product-plugins"));
    const assets = await prepareProductPluginRelease({
      releaseRoot: root,
      webRoot: join(root, "dist"),
      cacheDirectory: join(root, "persistent"),
      metadata,
    });
    const server = await createWorkbenchWebServer({
      root: join(root, "dist"),
      appServerTarget: null,
      productPluginAssets: assets,
    });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      for (const width of [390, 1440])
        for (const theme of ["light", "dark"] as const) {
          const context = await browser.newContext({
            viewport: { width, height: 850 },
            hasTouch: width === 390,
            colorScheme: theme,
          });
          const page = await context.newPage(),
            errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${address.port}`);
          // A browser expression avoids leaking the test runner's TS function-name
          // helpers into Playwright's serialized callbacks.
          const result = await page.evaluate(`(async () => {
          const core = document.createElement('style');core.textContent=${JSON.stringify(`:root{--color-text:${theme === "dark" ? "rgb(230, 235, 240)" : "rgb(29, 43, 57)"}}`)};document.head.append(core);
          const fixture = globalThis.fixture;
          const definition = await fixture.extension.load({ fetcher: fetch, getClient: () => undefined });
          const dispose = await definition.activate({ signal: new AbortController().signal });
          const color = getComputedStyle(document.querySelector('.fixture-owned')).color;
          const styles = document.querySelectorAll('[data-opencraft-product-plugin-style]').length;
          const count = fixture.singleton.count;
          await dispose();
          return { color, styles, count, removed: !document.querySelector('.fixture-owned'),
            remaining: document.querySelectorAll('[data-opencraft-product-plugin-style]').length, coreRetained: core.isConnected };
        })()`);
          assert.deepEqual(result, {
            color: theme === "dark" ? "rgb(230, 235, 240)" : "rgb(29, 43, 57)",
            styles: 1,
            count: 1,
            removed: true,
            remaining: 0,
            coreRetained: true,
          });
          assert.deepEqual(errors, []);
          await context.close();
        }
    } finally {
      await browser.close();
      await server.close();
    }
  }
  // Independent releases may render different import ordering under an equal
  // bundler hash. Their shared JS URLs must still be distinct for old readers.
  await build(config());
  const next = JSON.parse(await readFile(join(root, "dist/product-plugins.json"), "utf8")).packages[0];
  const sharedJs = (value: any) =>
    value.files
      .filter((file: any) => file.path.startsWith("assets/") && file.path.endsWith(".js"))
      .map((file: any) => file.path);
  assert.ok(sharedJs(pack).length > 0);
  assert.deepEqual(
    sharedJs(next).filter((file: string) => sharedJs(pack).includes(file)),
    [],
    "shared JavaScript URLs belong to one immutable pack release",
  );
  const resources = (value: any) =>
    value.files.filter((file: any) => /\.(css|svg)$/.test(file.path)).map((file: any) => file.path);
  assert.ok(resources(pack).some((file: string) => file.endsWith(".css")));
  assert.ok(resources(pack).some((file: string) => file.endsWith(".svg")));
  assert.deepEqual(
    resources(next).filter((file: string) => resources(pack).includes(file)),
    [],
    "CSS/media URLs and encoding sidecars belong to one immutable pack release",
  );
  await writeFile(
    join(root, "host.js"),
    host + "import implementation from './feature/entry.js';globalThis.leaked=implementation;",
  );
  await assert.rejects(build(config()), /implementation leaked into the application/);
});
