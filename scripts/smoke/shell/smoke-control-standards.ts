import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium, _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_CONTROL_REPORT ?? await mkdtemp(join(tmpdir(), "opencraft-controls-"));
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '/apps/workbench-web/src/components/ui/button.tsx';
import {SettingsButton,SettingsTextInput,SettingsSelect,SettingsRow,SettingsGroup,SettingsPageHeader,SettingsPanel} from '@opencraft/extension-react';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette,opencraftCanvasThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
function App(){const [pending,setPending]=useState(false);window.fixture={setPending,theme:(mode,family)=>{
document.documentElement.dataset.theme=mode;
const base=family==='neutral'?opencraftNeutralThemePalette[mode]:opencraftCanvasThemePalette[mode];
const palette=family==='custom'?{...base,accent:'#d8a442',surface:mode==='dark'?'#18232c':'#fbfaf7',semanticColors:{...base.semanticColors,error:mode==='dark'?'#ffaabb':'#a01133'}}:base;
for(const [k,v] of Object.entries(buildOpenCraftThemeCssProperties(mode,palette)))document.documentElement.style.setProperty(k,v);
}};
return <main style={{padding:24,display:'grid',gap:20,background:'var(--color-background-surface)',color:'var(--color-text)'}}>
<SettingsPageHeader title="共享控件 / Shared controls" description="Typography · focus · disabled · invalid · pending"/>
<div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}>
<Button size="sm" id="small">小按钮 Small</Button><Button id="standard" loading={pending}>保存 Save</Button>
<Button size="lg" id="large">大按钮 Large</Button><Button size="toolbar" id="toolbar">工具栏 Toolbar</Button>
<Button disabled id="disabled">不可用 Disabled</Button></div>
<SettingsGroup><SettingsRow label="名称 Name" htmlFor="name"><SettingsTextInput id="name" defaultValue="中英文名称 / A long configuration name"/></SettingsRow>
<SettingsRow label="模型 Model" htmlFor="model"><SettingsSelect id="model"><option>默认模型 Default model</option><option>另一个模型 Other model</option></SettingsSelect></SettingsRow>
<SettingsRow label="不可用 Disabled" htmlFor="disabled-select"><SettingsSelect id="disabled-select" disabled><option>Not available</option></SettingsSelect></SettingsRow>
<SettingsRow label="错误 Invalid" htmlFor="invalid"><SettingsTextInput id="invalid" aria-invalid="true" aria-describedby="error" defaultValue="invalid"/></SettingsRow>
<SettingsRow label="选择错误 Invalid selection" htmlFor="invalid-select"><SettingsSelect id="invalid-select" aria-invalid="true" aria-describedby="error"><option>Invalid option</option></SettingsSelect></SettingsRow>
</SettingsGroup><p id="error" style={{margin:0,color:'var(--color-text-danger)'}}>请检查配置 / Check configuration</p>
<div style={{display:'flex',gap:12}}><SettingsButton id="settings">检查 Check</SettingsButton><SettingsButton variant="primary">保存 Save</SettingsButton><SettingsButton disabled>禁用 Disabled</SettingsButton></div>
<SettingsPanel title="Account" actions={<SettingsButton>Refresh</SettingsButton>}>
<SettingsGroup><SettingsRow label="Identity">Synthetic account</SettingsRow></SettingsGroup>
</SettingsPanel></main>}
createRoot(document.getElementById('root')).render(<App/>);`;

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-control-standards",
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "control-standards-fixture", resolveId: id => id === "/controls-probe.tsx" ? id : null,
    load: id => id === "/controls-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req,res,next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type","text/html");res.end('<html><head><title>Control standards</title></head><body><div id="root"></div><script type="module" src="/controls-probe.tsx"></script></body></html>');
    }); },
  }],
});
let browser: any, desktop: any;
const evidence: unknown[] = [], errors: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  let page: any;
  if (process.env.OPENCRAFT_CONTROL_ELECTRON_EXECUTABLE) {
    const profile = await mkdtemp(join(tmpdir(), "opencraft-control-electron-"));
    const entry = join(profile, "probe.cjs");
    await writeFile(entry, `const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.OPENCRAFT_CONTROL_PROBE_PROFILE);app.whenReady().then(()=>{const w=new BrowserWindow({width:1080,height:800,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(process.env.OPENCRAFT_CONTROL_PROBE_URL);});app.on('window-all-closed',()=>app.quit());`);
    desktop = await _electron.launch({executablePath:process.env.OPENCRAFT_CONTROL_ELECTRON_EXECUTABLE,args:[entry],env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=="ELECTRON_RUN_AS_NODE")),OPENCRAFT_CONTROL_PROBE_PROFILE:profile,OPENCRAFT_CONTROL_PROBE_URL:url}});
    page = await desktop.firstWindow();
  } else {
    browser = await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
    page = await browser.newPage({viewport:{width:1080,height:800}});
  }
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto(url);
  await page.locator("#standard").waitFor();
  // A direct utility panel must not depend on visiting the lazy Settings route.
  const utility = await page.locator('.settings-panel').evaluate((element: HTMLElement) => ({
    display: getComputedStyle(element).display,
    headerHeight: element.querySelector('.settings-panel__header')!.getBoundingClientRect().height,
    padding: getComputedStyle(element.querySelector('.settings-panel__body')!).paddingLeft,
  }));
  assert.equal(utility.display, 'flex');
  assert.ok(utility.headerHeight >= 52);
  assert.equal(utility.padding, '24px');
  for (const family of ["neutral","canvas","custom"]) for (const mode of ["light","dark"]) {
    await page.evaluate(({mode,family}: any) => (window as any).fixture.theme(mode,family),{mode,family});
    // Theme projections and native control repaint may span a frame. Do not
    // compare a newly resolved border with a previous-frame text color.
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const metrics = await page.evaluate(() => {
      const ids=["small","standard","large","toolbar","settings","name","model"];
      return Object.fromEntries(ids.map(id=>{const el=document.getElementById(id)!;const css=getComputedStyle(el);const frame=id==='model'?el.parentElement!:el;return [id,{height:frame.getBoundingClientRect().height,font:css.fontSize,weight:css.fontWeight,line:css.lineHeight}]}));
    });
    assert.deepEqual(Object.values(metrics).map((m:any)=>m.height),[32,40,44,32,32,32,32]);
    assert.deepEqual(Object.values(metrics).map((m:any)=>m.font),["12px","14px","16px","13px","13px","13px","13px"]);
    assert.deepEqual(Object.values(metrics).map((m:any)=>m.weight),["500","500","500","500","400","400","400"]);
    for (const id of ["standard","settings"]) {
      await page.locator(`#${id}`).focus();
      assert.equal(await page.locator(id==="model"?".settings-control-select-shell:has(#model)":`#${id}`).evaluate((el:any)=>getComputedStyle(el).outlineStyle),"solid");
    }
    for (const id of ["name","model"]) {
      await page.locator(`#${id}`).focus();
      const target = page.locator(id === "model" ? ".settings-control-select-shell:has(#model)" : `#${id}`);
      const focus = await target.evaluate((el:any) => {
        const css = getComputedStyle(el), probe = document.createElement("span");
        probe.style.color = "var(--color-border-focus)"; document.body.append(probe);
        const color = getComputedStyle(probe).color; probe.remove();
        return { outline: css.outlineStyle, border: css.borderTopColor, color };
      });
      assert.equal(focus.outline, "none");
      assert.equal(focus.border, focus.color);
    }
    const invalid = await page.evaluate(()=>({input:getComputedStyle(document.getElementById('invalid')!).borderColor,select:getComputedStyle(document.getElementById('invalid-select')!.parentElement!).borderColor,expected:getComputedStyle(document.getElementById('error')!).color}));
    assert.equal(invalid.input,invalid.expected); assert.equal(invalid.select,invalid.expected);
    const disabledSelect=page.locator('.settings-control-select-shell:has(#disabled-select)');
    const background=await disabledSelect.evaluate((el:any)=>getComputedStyle(el).backgroundColor);
    await disabledSelect.hover();
    assert.equal(await disabledSelect.evaluate((el:any)=>getComputedStyle(el).backgroundColor),background);
    const before=await page.locator('#standard').boundingBox();
    await page.evaluate(()=>(window as any).fixture.setPending(true));
    await page.locator('#standard[aria-busy="true"]').waitFor();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#standard .ui-button__label')!).opacity==='0');
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    const after=await page.locator('#standard').boundingBox();
    assert.deepEqual(after,before); assert.equal(await page.locator('#standard').isDisabled(),true);
    assert.equal(await page.locator('.ui-button__spinner').evaluate((el:any)=>getComputedStyle(el).animationName),'none');
    await page.screenshot({path:join(output,`${family}-${mode}.png`)});
    await page.evaluate(()=>(window as any).fixture.setPending(false));
    evidence.push({family,mode,metrics,invalid,loadingGeometryUnchanged:true});
  }
  await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
  await page.locator('#standard').focus();
  assert.equal(await page.locator('#standard').evaluate((el:any)=>getComputedStyle(el).outlineStyle),'solid');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'large');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({output,platform:desktop?'electron':'chromium',cases:evidence.length,errors}));
} finally {
  await writeFile(join(output,"report.json"),JSON.stringify({evidence,errors},null,2));
  await desktop?.close(); await browser?.close(); await vite.close();
}
