import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
// macOS Unix sockets have a short path limit; its default tmpdir is too long.
const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "oc-browser-"));
const server = createServer((req, res) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>${req.url === "/popup" ? "Popup" : req.url === "/two" ? "Second" : "First"} fixture</title><input id="draft"><a id="next" href="/two">Next</a><a id="popup" target="_blank" href="/popup">Popup</a><script>window.fixtureIdentity=crypto.randomUUID()</script>`);
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
let app: any;
try {
  const env = { ...process.env, OPENCRAFT_MODEL_STORAGE_DIRECTORY: join(root, "models") };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.OPENCRAFT_ELECTRON_EXECUTABLE
    ?? resolve("node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
  const launchArgs = [...(process.env.OPENCRAFT_PACKAGED_SMOKE === "1" ? [] : [resolve("apps/workbench-electron")]), `--user-data-dir=${join(root, "profile")}`];
  app = await _electron.launch({ executablePath, args: launchArgs, env });
  const page = await app.firstWindow();
  await page.locator(".opencraft-composer-editor").first().waitFor({ timeout: 30000 }).catch(async (error: unknown) => {
    console.log("startup", page.url(), (await page.locator("body").innerText()).slice(0, 1500));
    throw error;
  });
  const browserButton = page.getByRole("button", { name: "New browser tab", exact: true }).filter({ visible: true }).first();
  if (!await browserButton.isVisible()) await page.getByRole("button", { name: "Show task details", exact: true }).click();
  await browserButton.click();
  const address = page.getByRole("textbox", { name: "Web address", exact: true });
  await address.fill(base + "/one"); await address.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("webview")].some((e: any) => {
    try { return e.getTitle() === "First fixture"; } catch { return false; }
  }));
  const guest = page.locator("webview").first();
  const before = await guest.evaluate((g: any) => ({ id: g.getWebContentsId(), partition: g.getAttribute("partition") }));
  await guest.evaluate((g: any) => g.executeJavaScript('document.querySelector("#draft").value="kept"; window.fixtureIdentity'));
  const identity = await guest.evaluate((g: any) => g.executeJavaScript("window.fixtureIdentity"));
  await page.getByRole("button", { name: "Hide task details", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("webview")?.getAttribute("data-browser-surface-visible") === "false");
  await page.getByRole("button", { name: "Show task details", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("webview")?.getAttribute("data-browser-surface-visible") === "true");
  assert.equal(await guest.evaluate((g: any) => g.executeJavaScript("window.fixtureIdentity")), identity);
  assert.equal(await guest.evaluate((g: any) => g.executeJavaScript('document.querySelector("#draft").value')), "kept");
  // Native navigation updates toolbar without parent DOM access to the page.
  await guest.evaluate((g: any) => g.executeJavaScript('document.querySelector("#next").click()', true));
  await page.waitForFunction(() => (document.querySelector('input[aria-label="Web address"]') as HTMLInputElement)?.value.endsWith("/two"));
  await page.locator(".browser-panel").getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('input[aria-label="Web address"]') as HTMLInputElement)?.value.endsWith("/one"));
  const after = await guest.evaluate((g: any) => ({ id: g.getWebContentsId(), partition: g.getAttribute("partition") }));
  assert.deepEqual(after, before);
  assert.ok(identity);
  const privileges = await guest.evaluate((g: any) => g.executeJavaScript('({node:typeof require,bridge:typeof opencraftDesktop})'));
  assert.deepEqual(privileges, { node: "undefined", bridge: "undefined" });
  const bridgeCode = await page.evaluate(() => fetch("/__opencraft/preview-bridge.js").then(r => r.text()));
  const context = await guest.evaluate((g: any, code: string) => g.executeJavaScript(code + `;
    (async () => {
      const cleanup=OpenCraftPreviewBridgeRuntime.installPreviewBridgeRuntime({window,parentOrigin:location.origin});
      const adapter=new OpenCraftPreviewBridgeRuntime.PreviewBridgeAdapter({
        hostWindow:window,frameWindow:window,targetOrigin:location.origin,previewId:"fixture",generation:1
      });
      try {return await adapter.readContext();} finally {adapter.dispose();cleanup();}
    })()`), bridgeCode);
  assert.equal(context.title, "First fixture");
  const background = await page.evaluate(async (url:string) => {
    const element:any=document.querySelector(".browser-panel");
    let fiber=element[Object.keys(element).find(key=>key.startsWith("__reactFiber"))!], runtime:any;
    for(;fiber;fiber=fiber.return){
      const value=fiber.memoizedProps?.value;
      if(value?.pages&&value?.presentations&&value?.workbench){runtime=value;break;}
    }
    if(!runtime)throw new Error("Browser runtime context not found");
    const owner=runtime.pages.list()[0].ownerId;
    const opened=runtime.workbench.open(owner,{initialUrl:url,visible:false});
    const inspection=await runtime.pages.inspectPage(opened.pageId);
    const dataUrl=await runtime.pages.capturePage(opened.pageId);
    const active=runtime.presentations.manager.isBrowserUseActive(owner,opened.pageId);
    runtime.workbench.close(owner,opened.tabId);
    return {title:inspection.title,image:dataUrl.startsWith("data:image/png"),released:!active,closed:runtime.pages.getSnapshot(opened.pageId)===null};
  },base+"/two");
  assert.deepEqual(background,{title:"Second fixture",image:true,released:true,closed:true});
  const originalPageId = await guest.getAttribute("data-browser-page-id");
  await guest.evaluate((g:any) => g.executeJavaScript('document.querySelector("#popup").click()',true));
  await page.getByRole("tab",{name:"Popup fixture",exact:true}).waitFor();
  assert.equal(await guest.evaluate((g:any)=>g.getURL()),base+"/one");
  await page.getByRole("tab",{name:"First fixture",exact:true}).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button",{name:"Toggle device toolbar",exact:true}).click();
  await page.getByRole("combobox",{name:"Device preset",exact:true}).selectOption("iphone-15-pro");
  const width = page.getByRole("spinbutton",{name:"Viewport width",exact:true});
  await width.fill("500");
  await width.press("Tab");
  await page.waitForFunction((id:string)=>[...document.querySelectorAll("webview")].find(e=>e.getAttribute("data-browser-page-id")===id)?.style.width==="500px",originalPageId);
  await page.getByRole("button",{name:"Rotate viewport",exact:true}).click();
  assert.equal(await width.inputValue(),"852");
  await page.getByRole("button",{name:"Rotate viewport",exact:true}).click();
  assert.equal(await width.inputValue(),"500");
  const resize = page.getByRole("button",{name:"Resize viewport bottom-right",exact:true});
  const box = await resize.boundingBox();
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);
  await page.mouse.down();
  await page.mouse.move(box!.x+box!.width/2-30,box!.y+box!.height/2+15,{steps:4});
  assert.notEqual(await width.inputValue(),"500","held drag must update the actual viewport before release");
  await page.mouse.up();
  await width.press("Tab");
  await page.screenshot({path:join(root,"device-toolbar.png")});
  await page.getByRole("button",{name:"Maximize panel",exact:true}).click();
  await page.getByRole("combobox",{name:"Browser zoom",exact:true}).selectOption("125");
  assert.equal(await guest.evaluate((g:any)=>g.getZoomFactor()),1.25);
  await page.getByRole("combobox",{name:"Browser zoom",exact:true}).selectOption("100");
  for(const windowWidth of [980,760]) {
    await app.evaluate(({BrowserWindow}:any,width:number)=>BrowserWindow.getAllWindows()[0].setBounds({width}),windowWidth);
    await page.waitForTimeout(150);
    const geometry=await page.getByRole("toolbar",{name:"Device toolbar",exact:true}).evaluate((element:HTMLElement)=>{
      const r=element.getBoundingClientRect();
      return {height:r.height,overflow:element.scrollWidth>element.clientWidth,
        outside:[...element.querySelectorAll("input,select,button")].filter((control)=>{
          const box=control.getBoundingClientRect();return box.width>0&&(box.left<r.left-1||box.right>r.right+1);
        }).length};
    });
    assert.equal(geometry.height,34);assert.equal(geometry.overflow,false);assert.equal(geometry.outside,0);
  }
  const setTheme = async (theme:"light"|"dark") => {
    await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setBounds({width:1440}));
    await page.waitForTimeout(150);
    const settings=page.getByRole("button",{name:"Settings",exact:true}).filter({visible:true}).first();
    if(!await settings.isVisible())await page.getByRole("button",{name:"Applications",exact:true}).filter({visible:true}).first().click();
    await page.getByRole("button",{name:"Settings",exact:true}).filter({visible:true}).first().click();
    const appearance=page.getByRole("button",{name:"Appearance",exact:true}).filter({visible:true});
    if(await appearance.count())await appearance.first().click();
    await page.getByRole("radio",{name:theme==="dark"?"Dark":"Light",exact:true}).click();
    await page.getByRole("button",{name:"Chat",exact:true}).filter({visible:true}).first().click();
    const show=page.getByRole("button",{name:"Show task details",exact:true});
    if(await show.isVisible())await show.click();
  };
  await setTheme("dark");
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
  await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].setBounds({width:760}));
  await page.waitForFunction(()=>{
    const handles=document.querySelector(".browser-device-handles")?.getBoundingClientRect();
    const guest=[...document.querySelectorAll("webview")].find(e=>e.getAttribute("data-browser-surface-visible")==="true")?.getBoundingClientRect();
    return handles&&guest&&Math.abs(handles.width-guest.width)<2&&Math.abs(handles.height-guest.height)<2&&Math.abs(handles.y-guest.y)<2;
  });
  await page.screenshot({path:join(root,"device-toolbar-narrow-dark.png")});
  await setTheme("light");
  await app.evaluate(({BrowserWindow}:any)=>{BrowserWindow.getAllWindows()[0].setBounds({width:1440});});
  await page.getByRole("button",{name:"Restore panel",exact:true}).click();
  await page.getByRole("button",{name:"Close device toolbar",exact:true}).click();
  await page.getByRole("button", { name: "New browser tab", exact: true }).filter({ visible: true }).first().click();
  await address.fill(base + "/two"); await address.press("Enter");
  await page.getByRole("tab", { name: "Second fixture", exact: true }).waitFor();
  await page.getByRole("tab", { name: "First fixture", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const guest = [...document.querySelectorAll("webview")].find((g: any) => g.getTitle?.() === "First fixture");
    return guest?.getAttribute("data-browser-surface-visible") === "true";
  });
  assert.equal(await guest.evaluate((g: any) => g.getWebContentsId()), before.id);
  assert.equal(await guest.evaluate((g: any) => g.executeJavaScript('document.querySelector("#draft").value')), "kept");
  await guest.evaluate((g: any) => g.executeJavaScript('document.cookie="fixture=kept; Max-Age=3600; SameSite=Lax"'));
  // Crash only the isolated synthetic guest, never the workbench or user's profile.
  await app.evaluate(({webContents}:any,id:number)=>webContents.fromId(id).forcefullyCrashRenderer(),before.id);
  await page.getByText("浏览器页面进程已退出，请点击重新加载恢复。",{exact:true}).waitFor();
  await page.getByRole("button",{name:"重新加载页面",exact:true}).click();
  await page.waitForFunction((id:string)=>{
    const g:any=[...document.querySelectorAll("webview")].find(e=>e.getAttribute("data-browser-page-id")===id);
    try{return g?.getTitle()==="First fixture"&&!g.isLoading();}catch{return false;}
  },originalPageId);
  assert.equal(await guest.getAttribute("data-browser-page-id"),originalPageId);
  assert.equal(await guest.getAttribute("partition"),before.partition);
  // Exercise the real Main permission policy with a deterministic dialog
  // response; deny geolocation so no OS location service is accessed.
  await app.evaluate(({dialog}:any)=>{
    (globalThis as any).__browserPrompts=[];
    dialog.showMessageBox=async(...args:any[])=>{
      (globalThis as any).__browserPrompts.push(args.at(-1).message);
      return {response:0,checkboxChecked:true};
    };
  });
  const denied=await guest.evaluate((g:any)=>g.executeJavaScript('new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve(false),error=>resolve(error.code===1),{timeout:3000}))'));
  assert.equal(denied,true);
  const prompts=await app.evaluate(()=> (globalThis as any).__browserPrompts);
  assert.ok(prompts.some((prompt:string)=>prompt.includes(base)&&prompt.includes("位置")));
  await app.evaluate(({dialog}:any)=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  await page.getByRole("button",{name:"网站设置",exact:true}).click();
  await page.getByRole("menuitem",{name:"网站权限",exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll("webview")].some((g:any)=>{try{return g.getTitle()==="First fixture"&&!g.isLoading();}catch{return false;}}));
  await guest.evaluate((g:any)=>g.executeJavaScript('document.cookie="delete_me=yes; Max-Age=3600";localStorage.setItem("delete_me","yes")'));
  await page.getByRole("button",{name:"网站设置",exact:true}).click();
  await page.getByRole("menuitem",{name:"清除网站数据",exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll("webview")].some((g:any)=>{try{return g.getTitle()==="First fixture"&&!g.isLoading();}catch{return false;}}));
  const cleared=await guest.evaluate((g:any)=>g.executeJavaScript('({cookie:document.cookie,stored:localStorage.getItem("delete_me")})'));
  assert.equal(cleared.stored,null);assert.equal(cleared.cookie.includes("delete_me"),false);
  await guest.evaluate((g:any)=>g.executeJavaScript('document.cookie="fixture=kept; Max-Age=3600; SameSite=Lax"'));
  await page.getByRole("button",{name:"网站设置",exact:true}).click();
  await page.getByRole("menuitem",{name:"清理已关闭标签数据",exact:true}).click();
  const metadata = await page.evaluate(async () => {
    const state = (window as any).opencraftDesktop.browserState;
    return await state.read();
  });
  assert.ok(metadata["opencraft.browser-storage.v1"]);
  await page.screenshot({ path: join(root, "browser.png") });
  await app.close();
  app = await _electron.launch({ executablePath, args: launchArgs, env });
  const restored = await app.firstWindow();
  await restored.locator(".opencraft-composer-editor").first().waitFor({ timeout: 30000 });
  const restoredMetadata = await restored.evaluate(() => (window as any).opencraftDesktop.browserState.read());
  assert.equal(restoredMetadata["opencraft.browser-storage.v1"], metadata["opencraft.browser-storage.v1"]);
  const cookies = await app.evaluate(({ session }: any, params: any) => session.fromPartition(params.partition).cookies.get({url: params.url}), {partition: before.partition, url: base});
  assert.ok(cookies.some((cookie: any) => cookie.name === "fixture" && cookie.value === "kept"));
  console.log(JSON.stringify({ passed: true, nativeWebview: true, denyFramingPageLoaded: true, navigation: true,
    isolation: true, bridge: true, restartStorage: true, managedPopup:true,backgroundReadCapture:true,heldResize:true,crashRecovery:true,permissionRevokeAndClear:true,evidence: root }));
} finally {
  await app?.close();
  await new Promise<void>(r => server.close(() => r()));
}
