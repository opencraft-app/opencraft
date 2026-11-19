import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { _electron } from "playwright";
const output = resolve(".local/tab-display-ownership");
await mkdir(output, { recursive: true });
const source = `
import {createImplementation} from '/apps/workbench-web/src/browser/opencraft/presentation-transition.js';
import {OpenCraftPresentationHost} from '/apps/workbench-web/src/browser/opencraft-presentation-host.ts';
const Transition=createImplementation({}),transition=new Transition(),hosts=new Map();
let selected='a';const failures=[];
const layout={visualBounds:{x:0,y:60,width:390,height:700},stageBounds:{x:0,y:60,width:390,height:700},viewportSize:{width:390,height:700},scale:1};
for(const id of ['a','b','c']){
 const container=document.createElement('div');container.dataset.page=id;
 Object.assign(container.style,{position:'absolute',inset:'60px 0 0',background:{a:'#cce5ff',b:'#def5df',c:'#ffe5cc'}[id],visibility:'hidden'});
 container.textContent='Page '+id;document.body.append(container);
 const guest=document.createElement('input');guest.value='draft '+id;container.append(guest);
 const host=new OpenCraftPresentationHost({conversationId:'owner',browserTabId:id},{container,guest,ready:Promise.resolve(),commit:(_layout,visible)=>{container.style.visibility=visible?'visible':'hidden'},park:()=>{container.style.visibility='hidden'},close:()=>{throw Error('resource closed')},clearCover(){},cover(){}});
 host.markRegistered();hosts.set(id,host);
 const button=document.createElement('button');button.textContent=id;button.onclick=()=>select(id);document.querySelector('nav').append(button);
}
function select(id){selected=id;document.querySelector('header').textContent='Selected '+id;transition.sync(hosts.get(id),{mountGeneration:1,isVisible:true,shouldPaint:true,bounds:layout.visualBounds,layout},{},'right-panel');check();}
function check(){const visible=[...document.querySelectorAll('[data-page]')].filter(e=>getComputedStyle(e).visibility==='visible').map(e=>e.dataset.page);if(visible.join()!==selected)failures.push({selected,visible});}
function sample(){check();requestAnimationFrame(sample);}select('a');sample();window.fixture={select,failures,hosts};
`;
await writeFile(output + "/entry.ts", source);
await writeFile(output + "/index.html", '<header></header><nav></nav><script type="module" src="./entry.ts"></script>');
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: { noDiscovery: true, entries: [] },
  logLevel: "error",
});
await vite.listen();
await writeFile(
  output + "/main.cjs",
  `const{app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(()=>new BrowserWindow({width:390,height:844,webPreferences:{sandbox:true}}).loadURL(${JSON.stringify(vite.resolvedUrls!.local[0] + ".local/tab-display-ownership/index.html")}));`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let browser;
try {
  browser = await _electron.launch({
    executablePath: "/opt/opencraft/runtime/browser/electron/electron",
    args: [
      "--ozone-platform=headless",
      "--ozone-override-screen-size=1600,1200",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      output + "/main.cjs",
    ],
    env,
  });
  const page = await browser.firstWindow();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !!(window as any).fixture);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  for (const id of ["b", "c", "a", "b"]) {
    const box = await page.getByRole("button", { name: id, exact: true }).boundingBox();
    assert.ok(box);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(80);
  }
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  for (const id of ["c", "a", "b"]) await page.getByRole("button", { name: id, exact: true }).click();
  await page.evaluate(() => {
    (window as any).fixture.select("c");
    (window as any).fixture.select("a");
    (window as any).fixture.select("b");
  });
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => (window as any).fixture.failures), []);
  assert.deepEqual(
    await page.locator("[data-page] input").evaluateAll((es) => es.map((e) => (e as HTMLInputElement).value)),
    ["draft a", "draft b", "draft c"],
  );
  await page.screenshot({ path: output + "/selected-b.png" });
  console.log(
    JSON.stringify({
      ok: true,
      touch: true,
      mouse: true,
      rapidSwitch: true,
      perFrameIdentity: true,
      retainedDrafts: true,
    }),
  );
} finally {
  await browser?.close();
  await vite.close();
}
