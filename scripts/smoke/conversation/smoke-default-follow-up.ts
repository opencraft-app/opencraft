import assert from "node:assert/strict";
import { createServer } from "vite";

// Real Settings / preferences / Composer. Only execution is replaced: this
// probe never sends a command to a user Host or invokes a model.
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {createComposerController} from '@opencraft/composer-core';
import {ChatSettings} from '/apps/workbench-web/src/components/chat-settings.tsx';
import {UiPreferencesProvider,openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {useDefaultFollowUpAction} from '/apps/workbench-web/src/runtime/use-default-follow-up-action.ts';
import {WorkbenchLocaleController,WorkbenchIntlProvider} from '/apps/workbench-web/src/i18n/workbench-locale.tsx';
import {buildOpenCraftThemeCssProperties,opencraftCanvasThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
Object.entries(buildOpenCraftThemeCssProperties('light',opencraftCanvasThemePalette.light)).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));
const preferences=await openWorkbenchUiPreferences();
const locale=new WorkbenchLocaleController(preferences,{ideLocale:'en-US'});await locale.initialize();
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
const calls=[];
function App(){const[active,setActive]=useState(true);const action=useDefaultFollowUpAction();
window.fixture={setActive,calls,flush:()=>preferences.flush(),draft:()=>controller.getSnapshot().draft,setTheme:mode=>Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftCanvasThemePalette[mode])).forEach(([k,v])=>document.documentElement.style.setProperty(k,v))};
return <main style={{padding:20,maxWidth:750}}><ChatSettings/><OpenCraftComposer controller={controller} defaultFollowUpAction={action} isStreaming={active} selectionCatalog={{models:[{id:'fixture-model',value:'fixture-model',label:'Model',description:null,isDefault:true,defaultEffort:null,efforts:[]}],permissionProfiles:[]}} onSubmit={(intent,context)=>{calls.push({text:intent.plainText,action:context.followUpAction});return true}} onCancel={()=>{}}/></main>}
createRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}><WorkbenchIntlProvider controller={locale} target={document.documentElement}><App/></WorkbenchIntlProvider></UiPreferencesProvider>);
`;

const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-default-follow-up",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "default-follow-up-fixture", resolveId: id => id === "/follow-up-probe.tsx" ? id : null,
    load: id => id === "/follow-up-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/follow-up-probe.tsx"></script>');
    }); },
  }],
});
let browser: any;
try {
  await server.listen();
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  const errors: string[] = [];
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1180, height: 760 }, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript("window.__name = value => value");
    const page = await context.newPage();
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(origin);
    const toggle = page.getByRole("switch");
    const editor = page.locator(".opencraft-composer-editor");
    const action = () => page.locator("[data-composer-primary-action]").getAttribute("data-composer-primary-action");
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await editor.fill("preserved draft");
    assert.equal(await action(), "queue");
    await page.evaluate(() => {
      (window as any).originalEditor = document.querySelector(".opencraft-composer-editor");
      const text = document.createTreeWalker(document.querySelector(".opencraft-composer-editor")!, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 5);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    const second = await context.newPage();
    await second.goto(origin); await second.getByRole("switch").waitFor();
    // A second window mutates the actual IndexedDB/BroadcastChannel authority.
    await second.getByRole("switch").click();
    await page.waitForFunction(() => document.querySelector('[data-composer-primary-action]')?.getAttribute('data-composer-primary-action') === 'steer');
    await second.getByRole("switch").click();
    await page.waitForFunction(() => document.querySelector('[data-composer-primary-action]')?.getAttribute('data-composer-primary-action') === 'queue');
    assert.equal(await editor.innerText(), "preserved draft");
    assert.equal(await page.evaluate(() => (window as any).originalEditor === document.querySelector(".opencraft-composer-editor")), true);
    assert.equal(await page.evaluate(() => getSelection()!.toString()), "ese");
    await page.locator("[data-composer-primary-action]").click();
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.at(-1).action), "queue");
    await editor.fill("shortcut override"); await editor.press("Control+Enter");
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.at(-1).action), "steer");
    await toggle.click(); await page.evaluate(() => (window as any).fixture.flush());
    await editor.fill("steer click"); await page.locator("[data-composer-primary-action]").click();
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.at(-1).action), "steer");
    await editor.fill("steer enter");
    const beforeEnter = await page.evaluate(() => (window as any).fixture.calls.length);
    await editor.press("Enter");
    if (mobile) {
      assert.equal(await page.evaluate(() => (window as any).fixture.calls.length), beforeEnter);
      assert.equal(await editor.locator("p").count(), 2);
    } else {
      assert.equal(await page.evaluate(() => (window as any).fixture.calls.at(-1).action), "steer");
    }
    await editor.fill("queue override"); await editor.press("Control+Enter");
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.at(-1).action), "queue");
    for (const mode of ["light", "dark"]) {
      await page.evaluate(mode => (window as any).fixture.setTheme(mode), mode);
      const box = await toggle.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= (mobile ? 390 : 1180));
    }
    await toggle.click(); await page.evaluate(() => (window as any).fixture.flush());
    await page.reload(); await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.evaluate(() => (window as any).fixture.setActive(false));
    await editor.fill("idle send");
    assert.equal(await action(), "send");
    await page.locator("[data-composer-primary-action]").click();
    assert.equal(await page.evaluate(() => (window as any).fixture.calls.at(-1).action), null);
    await second.close(); await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, realHostWrites: false, cases: ["desktop and touch", "default queue click", "mobile Enter newline", "queue persistence and live multi-window change", "inverse shortcut", "idle normal send", "draft/editor/selection retained", "light/dark narrow settings"] }));
} finally { await browser?.close(); await server.close(); }
