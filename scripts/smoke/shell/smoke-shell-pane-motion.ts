import assert from "node:assert/strict";
import {mkdtemp,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
const {_electron}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE??"playwright");
const root=await mkdtemp("/tmp/oc-pane-");
const executablePath=process.env.OPENCRAFT_ELECTRON_EXECUTABLE??resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const env={...process.env,OPENCRAFT_MODEL_STORAGE_DIRECTORY:join(root,"models")};delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath,args:[...(process.env.OPENCRAFT_PACKAGED_SMOKE==="1"?[]:[resolve("apps/workbench-electron")]),`--user-data-dir=${join(root,"profile")}`],env});
try{
  const page=await app.firstWindow();
  // tsx/esbuild annotates nested function names; supply its inert helper only
  // in this isolated test renderer before installing the frame sampler.
  await page.evaluate("globalThis.__name = value => value");
  await page.locator(".opencraft-composer-editor").first().waitFor({timeout:30000});
  const editor=page.locator(".opencraft-composer-editor").first();
  await editor.fill("Draft remains intact while the tool panel changes.");
  const show=page.getByRole("button",{name:"Show task details",exact:true});
  if(await show.isVisible())await show.click();
  await page.getByRole("button",{name:"New browser tab",exact:true}).filter({visible:true}).first().click();
  await page.locator("webview").waitFor();
  await page.waitForTimeout(600);
  const backing=await page.locator("webview").evaluate((g:any)=>g.getWebContentsId());
  const initial=await page.locator(".main-content-frame").evaluate((e:HTMLElement)=>e.getBoundingClientRect().width);
  const measure=async(name:string,operation:()=>Promise<void>)=>{
    await page.evaluate(()=>{
      const host=window as any;host.__paneSamples=[];host.__paneRecording=true;
      const sample=(time:number)=>{
        const viewport=document.querySelector(".main-content-viewport")!,frame=document.querySelector(".main-content-frame")!,
          workspace=document.querySelector(".main-content-body")!,aside=document.querySelector(".app-shell-right-panel");
        host.__paneSamples.push({time,viewport:viewport.getBoundingClientRect().width,frame:frame.getBoundingClientRect().width,
          workspace:workspace.getBoundingClientRect().width,panel:aside?.getBoundingClientRect().width??0,
          toolContent:document.querySelector(".app-shell-right-panel__surface")?.getBoundingClientRect().width??0,
          full:viewport.getAttribute("data-app-shell-right-panel-full-width"),
          queryContainer:getComputedStyle(frame).containerName,composers:document.querySelectorAll(".opencraft-composer-editor").length});
        if(host.__paneRecording)requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    });
    await operation();await page.waitForTimeout(650);
    const samples=await page.evaluate(()=>{(window as any).__paneRecording=false;return (window as any).__paneSamples;});
    assert.ok(samples.length>2,name+" captured frames");
    for(const sample of samples){
      assert.ok(sample.frame>=initial-2,`${name}: collapsed chat frame ${JSON.stringify(sample)} baseline ${initial}`);
      assert.ok(sample.frame>=sample.viewport-2,name+" frame covers its aperture");
      assert.equal(sample.queryContainer,"app-shell-main-content");
      assert.equal(sample.composers,1);
      if(sample.full==="true")assert.ok(Math.abs(sample.toolContent-sample.workspace)<2,
        `${name}: maximized tool layout must use its destination width during the aperture transition: ${JSON.stringify(sample)}`);
      if(name==="reduced-motion")assert.ok(sample.viewport<=2||Math.abs(sample.viewport-initial)<=2,"reduced motion uses endpoint geometry");
    }
    await writeFile(join(root,name+".json"),JSON.stringify(samples,null,2));
    return {name,frames:samples.length,minFrame:Math.min(...samples.map((s:any)=>s.frame)),minViewport:Math.min(...samples.map((s:any)=>s.viewport))};
  };
  const results=[];
  results.push(await measure("maximize",()=>page.getByRole("button",{name:"Maximize panel",exact:true}).click()));
  results.push(await measure("restore",()=>page.getByRole("button",{name:"Restore panel",exact:true}).click()));
  results.push(await measure("rapid-reverse",async()=>{
    await page.getByRole("button",{name:"Maximize panel",exact:true}).click();
    await page.waitForTimeout(75);
    await page.getByRole("button",{name:"Restore panel",exact:true}).click();
  }));
  results.push(await measure("hide-from-full",async()=>{
    await page.getByRole("button",{name:"Maximize panel",exact:true}).click();
    await page.waitForTimeout(80);
    await page.getByRole("button",{name:"Hide task details",exact:true}).click();
  }));
  results.push(await measure("reopen",()=>page.getByRole("button",{name:"Show task details",exact:true}).click()));
  assert.equal(await editor.innerText(),"Draft remains intact while the tool panel changes.");
  assert.equal(await page.locator("webview").evaluate((g:any)=>g.getWebContentsId()),backing);
  if(await page.getByRole("button",{name:"Restore panel",exact:true}).isVisible())
    await page.getByRole("button",{name:"Restore panel",exact:true}).click();
  await page.waitForTimeout(600);
  const divider=page.getByRole("separator",{name:"Resize right panel",exact:true});
  const box=await divider.boundingBox();
  const beforeResize=await page.locator(".main-content-frame").evaluate((e:HTMLElement)=>e.getBoundingClientRect().width);
  await page.mouse.move(box!.x+1,box!.y+120);await page.mouse.down();
  await page.mouse.move(box!.x+61,box!.y+120,{steps:5});
  await page.waitForTimeout(100);
  const heldWidth=await page.locator(".main-content-frame").evaluate((e:HTMLElement)=>e.getBoundingClientRect().width);
  assert.ok(heldWidth>beforeResize+20,`ordinary resize changes Frame before pointer release: before=${beforeResize}, held=${heldWidth}, resizing=${await divider.getAttribute("data-resizing")}`);
  await page.mouse.up();
  await page.locator(".right-panel-resize-cursor").waitFor({state:"detached"});
  const cancelBox=await divider.boundingBox();
  const cancelWidth=await page.locator(".main-content-frame").evaluate((e:HTMLElement)=>e.getBoundingClientRect().width);
  await page.mouse.move(cancelBox!.x+1,cancelBox!.y+120);await page.mouse.down();
  await page.mouse.move(cancelBox!.x+31,cancelBox!.y+120,{steps:3});
  await page.evaluate(()=>window.dispatchEvent(new PointerEvent("pointercancel",{bubbles:true})));
  await page.locator(".right-panel-resize-cursor").waitFor({state:"detached"});
  await page.mouse.up();await page.waitForTimeout(50);
  assert.ok(Math.abs((await page.locator(".main-content-frame").evaluate((e:HTMLElement)=>e.getBoundingClientRect().width))-cancelWidth)<2,"cancel restores the starting geometry");
  await divider.dblclick();
  await page.waitForTimeout(100);
  await page.screenshot({path:join(root,"settled.png")});
  await page.emulateMedia({reducedMotion:"reduce"});
  // Motion reads the media preference during initialization.
  await page.reload();
  await page.locator(".opencraft-composer-editor").first().waitFor();
  await page.evaluate("globalThis.__name = value => value");
  if(await show.isVisible())await show.click();
  await page.getByRole("button",{name:"New browser tab",exact:true}).filter({visible:true}).first().click();
  await page.locator("webview").filter({visible:true}).first().waitFor();
  const maximize=page.getByRole("button",{name:"Maximize panel",exact:true});
  results.push(await measure("reduced-motion",async()=>{
    if(await maximize.isVisible())await maximize.click();
    await page.getByRole("button",{name:"Restore panel",exact:true}).click();
  }));
  console.log(JSON.stringify({passed:true,initialFrame:initial,backingPreserved:true,draftPreserved:true,ordinaryHeldResize:true,results,evidence:root}));
}finally{await app.close();}
