import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {useSettingsPresentation} from '/apps/workbench-web/src/components/use-settings-presentation.ts';
import {buildCodexThemeCssProperties} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
for(const [key,value] of Object.entries(buildCodexThemeCssProperties('light'))) document.documentElement.style.setProperty(key,value);
function Demo(){
 const [preferred,setPreferred]=React.useState(310);
 const p=useSettingsPresentation(preferred);
 return <AppShell layoutScope="settings" sidebarOpen={p.showIndex} sidebarWidth={p.sidebarWidth}
 sidebarCollapsible={false} sidebarResizable={false} sidebarTransientEnabled={false}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
 onSidebarCollapse={()=>{}} onSidebarExpand={()=>{}} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={()=>{}}
 rightPanelOpen={false} rightPanelFullWidth={false} rightPanel={null} header={null} floatingSidebarHeader={()=>null}
 leftPanel={<div className="settings-page__navigation"><button onClick={p.openContent}>Model services</button></div>}>
 <section className="settings-page" inert={p.indexOnly||undefined} aria-hidden={p.indexOnly||undefined}>
 <output data-testid="sidebar-width">{p.sidebarWidth}</output>
 <button onClick={()=>setPreferred(360)}>Change preferred width</button>
 {p.compact&&<nav className="settings-page__compact-navigation"><button className="settings-navigation-link" onClick={p.openIndex}>‹ Settings</button></nav>}
 <input aria-label="Draft" defaultValue=""/>
 </section></AppShell>;
}
createRoot(document.getElementById('root')).render(<Demo/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "settings-navigation-smoke", resolveId: id => id === "/probe.tsx" ? id : null, load: id => id === "/probe.tsx" ? source : null,
  configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url !== "/") return next();
    response.setHeader("content-type", "text/html");
    response.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>');
  }); },
}] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  assert.equal(await page.getByTestId('sidebar-width').textContent(), '310');
  await page.getByRole('button', {name:'Change preferred width'}).click();
  assert.equal(await page.getByTestId('sidebar-width').textContent(), '360');
  await page.setViewportSize({ width: 960, height: 800 });
  await page.getByRole('button', {name:'‹ Settings'}).waitFor();
  assert.equal(await page.getByTestId('sidebar-width').textContent(), '960', 'breakpoint uses the inherited width, not 220px');
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('button', {name:'Model services', exact:true}).waitFor();
  await page.getByRole("textbox", { name: "Draft" }).fill("retained draft");
  const field = await page.getByRole("textbox", { name: "Draft" }).elementHandle();
  await page.setViewportSize({ width: 600, height: 800 });
  await page.getByRole("button", { name: "‹ Settings" }).click();
  await page.getByRole("button", { name: "Model services", exact: true }).click();
  await page.getByRole("textbox", { name: "Draft" }).waitFor();
  assert.equal(await field.evaluate((element: HTMLElement) => element.isConnected), true);
  assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "retained draft");
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole("button", { name: "Model services", exact: true }).waitFor();
  assert.equal(await page.getByTestId('sidebar-width').textContent(), '360', 'compact presentation does not overwrite the preferred width');
  assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "retained draft");
  assert.deepEqual(errors, []);
  console.log("Settings shell passed: compact category navigation, stable editor, wide restoration.");
} finally { await browser?.close(); await vite.close(); }
