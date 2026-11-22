import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { createDesktopAccountHost } from "../../plugins/local-account/src/desktop.js";

// Real native account owner + encrypted Worker service + default extension.
// The presentation harness supplies the host's view-selection port, not a fake
// account, fake fetch, catalog, credential writer or hard-coded assets component.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/assets-default-entry");
const directory = await mkdtemp(join(tmpdir(), "assets-default-browser-"));
const host = await createDesktopAccountHost(directory, () => "<title>Login</title>");
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {ExtensionSupervisor} from '/packages/extension-runtime/src/index.ts';
import {createServerAssetsExtension} from '/plugins/assets/src/client.ts';
import {WorkbenchPresentationRootProvider} from '/apps/workbench-web/src/components/workbench-presentation-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const params=new URLSearchParams(location.search),platform=params.get('platform')??'web';
const renderers=new Map();
const supervisor=new ExtensionSupervisor({platform,internalContributions:{platformViewRenderer:{prepare(owner,c){return{commit(){renderers.set(c.viewType,c.Component);return()=>renderers.delete(c.viewType)}}}}}});
await supervisor.activate(createServerAssetsExtension(window.fetch.bind(window)));
const snapshot=supervisor.contributions.getSnapshot();
if(snapshot.sidebarCatalogs.length!==1)throw Error('Default assets navigation was not registered');
const view=snapshot.views.find(v=>v.contribution.id==='opencraft.assets').contribution;
const Entry=renderers.get('opencraft.assets.entry'),View=renderers.get('opencraft.assets');
window.assetsDefault={theme:setThemePreference,retire:()=>supervisor.deactivate('opencraft.assets')};
function App(){const[active,setActive]=React.useState(false);
 const host={platform,activeHostId:'local-codex',profiles:[],activeView:active?{viewId:view.id,resourceUri:null}:null,
 openView:id=>{if(id!==view.id)throw Error('Unexpected view');setActive(true)},openSettings:()=>{},pushViewResource:()=>{},replaceViewResource:()=>{},provisionHost:async()=>{throw Error('Not used')},removeHost:async()=>false};
 const props={contribution:view,host,activation:{viewId:view.id,resourceUri:null}};
 return <><Entry {...props}/>{active?<View {...props}/>:<p>Choose Assets</p>}</>;
}
const root=document.getElementById('root');
createIntlTestRoot(root,undefined,'en-US').render(<WorkbenchPresentationRootProvider value={root}><App/></WorkbenchPresentationRootProvider>);
`;
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  publicDir: "apps/workbench-web/public",
  logLevel: "error",
  cacheDir: "node_modules/.vite-assets-default",
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
      name: "default-assets-integration",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url?.startsWith("/__opencraft_assets/")) {
            void host.handle(request, response).then((handled) => {
              if (!handled) next();
            });
            return;
          }
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
  const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
  host.setOrigin(origin);
  browser = await chromium.launch({
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const evidence = [];
  for (const [platform, width, touch, theme] of [
    ["web", 390, true, "light"],
    ["electron", 1200, false, "dark"],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch });
    await context.addCookies([
      { name: "oc_human", value: host.browserSessionToken, url: origin, httpOnly: true, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    await page.addInitScript(() => {
      Reflect.set(window, "__name", (value: unknown) => value);
    });
    await page.goto(origin + "/?platform=" + platform);
    await page.getByRole("button", { name: "Assets", exact: true }).click();
    await page.getByRole("button", { name: "Add environment", exact: true }).waitFor();
    await page.evaluate((value) => Reflect.get(window, "assetsDefault").theme(value), theme);
    await page.getByRole("radio", { name: "Connections", exact: true }).click();
    assert.equal(await page.getByText("Code accounts currently work on this server.", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    await page.getByRole("button", { name: "Choose E2B", exact: true }).click();
    const label = "Verified default " + platform;
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(label);
    await page.getByRole("textbox", { name: "Access key", exact: true }).fill("browser-integration-fixture-not-real");
    const mutation = page.waitForResponse(
      (response) =>
        response.url().endsWith("/__opencraft_assets/configurations") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const saved = await mutation;
    assert.equal(saved.status(), 200);
    const data = await saved.json();
    assert.ok(!JSON.stringify(data).includes("browser-integration-fixture-not-real"));
    await page.getByRole("button", { name: "Manage " + label, exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, platform + "-" + theme + ".png") });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    // Reload discovers the same real Human and persisted encrypted metadata.
    await page.reload();
    await page.getByRole("button", { name: "Assets", exact: true }).click();
    await page.getByRole("radio", { name: "Connections", exact: true }).click();
    await page.getByRole("button", { name: "Manage " + label, exact: true }).waitFor();
    assert.deepEqual(errors, []);
    evidence.push({
      platform,
      width,
      touch,
      theme,
      realDefaultRegistration: true,
      realAccountAndWorker: true,
      saveAndReload: true,
      secretNotProjected: true,
      electronBinary: false,
    });
    await context.close();
  }
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: evidence.length, output }));
} finally {
  await browser?.close();
  await server.close();
  await host.close();
  await rm(directory, { recursive: true, force: true });
}
