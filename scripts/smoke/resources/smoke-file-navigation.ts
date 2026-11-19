import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const output = await mkdtemp(join(tmpdir(), "opencraft-file-navigation-"));
// A self-contained PDF fixture exercises the real PDF viewer, not a mock panel.
function pdfFixture() {
  const content = "BT /F1 20 Tf 30 330 Td (PDF tree preview) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf).toString("base64");
}
const runtime = `
const reads=[];window.fixtureReads=reads;
const runtime={resources:{host:{canRequest:method=>method==='fuzzyFileSearch/sessionStart'||method==='fs/writeFile'},fileSystem:{
async getMetadata(path){const dir=path==='/workspace/fixture'||path==='/workspace/fixture/nested';return {isFile:!dir,isDirectory:dir,modifiedAtMs:0,size:100}},
async readFile(path){reads.push(path);return {dataBase64:path.endsWith('.pdf')?'${pdfFixture()}':btoa('const aVeryLongVariableName = '+JSON.stringify('long source line '.repeat(14))+';'+String.fromCharCode(10)+'export const value = 1;')}},
async readDirectory(path){return {entries:path==='/workspace/fixture'? [{fileName:'report.pdf',isDirectory:false,isFile:true},{fileName:'nested',isDirectory:true,isFile:false},...Array.from({length:35},(_,i)=>({fileName:'report-'+i+'.ts',isDirectory:false,isFile:true}))]:[{fileName:'child.html',isDirectory:false,isFile:true}]}},
async createFuzzyFileSearchSession(options){return {update:async(query)=>{options.onUpdated({query,files:[{root:'/workspace/fixture',path:'report-0.ts',file_name:'report-0.ts',match_type:'file'}]});options.onCompleted()},stop:async()=>{}}}
}}};
export const useAppServerRuntime=()=>runtime;
export const useBlobResources=()=>window.fixtureBlobs;
export const useAppServerSnapshot=()=>({hostId:'tree-fixture',conversation:{execution:{cwd:'/workspace/fixture',runtimeWorkspaceRoots:['/workspace/fixture']}}});`;
const source = `
import '/apps/workbench-web/src/runtime/web-crypto-compat.ts';
import React from 'react';import {Context} from '@deepseek-ai/cordis';import {BlobResourceService} from '@opencraft/blob-resources';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {WorkspaceResourcePanel} from '/apps/workbench-web/src/panels/workspace-resource-panel.tsx';
import '/apps/workbench-web/src/styles/app.scss';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';initializeAppearanceTheme();setThemePreference(location.search.includes('dark')?'dark':'light');if(!location.search.includes('mouse'))document.documentElement.setAttribute('data-touch-interaction','');const context=new Context();await context.plugin(BlobResourceService);window.fixtureBlobs=context.blobResources;
createIntlTestRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><div style={{height:'100vh'}}><WorkspaceResourcePanel tab={{id:'file',kind:'resource',title:'report',resource:'/workspace/fixture',region:'right',closable:true,preview:false}}/></div></QueryClientProvider>);`;
const vite = await createServer({
  configFile: false,
  cacheDir: join(output, "vite-cache"),
  optimizeDeps: { include: ["@codemirror/lang-javascript", "@codemirror/lang-css"] },
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [process.cwd(), output] } },
  plugins: [
    react(),
    {
      name: "file-tree-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (id.endsWith("/appserver-runtime-context") && importer?.includes("/panels/")) return "/tree-runtime.ts";
        return ["/tree-runtime.ts", "/tree-fixture.tsx"].includes(id) ? id : null;
      },
      load: (id) => (id === "/tree-runtime.ts" ? runtime : id === "/tree-fixture.tsx" ? source : null),
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tree-fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: any;
try {
  await vite.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true });

  // Warm the full lazy editor graph before measuring; Vite's initial discovery can invalidate optimized URLs.
  const warm = await browser.newPage({ hasTouch: true });
  await warm.addInitScript("window.__name=value=>value");
  await warm.goto("http://127.0.0.1:" + (vite.httpServer!.address() as any).port, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await warm.locator(".workspace-directory__row").filter({ hasText: "report-0.ts" }).tap();
  await warm.locator(".cm-editor").waitFor();
  await warm.waitForLoadState("networkidle");
  await warm.close();
  const evidence = [];
  for (const touch of [false, true])
    for (const width of [390, 1000])
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: touch });
        const errors: string[] = [];
        page.setDefaultTimeout(60000);
        page.on("response", (response) => {
          if (response.status() >= 400) console.log("HTTP", response.status(), response.url());
        });
        page.on("console", (msg) => {
          if (msg.type() === "error") console.log("CONSOLE", msg.text());
        });
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.addInitScript("window.__name=value=>value");
        await page.goto(
          "http://127.0.0.1:" + (vite.httpServer!.address() as any).port + "/?" + theme + (touch ? "" : "&mouse"),
          { waitUntil: "domcontentloaded", timeout: 60000 },
        );
        // Use actual mouse clicks in pointer contexts and touch taps in touch contexts.
        const activate = async (locator: any) => (touch ? locator.tap() : locator.click());
        const rows = page.locator(".workspace-directory__row");
        await rows.first().waitFor();
        const rowHeight = (await rows.first().boundingBox())!.height;
        assert.ok(
          width === 390 ? rowHeight >= 52 : touch ? rowHeight >= 40 : rowHeight < 45,
          "density follows capacity and touch hit target",
        );
        if (width === 1000) {
          await activate(page.getByRole("button", { name: "Show file tree", exact: true }));
          assert.ok(
            (await page.locator(".workspace-file-browser").boundingBox())!.width <= 260,
            "navigation does not grow with the content pane",
          );
          const directorySearch = page.locator(".workspace-directory > .workspace-file-search");
          assert.equal(await directorySearch.isVisible(), false, "tree search is the primary search in split view");
          assert.equal(
            await rows.filter({ hasText: "report-0.ts" }).locator(".workspace-directory__chevron").count(),
            0,
          );
          await page.screenshot({
            path: join(output, theme + "-" + (touch ? "touch" : "mouse") + "-split-default.png"),
          });
          await activate(page.locator(".workspace-directory__tools button"));
          await page.getByRole("textbox", { name: "Filter this folder" }).fill("report-0");
          assert.equal(await rows.count(), 1);
          await page.setViewportSize({ width: 390, height: 800 });
          assert.equal(await page.locator(".workspace-file-browser").isVisible(), false);
          assert.equal(await page.getByRole("textbox", { name: "Filter this folder" }).inputValue(), "report-0");
          await page.setViewportSize({ width: 1000, height: 800 });
          assert.equal(await page.locator(".workspace-file-browser").isVisible(), true);
          await page.getByRole("textbox", { name: "Filter this folder" }).fill("");
          await activate(page.locator(".workspace-directory__tools button"));
          assert.equal(await directorySearch.isVisible(), false, "empty filter can collapse again");
          await page.screenshot({ path: join(output, theme + "-" + (touch ? "touch" : "mouse") + "-split.png") });
          await activate(page.getByRole("button", { name: "Hide file tree", exact: true }));
        }

        assert.equal(await rows.count(), 37);
        const path = page.getByRole("navigation", { name: "File path" });
        assert.equal(await path.getByRole("button").count(), 3, "older ancestors collapse into one menu");
        assert.ok(!(await path.innerText()).includes("opencraft-demo"), "remote ancestors are tucked away");
        assert.ok((await path.innerText()).includes("projectless-workspaces"));
        assert.ok(
          await path.evaluate((el) => el.scrollWidth <= el.clientWidth),
          "long ancestors never overflow the pane",
        );
        await activate(path.getByRole("button", { name: "File path", exact: true }));
        await page.getByRole("menuitem", { name: "opencraft-demo", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "hidden" });
        const search = await page.locator(".workspace-directory > .workspace-file-search").boundingBox();
        const trail = await path.boundingBox();
        assert.ok(search!.y - (trail!.y + trail!.height) < 12, "no empty editor feedback slot above directory search");
        await page.screenshot({
          path: join(output, theme + "-" + width + "-" + (touch ? "touch" : "mouse") + "-directory.png"),
        });
        const listing = page.locator(".workspace-directory__list");
        await listing.evaluate((el: HTMLElement) => (el.scrollTop = 200));
        const top = await listing.evaluate((el: HTMLElement) => el.scrollTop);
        await activate(rows.filter({ hasText: "report-10.ts" }));
        await page.locator(".cm-editor").waitFor();
        assert.equal(await page.locator(".cm-lineWrapping").count(), 0);
        assert.ok(await page.locator(".cm-scroller").evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth));
        if (width === 390) {
          assert.equal(await page.locator(".workspace-file-browser").isVisible(), false);
          assert.ok((await page.locator(".workspace-file-viewer").boundingBox())!.width >= 389);
          assert.ok((await page.locator(".cm-editor").boundingBox())!.y < 150);
          await activate(page.locator(".workspace-file-back"));
        } else {
          await activate(page.getByRole("button", { name: "Show file tree", exact: true }));
          assert.equal(await page.locator(".workspace-file-browser").isVisible(), true);
          await page.setViewportSize({ width: 390, height: 800 });
          assert.equal(await page.locator(".workspace-file-browser").isVisible(), false);
          await activate(page.locator(".workspace-file-back"));
        }
        await rows.first().waitFor();
        assert.ok((await listing.evaluate((el: HTMLElement) => el.scrollTop)) > 0, "return restores directory scroll");
        const filter = page.getByRole("textbox", { name: "Filter this folder" });
        await filter.fill("report-0");
        await activate(rows.filter({ hasText: "report-0.ts" }));
        await page.locator(".cm-editor").waitFor();
        await activate(page.getByRole("button", { name: "Edit", exact: true }));
        await page.locator(".cm-content").fill("unsaved draft");
        await activate(page.locator(".workspace-file-back"));
        await rows.first().waitFor();
        assert.equal(await filter.inputValue(), "report-0");
        await activate(rows.filter({ hasText: "report-0.ts" }));
        await page.locator(".cm-editor").waitFor();
        assert.equal(await page.locator(".cm-content").innerText(), "unsaved draft");
        await page.screenshot({
          path: join(output, theme + "-" + width + "-" + (touch ? "touch" : "mouse") + "-reader.png"),
        });
        assert.deepEqual(errors, []);
        evidence.push({ width, theme, touch, rowHeight, top });
        await page.close();
      }
  console.log(JSON.stringify({ passed: true, evidence, output }));
} finally {
  await browser?.close();
  await vite.close();
}
