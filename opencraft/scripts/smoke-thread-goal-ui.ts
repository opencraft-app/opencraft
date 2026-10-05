import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "vite";

const output = await mkdtemp("/data/opencraft-goal-ui-");
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CodexComposer} from '@opencraft/codex-composer';
import {createComposerController} from '@opencraft/composer-core';
import {LocaleRuntime} from '@opencraft/i18n';
import {IntlRuntimeProvider} from '@opencraft/i18n/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {ThreadGoalSurface} from '/apps/workbench-web/src/components/thread-goal-surface.tsx';
import {ThreadGoalResource} from '/packages/workbench-runtime/src/thread-goal-resource.ts';
import {buildCodexThemeCssProperties,velaThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '@fontsource-variable/noto-sans-sc';
Object.entries(buildCodexThemeCssProperties('light',velaThemePalette.light)).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));
const initialGoal={threadId:'one',objective:'完成移动端目标体验，验证离开页面后仍能持续推进。',status:'active',tokenBudget:null,tokensUsed:312,timeUsedSeconds:82,createdAt:Math.floor(Date.now()/1000)-82,updatedAt:Math.floor(Date.now()/1000)};
let goal=initialGoal,write=true,setCalls=0;
const goals=new ThreadGoalResource({capability:()=>({version:1,read:true,write}),get:async()=>({goal}),set:async(id,change)=>{setCalls++;goal={...initialGoal,...goal,...change,threadId:id,updatedAt:Math.floor(Date.now()/1000)};return {goal}},clear:async()=>{goal=null;return {cleared:true}}});
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
function App(){const[threadId,setThreadId]=useState('one');
window.fixture={setTheme:mode=>Object.entries(buildCodexThemeCssProperties(mode,velaThemePalette[mode])).forEach(([key,value])=>document.documentElement.style.setProperty(key,value)),clear:()=>{goal=null;goals.observe(threadId,null)},readonly:value=>{write=!value;goals.observe(threadId,goal)},switchThread:value=>setThreadId(value),setCalls:()=>setCalls,objective:()=>goal?.objective};
return <div style={{height:'100dvh',display:'flex',flexDirection:'column',justifyContent:'flex-end',padding:'20px 16px 32px',background:'var(--color-background-surface)'}}><ThreadGoalSurface threadId={threadId} goals={goals}>{goalMenuItem=><CodexComposer controller={controller} selectionCatalog={{models:[{id:'model',value:'model',label:'Model',description:null,isDefault:true,defaultEffort:null,efforts:[]}],permissionProfiles:[]}} onSubmit={async()=>{}} onCancel={()=>{}} addMenuContent={closeMenu=><><DropdownMenu.Item className='codex-composer-selection-menu__item codex-composer-add-menu__item'>连接器</DropdownMenu.Item>{goalMenuItem?.(closeMenu)}</>}/>}</ThreadGoalSurface></div>}
createRoot(document.getElementById('root')).render(<IntlRuntimeProvider runtime={new LocaleRuntime([])}><App/></IntlRuntimeProvider>);
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-thread-goal-ui",
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl", "@radix-ui/react-dialog"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "goal-ui-fixture", resolveId: id => id === "/goal-probe.tsx" ? id : null,
    load: id => id === "/goal-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/goal-probe.tsx"></script>');
    }); },
  }],
});
let browser;
try {
  await vite.listen();
  if (process.argv.includes("--serve")) {
    console.log(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    await new Promise<void>(() => undefined);
  }
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript("window.__name = value => value");
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const summary = page.getByRole("button", { name: /正在推进目标/ });
  await summary.waitFor();
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(mode => (window as any).fixture.setTheme(mode), mode);
    await summary.click();
    await page.screenshot({ path: `${output}/${mode}-expanded.png` });
    const colors = await summary.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.notEqual(colors.color, colors.background);
    assert.notEqual(colors.background, "rgba(0, 0, 0, 0)");
    await page.getByRole("button", { name: "编辑" }).click();
    const dialog = page.getByRole("dialog", { name: "编辑目标" });
    await dialog.waitFor();
    await page.screenshot({ path: `${output}/${mode}-editor.png` });
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
    const titleBox = await dialog.locator(".thread-goal__editor h2").boundingBox();
    assert.ok(titleBox && titleBox.x >= box.x + 15);
    const saveColors = await dialog.getByRole("button", { name: "保存" }).evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.notEqual(saveColors.color, saveColors.background);
    await dialog.getByRole("button", { name: "取消" }).click();
    await summary.click();
  }
  assert.deepEqual(errors, []);
  const add = page.getByRole("button", { name: "Add", exact: true });
  const create = page.getByRole("menuitem", { name: "设定持续目标", exact: true });
  const editor = page.locator(".codex-composer-editor");
  await editor.fill("保留这份输入草稿");
  await page.evaluate(() => (window as any).fixture.clear());
  await summary.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".thread-goal").count(), 0);
  assert.equal(await page.getByRole("button", { name: "设定持续目标", exact: true }).count(), 0);
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(mode => (window as any).fixture.setTheme(mode), mode);
    await add.tap();
    await create.waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "Attach files", exact: true }).count(), 1);
    assert.equal(await page.getByRole("menuitem", { name: "连接器", exact: true }).count(), 1);
    await page.screenshot({ path: `${output}/${mode}-add-menu.png` });
    await create.tap();
    const dialog = page.getByRole("dialog", { name: "设定目标", exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
    assert.equal(await page.getByRole("menu").count(), 0);
    await dialog.getByRole("textbox", { name: "目标内容" }).fill("取消不会创建目标");
    await dialog.getByRole("button", { name: "取消" }).tap();
    assert.equal(await page.evaluate(() => (window as any).fixture.setCalls()), 0);
    assert.equal(await editor.innerText(), "保留这份输入草稿");
  }
  await add.focus();
  await page.keyboard.press("Enter");
  await create.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.textContent === "设定持续目标");
  await page.keyboard.press("Enter");
  const createDialog = page.getByRole("dialog", { name: "设定目标", exact: true });
  await createDialog.waitFor();
  await createDialog.getByRole("textbox", { name: "目标内容" }).fill("从菜单创建的持续目标");
  await createDialog.getByRole("button", { name: "保存" }).tap();
  await createDialog.waitFor({ state: "hidden" });
  await summary.waitFor();
  assert.equal(await page.evaluate(() => (window as any).fixture.objective()), "从菜单创建的持续目标");
  assert.equal(await page.evaluate(() => (window as any).fixture.setCalls()), 1);
  await add.tap();
  assert.equal(await create.count(), 0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { (window as any).fixture.clear(); (window as any).fixture.readonly(true); });
  await summary.waitFor({ state: "hidden" });
  await add.tap();
  assert.equal(await create.count(), 0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).fixture.readonly(false));
  await add.tap();
  await create.tap();
  await createDialog.waitFor();
  await createDialog.getByRole("textbox", { name: "目标内容" }).fill("旧会话未保存目标");
  const originalEditor = await editor.elementHandle();
  await page.evaluate(() => (window as any).fixture.switchThread("two"));
  await createDialog.waitFor({ state: "hidden" });
  assert.equal(await originalEditor?.evaluate(element => element.isConnected), true);
  assert.equal(await editor.innerText(), "保留这份输入草稿");
  await add.tap();
  await create.tap();
  await createDialog.waitFor();
  assert.equal(await createDialog.getByRole("textbox", { name: "目标内容" }).inputValue(), "");
  await createDialog.getByRole("button", { name: "取消" }).tap();
  await page.evaluate(() => (window as any).fixture.switchThread(null));
  await add.tap();
  assert.equal(await create.count(), 0);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, passed: true, evidence: ["existing goal light/dark", "touch Add menu, cancel and draft preservation", "keyboard create and confirmed goal", "read-only and missing Thread hide creation", "Thread switch closes draft without remounting Composer"] }));
} finally {
  await browser?.close();
  await vite.close();
}
