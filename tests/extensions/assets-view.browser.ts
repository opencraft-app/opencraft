import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

// Production view, catalogs, controls and lifecycle, with a synthetic authenticated
// backend. No enterprise adapter, cloud allocation or production data is loaded.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/public-assets");
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createAssetsView} from '/plugins/assets/src/view.tsx';
import {e2bAssetProvider} from '/plugins/assets/src/providers.ts';
import {gitAssetProviders} from '/plugins/assets/src/git/client.tsx';
import {AssetsEntry} from '/plugins/assets/src/entry.tsx';
import {WorkbenchPresentationRootProvider} from '/apps/workbench-web/src/components/workbench-presentation-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
let scope='local:fixture-a',writes=0,lost=false,delayed,finishDelayed;
const listeners=new Set(),documents=new Map();
const documentFor=()=>{if(!documents.has(scope))documents.set(scope,{scope,revision:0,allowCustomEndpoints:false,credentials:[],environments:[]});return documents.get(scope)};
const account={getScope:()=>scope,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},refresh:async()=>{}};
const fetcher=async(url,options)=>{
 if(url!=='/fixture-assets')throw Error('Unexpected destination');
 const fixed=scope,doc=structuredClone(documentFor());
 if(options.headers['x-opencraft-account-scope']!==fixed)return new Response('{}',{status:409});
 if(options.method==='POST'){
  writes++;const input=JSON.parse(options.body);
  if(input.revision!==doc.revision)return new Response(JSON.stringify({error:'conflict'}),{status:409});
  if(input.action==='save-credential'){doc.credentials.push({id:'connection-'+writes,name:input.name,apiUrl:input.apiUrl,sandboxUrl:input.sandboxUrl,generation:'generation-'+writes})}
  else if(input.action==='save-environment'){doc.environments.push({id:'environment-'+writes,name:input.name,credentialId:input.credentialId,templateId:input.templateId})}
  else throw Error('Unexpected mutation');
  doc.revision++;documents.set(fixed,doc);
  if(lost){lost=false;throw Error('Synthetic lost response')}
 }
 if(delayed){delayed=false;await new Promise(resolve=>finishDelayed=resolve)}
 return new Response(JSON.stringify(doc),{headers:{'content-type':'application/json'}});
};
window.assets={writes:()=>writes,scope:v=>{scope=v;for(const fn of listeners)fn()},snapshot:()=>documentFor(),
 lost:()=>lost=true,delay:()=>delayed=true,finish:()=>finishDelayed?.(),theme:setThemePreference};
const View=createAssetsView({account,fetcher,endpoint:'/fixture-assets',providers:[e2bAssetProvider,...gitAssetProviders([{host:'github.com',auth:'token'},{host:'git.example.test',auth:'ssh',name:'Example Git'}])]});
const host={platform:'electron',activeHostId:'local-codex',profiles:[],activeView:{viewId:'opencraft.assets',resourceUri:null},
 openView:()=>{},openSettings:()=>{},pushViewResource:()=>{},replaceViewResource:()=>{},
 provisionHost:async()=>{throw Error('Not used')},removeHost:async()=>false};
