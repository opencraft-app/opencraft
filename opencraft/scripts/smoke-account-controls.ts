import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_ACCOUNT_REPORT ?? "/tmp/opencraft-account-controls";
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModalSurface} from '/apps/workbench-web/src/components/modal/modal-surface.tsx';
import {createLightVelaAccountView} from '/plugins/lightvela-hermes/src/account/lightvela-account-view.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {buildCodexThemeCssProperties,velaThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const listeners=new Set();
const profile={id:'account-fixture-id',name:'Alex Chen',avatarUrl:null,pendingName:null,nameAuditStatus:null};
const ready={phase:'ready',profile,subscription:{code:'Launch',status:'active',currentPeriodStart:'2026-05-16',currentPeriodEnd:'2026-09-27'},pass:{bundleName:'Launch',creditsTotal:100,creditsAvailable:0,createdAt:'2026-05-16',expiresAt:'2026-09-27'},error:null};
let snapshot={revision:1,region:'intl',phase:'authenticated',session:{status:'authenticated',epoch:1},details:ready};
const update=details=>{snapshot={...snapshot,revision:snapshot.revision+1,details};listeners.forEach(f=>f())};
let failSave=true,refreshCount=0;
const account={subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},getSnapshot:()=>snapshot,hasStoredSession:()=>true,
refreshAccountDetails:async()=>{refreshCount++;return snapshot.details},
updateProfileName:async name=>{if(failSave)throw Error('Name could not be saved. Try again.');update({...snapshot.details,profile:{...profile,name}})},
uploadProfileAvatar:async()=>{throw Error('Avatar upload test error')},signOut:async()=>{throw Error('Sign out test error')}};
const View=createLightVelaAccountView(account);
function App(){const [open,setOpen]=useState(false);window.fixture={
setOpen,setThemePreference,ready:()=>update(ready),loading:()=>update({...ready,phase:'loading',profile:null,pass:null}),
empty:()=>update({...ready,pass:null,subscription:null}),error:()=>update({...ready,error:'Could not refresh account. Try again.'}),
longName:()=>update({...ready,profile:{...profile,name:'A very long account display name that should never push controls off screen'}}),
custom:()=>{Object.entries(buildCodexThemeCssProperties('dark',{...velaThemePalette.dark,surface:'#18232c',ink:'#f3eee5',accent:'#e4b25b'})).forEach(([k,v])=>document.documentElement.style.setProperty(k,v))},
saveWorks:()=>failSave=false,refreshCount:()=>refreshCount};
return <main style={{minHeight:'100dvh',padding:32,background:'var(--color-surface-tertiary)'}}><button id='account-trigger' onClick={()=>setOpen(true)}>Open account</button>
{open?<ModalSurface label='Account Settings' size='wide' appearance='utility' onDismiss={()=>setOpen(false)} dismissOnOutsidePress={false}>
<View host={{platform:'electron',openSettings:id=>window.settingsDestination=id,openView:()=>{},prepareImageUpload:async file=>file}} contribution={{}} activation={{}}/>
</ModalSurface>:null}</main>}
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-account-controls",
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-popover"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "account-controls-fixture", resolveId: id => id === "/account-probe.tsx" ? id : null,
    load: id => id === "/account-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req,res,next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type","text/html");res.end('<div id="root"></div><script type="module" src="/account-probe.tsx"></script>');
    }); },
  }],
});
let browser: any;
const evidence: unknown[] = [];
const errors: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript(`window.__name=value=>value;Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copiedValue=value}}});window.open=url=>{window.externalURL=url;return null;};`);
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
  await page.getByRole("button", { name: "Open account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Account Settings", exact: true });
  await page.getByRole("progressbar", { name: "Model credits used" }).waitFor();
  for (const mode of ["light", "dark", "custom"]) {
    await page.evaluate(mode => mode === "custom" ? (window as any).fixture.custom() : (window as any).fixture.setThemePreference(mode), mode);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${output}/${mode}.png` });
    const geometry = await dialog.boundingBox();
    assert.ok(geometry.height < 600, "content must not retain the old 820px canvas");
    const tokens = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ["--color-text-warning", "--color-text-danger", "--color-usage-track", "--color-dialog-scrim"].map(k=>css.getPropertyValue(k));
    });
    assert.ok(tokens.every(Boolean));
    const colors = await page.getByRole("button", { name: "Manage subscription", exact: true }).evaluate(e => ({
      color: getComputedStyle(e).color, background: getComputedStyle(e).backgroundColor,
      surface: getComputedStyle(e).getPropertyValue('--color-background-surface'),
      secondary: getComputedStyle(e).getPropertyValue('--color-text-secondary'),
    }));
    console.log(JSON.stringify({ mode, colors })); evidence.push({ case: mode, geometry, tokens, colors });
  }
  await page.getByRole("button", { name: "Edit display name", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  await page.waitForFunction(() => document.activeElement?.getAttribute("id") === document.querySelector('.settings-edit-popover input')?.id, undefined, { timeout: 3000 });
  await name.fill("Edited name"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Name could not be saved" }).waitFor();
  assert.equal(await name.inputValue(), "Edited name");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 1);
  assert.equal(await page.getByRole("button", { name: "Edit display name", exact: true }).evaluate(e=>e===document.activeElement), true);
  await page.getByRole("button", { name: "Edit display name", exact: true }).click();
  await name.fill("Edited name"); await page.evaluate(() => (window as any).fixture.saveWorks());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Edited name", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Copy account ID", exact: true }).click();
  assert.equal(await page.evaluate(()=> (window as any).copiedValue), "account-fixture-id");
  await page.getByText("Copied", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Manage subscription", exact: true }).click();
  assert.equal(await page.evaluate(()=> (window as any).externalURL), "https://lightvela.ai/account?tab=billing#renew");
  const refreshCount = await page.evaluate(()=> (window as any).fixture.refreshCount());
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  assert.ok(await page.evaluate(()=> (window as any).fixture.refreshCount()) > refreshCount);
  await page.getByRole("button", { name: "Configure model", exact: true }).click();
  assert.equal(await page.evaluate(()=> (window as any).settingsDestination), "lightvela.hermes.models");
  evidence.push({ case: "edit-error-save-copy-billing-return-model-navigation", passed: true });
  await page.locator('input[type="file"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: Buffer.from("test-image") });
  await page.getByRole("alert").filter({ hasText: "Avatar upload test error" }).waitFor();
  assert.equal(await page.locator('input[type="file"]').inputValue(), "");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Sign out test error" }).waitFor();
  evidence.push({ case: "avatar-and-signout-errors-stay-near-actions", passed: true });
  for (const state of ["loading", "empty", "error", "longName"]) {
    await page.evaluate(state => (window as any).fixture[state](), state);
    await page.setViewportSize({ width: 420, height: 520 });
    await page.screenshot({ path: `${output}/${state}-narrow.png` });
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 421 && box.y >= 0 && box.y + box.height <= 521);
    assert.equal(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1), true);
    evidence.push({ case: state, passed: true, geometry: box });
  }
  await page.getByRole("button", { name: "Close account settings", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')), true);
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.id === 'account-trigger');
  assert.equal(await page.locator("#account-trigger").evaluate(e=>e===document.activeElement), true);
  evidence.push({ case: "dialog-focus-restoration", passed: true });
  assert.deepEqual(errors, []); console.log(JSON.stringify(evidence, null, 2));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify({ evidence, errors }, null, 2));
  await browser?.close(); await vite.close();
}
