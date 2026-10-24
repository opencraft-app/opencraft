import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "opencraft-navigation-avatar-"));
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {IdentityAvatarContext} from '@opencraft/extension-react';
import {UserMessageNavigationRail} from '/apps/workbench-web/src/components/user-message-navigation-rail.tsx';
import '/apps/workbench-web/src/styles/app.scss';
import {buildOpenCraftThemeCssProperties,opencraftCanvasThemePalette} from '/packages/design-system/src/theme-engine.ts';
window.setTheme=mode=>Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftCanvasThemePalette[mode])).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));
const anchors=Array.from({length:6},(_,i)=>({id:'anchor-'+i,itemId:'item-'+i,turnKey:'turn-'+i,order:i,label:'Prompt '+i,isLoaded:true,isHeartbeat:false}));
const snapshot={revision:1,phase:'ready',generation:'fixture',completeness:'complete',anchors,error:null};
const source={getSnapshot:()=>snapshot,subscribe:()=>()=>{},prepare:async()=>{},
 loadPreview:async(id)=>{const i=Number(id.split('-')[1]);return {label:'Prompt '+i,response:'Response '+i,outputs:[],...(i===2?{}:{sender:{kind:'employee',loginName:i===0?'alice':i===1?'bob':'broken'}})}},prepareTarget:async()=>null,dispose:()=>{}};
const avatars={id:'test',resolve:(_,name)=>name==='alice'?'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="pink"/%3E%3C/svg%3E':name==='broken'?'/missing-avatar.png':null};
function App(){const scroll=React.useRef(null);const get=React.useCallback(()=>scroll.current,[]);
return <IdentityAvatarContext.Provider value={avatars}><div style={{position:'relative',height:400,width:800}}>
<div ref={scroll} style={{height:400,overflow:'auto'}}><div data-thread-user-message-navigation-content style={{marginLeft:80}}>
{anchors.map(a=><section key={a.id} data-turn-key={a.turnKey} style={{height:100}}><div data-content-search-unit-key={a.itemId}>Prompt {a.order}</div></section>)}
</div></div><UserMessageNavigationRail source={source} getScrollElement={get} virtualizedTurnListApi={{positionTarget:async()=> 'positioned'}}/>
</div></IdentityAvatarContext.Provider>};
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-navigation-diagnosis", server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "navigation-rail-diagnosis",
    resolveId: id => id === "/rail-probe.tsx" ? id : null,
    load: id => id === "/rail-probe.tsx" ? fixture : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<div id="root"></div><script type="module" src="/rail-probe.tsx"></script>');
    }); },
  }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(`globalThis.__name=value=>value;
    window.observerCount=0; const Native=window.IntersectionObserver;
    window.IntersectionObserver=class extends Native {constructor(...args){super(...args);window.observerCount++}};`);
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  for (const theme of ['light','dark']) {
    await page.goto(url+'/?'+theme);
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme; (window as any).setTheme(theme); document.body.style.background='var(--color-background-surface)';},theme);
    await page.locator('.conversation-navigation-rail').waitFor();
    const buttons=page.locator('.conversation-navigation-rail__item');
    const avatar=page.locator('.conversation-navigation-tooltip__avatar');
    await buttons.nth(0).hover();
    await avatar.waitFor();
    assert.equal(await avatar.getAttribute('aria-label'),'alice');
    await page.waitForFunction(()=>document.querySelector('.conversation-navigation-tooltip__avatar img')?.complete);
    assert.equal(await avatar.locator('img').count(),1);
    await page.screenshot({path:join(output, `turn-avatar-${theme}.png`)});
    await buttons.nth(1).focus();
    await page.waitForFunction(()=>document.querySelector('.conversation-navigation-tooltip__avatar')?.getAttribute('aria-label')==='bob');
    assert.equal(await avatar.locator('svg').count(),1);
    const fallbackBox=await avatar.boundingBox();
    assert.equal(fallbackBox?.width,20); assert.equal(fallbackBox?.height,20);
    await buttons.nth(2).focus();
    await page.waitForFunction(()=>document.querySelector('[role="tooltip"]')?.textContent?.includes('Prompt 2'));
    assert.equal(await avatar.count(),0);
    await buttons.nth(3).focus();
    await page.waitForFunction(()=>document.querySelector('.conversation-navigation-tooltip__avatar svg'));
    assert.equal(await avatar.getAttribute('aria-label'),'broken');
    assert.equal((await avatar.boundingBox())?.width,20);
    console.log(theme+': known / missing / unknown / broken author avatar passed');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ output, passed: true }));
} finally { await browser?.close(); await vite.close(); }