const contribution={id:'opencraft.assets',title:'Assets',viewType:'opencraft.assets',platforms:['web','electron']};
const root=document.getElementById('root');
createIntlTestRoot(root,undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(
 <WorkbenchPresentationRootProvider value={root}><AssetsEntry contribution={contribution} host={host} activation={{viewId:contribution.id,resourceUri:null}}/>
 <View contribution={contribution} host={host} activation={{viewId:contribution.id,resourceUri:null}}/></WorkbenchPresentationRootProvider>);
`;
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  publicDir: "apps/workbench-web/public",
  logLevel: "error",
  cacheDir: "node_modules/.vite-public-assets",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react-intl",
      "@tanstack/react-query",
      "@radix-ui/react-dialog",
      "@radix-ui/react-alert-dialog",
      "motion/react",
    ],
  },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "public-assets-fixture",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.headers.accept?.includes("text/html")) return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const evidence = [];
  for (const width of [390, 1200])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(15000);
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error(error.message);
      });
      await page.addInitScript(() => {
        (window as any).__name = (value: unknown) => value;
      });
      await page.goto(server.resolvedUrls!.local[0]);
      await page.getByRole("button", { name: "Add environment", exact: true }).waitFor();
      await page.evaluate((theme) => (window as any).assets.theme(theme), theme);
      assert.equal(await page.getByRole("button", { name: "Assets", exact: true }).count(), 1);
      // An absent provider editor must not fabricate an environment-variable action.
      assert.equal(await page.getByRole("button", { name: /Personal credentials ENV/ }).count(), 0);
      await page.getByRole("radio", { name: "Connections", exact: true }).click();
      await page.getByRole("button", { name: "Add connection", exact: true }).click();
      await page.getByRole("button", { name: "Choose E2B", exact: true }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Personal cloud");
      await page.getByRole("textbox", { name: "Access key", exact: true }).fill("synthetic-fixture-value");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Manage Personal cloud", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).assets.writes()), 1);
      assert.ok(
        !JSON.stringify(await page.evaluate(() => (window as any).assets.snapshot())).includes(
          "synthetic-fixture-value",
        ),
      );
      await page.getByRole("button", { name: "Manage Personal cloud", exact: true }).click();
      const name = page.getByRole("textbox", { name: "Name", exact: true });
      await name.fill("Preserved cloud draft");
      // Same component and DOM retain the draft across an appearance change.
      await name.evaluate((element) => {
        (window as any).draftField = element;
      });
      await page.evaluate((theme) => (window as any).assets.theme(theme === "light" ? "dark" : "light"), theme);
      assert.equal(await name.inputValue(), "Preserved cloud draft");
      assert.equal(await name.evaluate((element) => element === (window as any).draftField), true);
      await page.getByRole("button", { name: "Back to list", exact: true }).click();
      // The shared leave confirmation owns cancellation; no save/replay.
      const cancel = page.getByRole("alertdialog").getByRole("button", { name: "Keep editing", exact: true });
      await cancel.click();
      assert.equal(await name.inputValue(), "Preserved cloud draft");
      await page.screenshot({ path: resolve(output, `draft-${width}-${theme}.png`) });
      await page.evaluate(() => (window as any).assets.scope("local:fixture-b"));
      await page.getByRole("radio", { name: "Environments", exact: true, checked: true }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Name", exact: true }).count(), 0);
      assert.equal(await page.getByText("Preserved cloud draft", { exact: true }).count(), 0);
      await page.screenshot({ path: resolve(output, `account-switch-${width}-${theme}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      evidence.push({
        width,
        theme,
        actualSharedView: true,
        provider: "local",
        accountSwitch: true,
        draftRetained: true,
        secretNotProjected: true,
        externalServices: false,
      });
      await page.close();
    }
  // Narrow touch sheets: every provider row wraps its copy inside the sheet and
  // keeps its chevron fully visible, in both a CJK and a Latin catalog.
  for (const width of [320, 390])
    for (const [locale, add, choose] of [
      ["zh-CN", "添加连接", "选择"],
      ["en-US", "Add connection", "Choose"],
    ] as const)
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 800 },
          hasTouch: true,
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        await page.addInitScript(() => {
          (window as any).__name = (value: unknown) => value;
        });
        await page.goto(server.resolvedUrls!.local[0] + "?locale=" + locale);
        await page.getByRole("radio", { name: locale === "zh-CN" ? "连接" : "Connections", exact: true }).tap();
        await page.evaluate((theme) => (window as any).assets.theme(theme), theme);
        await page.getByRole("button", { name: add, exact: true }).tap();
        const sheet = page.getByRole("dialog");
        await sheet.getByRole("button", { name: choose + " Example Git", exact: true }).waitFor();
        const rows = await sheet.evaluate((dialog) => {
          const box = dialog.getBoundingClientRect();
          return [...dialog.querySelectorAll<HTMLElement>(".settings-collection-row")].map((row) => {
            const r = row.getBoundingClientRect(),
              chevron = row.querySelector(".settings-navigation-row__chevron")!.getBoundingClientRect();
            return {
              label: row.getAttribute("aria-label"),
              rowInside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
              contentFits: row.scrollWidth <= row.clientWidth + 1,
              chevronVisible:
                chevron.width > 0 &&
                chevron.left >= r.left - 0.5 &&
                chevron.right <= Math.min(r.right, box.right) + 0.5,
            };
          });
        });
        assert.equal(rows.length, 3);
        for (const row of rows)
          assert.deepEqual(
            row,
            { label: row.label, rowInside: true, contentFits: true, chevronVisible: true },
            `${width} ${locale}`,
          );
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: resolve(output, `provider-picker-${width}-${locale}-${theme}.png`) });
        evidence.push({ width, locale, theme, touch: true, providerRowsWrapInsideSheet: true });
        await context.close();
      }
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: evidence.length, output }));
} finally {
  await browser?.close();
  await server.close();
}
