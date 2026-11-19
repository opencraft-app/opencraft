import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer, build } from "vite";
import { readFile } from "node:fs/promises";
const { chromium } = await import("playwright");
const alias = {
  name: "scope-fixture-alias",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (source.endsWith("/appserver-runtime-context") && importer?.includes("/panels/"))
      return resolve("tests/fixtures/workspace-scope-runtime.ts");
  },
};
const out = resolve("node_modules/.scope-fixture-build");
await build({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  plugins: [alias],
  build: {
    target: "es2022",
    outDir: out,
    manifest: true,
    rolldownOptions: { input: resolve("tests/fixtures/workspace-scope-preview.tsx") },
  },
});
const manifest = JSON.parse(await readFile(resolve(out, ".vite/manifest.json"), "utf8"));
const entry = manifest["tests/fixtures/workspace-scope-preview.tsx"];
const html = `<html><head>${(entry.css ?? []).map((c: string) => `<link rel="stylesheet" href="/${c}">`).join("")}</head><body><div id="host"></div><script type="module" src="/${entry.file}"></script></body></html>`;
const vite = await createServer({
  configFile: false,
  root: out,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "html",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(html);
        });
      },
    },
  ],
});

let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    const http: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/__opencraft_files")) http.push(r.url());
    });
    await page.goto("http://127.0.0.1:" + (vite.httpServer!.address() as { port: number }).port);
    await page
      .getByText("PRIVATE_A", { exact: true })
      .waitFor()
      .catch(async (e) => {
        console.error(await page.locator("body").innerText());
        throw e;
      });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator('.cm-content[contenteditable="true"]').fill("UNSAVED_A");
    await page.getByRole("button", { name: "Scope B", exact: true }).click();
    await page.getByText("PRIVATE_B", { exact: true }).waitFor();
    assert.equal(await page.getByText("PRIVATE_A", { exact: true }).count(), 0);
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download file", exact: true }).click();
    const download = await downloading;
    assert.equal(await readFile((await download.path())!, "utf8"), "PRIVATE_B");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.locator('.cm-content[contenteditable="true"]').fill("SAVED_B");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .waitForFunction(() => (window as any).scopeEvidence.values.B === "SAVED_B")
      .catch(async (e) => {
        console.error(await page.locator("body").innerText(), await page.evaluate(() => (window as any).scopeEvidence));
        throw e;
      });
    await page.getByRole("button", { name: "Scope A", exact: true }).click();
    await page
      .getByText("UNSAVED_A", { exact: true })
      .waitFor()
      .catch(async (e) => {
        console.error(await page.locator("body").innerText());
        throw e;
      });
    await page.getByRole("button", { name: "Scope denied", exact: true }).click();
    await page
      .waitForFunction(() => document.body.innerText.includes("Could not read this file."))
      .catch(async (e) => {
        console.error(await page.locator("body").innerText(), await page.evaluate(() => (window as any).scopeEvidence));
        throw e;
      });
    const evidence = await page.evaluate(() => (window as any).scopeEvidence);
    assert.equal(evidence.local, 0);
    assert.deepEqual(evidence.writes, ["B"]);
    assert.equal(evidence.values.A, "PRIVATE_A");
    assert.deepEqual(http, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mobile, evidence, http }));
    await context.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
