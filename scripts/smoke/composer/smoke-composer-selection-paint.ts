import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const engine = process.env.OPENCRAFT_SMOKE_BROWSER === "webkit" ? "webkit" : "chromium";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/composer-selection-paint";
const legacyCss = process.env.OPENCRAFT_SMOKE_CSS ? await readFile(process.env.OPENCRAFT_SMOKE_CSS, "utf8") : null;
const source = `import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {useTimelineViewportHost} from '/apps/workbench-web/src/timeline-viewport.ts';
import * as theme from '@opencraft/design-system/theme-engine';
import '/apps/workbench-web/src/styles/app.scss';
const p=new URLSearchParams(location.search),mode=p.get('theme')||'light';
Object.assign(document.documentElement.dataset,{theme:mode,uiDensity:'touch',touchNewera:p.get('newera')});
for(const [key,value] of Object.entries(theme.buildOpenCraftThemeCssProperties(mode,theme.opencraftNeutralThemePalette[mode])))document.documentElement.style.setProperty(key,value);
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'selection'}},{now:Date.now,createId:()=>crypto.randomUUID()});
window.fixture={controller};
function App(){useTimelineViewportHost({kind:'browser',platform:'linux',safeArea:{left:0,right:0}});return <main className='app-shell-root' style={{background:'var(--color-surface)',padding:12}}><div className='thread-scroll-layout'><div className='thread-scroll' data-thread-find-target='conversation'><div className='thread-scroll-surface'>
<article className='thread-content opencraft-chat-document' style={{padding:'16px 12px',fontSize:18,lineHeight:1.5}}>{Array.from({length:32},(_,i)=><p key={i}>Reading paragraph {i}. Select this text and keep the message controls visible.</p>)}<p id='selected-text'>service worker 在这个场景能干嘛</p></article>
<div className='thread-scroll-footer' data-thread-scroll-footer='true'><div className='thread-scroll-footer__gradient'/><div className='thread-scroll-footer__content'><OpenCraftComposer controller={controller} placeholder='Write a message' onSubmit={()=>false} onCancel={()=>{}} endActions={<button className='opencraft-composer-icon-button' aria-label='Microphone'>M</button>}/></div></div>
</div></div></div></main>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ root: process.cwd(), configFile: false, logLevel: "error",
  cacheDir: "node_modules/.vite-composer-selection-paint", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "selection-paint", resolveId: id => id === "/selection-paint.tsx" || id === "/selection-paint.css" ? id : null,
    load: id => id === "/selection-paint.tsx" ? (legacyCss === null ? source : source.replace("/apps/workbench-web/src/styles/app.scss", "/selection-paint.css")) : id === "/selection-paint.css" ? legacyCss : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/selection-paint.tsx"></script>');
    }); },
  }],
});
await mkdir(output, { recursive: true });
await vite.listen();
const browser = await playwright[engine].launch(engine === "chromium" ? {
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"],
} : {});
const results: unknown[] = [];
try {
  for (const mode of ["light", "dark"]) for (const newera of ["on", "off"]) for (const draft of ["", "Keep this draft"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
    await context.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
      const visual = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: visual });
      (window as any).setViewport = (height: number, top: number) => {
        Object.assign(visual, { height, pageTop: top, offsetTop: top });
        visual.dispatchEvent(new Event("resize")); visual.dispatchEvent(new Event("scroll"));
      };
    });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${vite.resolvedUrls!.local[0]}?theme=${mode}&newera=${newera}`);
    const editor = page.locator(".opencraft-composer-editor"), shell = page.locator(".opencraft-composer-shell");
    await editor.waitFor();
    // Focus -> keyboard contraction -> blur to transcript -> selection -> native
    // pan/recovery. This projects geometry; it does not emulate an iOS callout.
    await editor.tap();
    if (draft) await editor.fill(draft);
    await editor.evaluate(node => { (window as any).keptEditor = node; });
    await page.evaluate(() => (window as any).setViewport(480, 0));
    await editor.evaluate(node => (node as HTMLElement).blur());
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.getElementById("selected-text")!);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      (window as any).selectedText = getSelection()!.toString();
    });
    const stages = [[480, 96], [844, 96], [844, 0]];
    for (const [height, top] of stages) {
      await page.evaluate(({ height, top }) => {
        (window as any).setViewport(height, top);
        document.querySelector(".thread-scroll")!.scrollTop = -40;
        document.dispatchEvent(new Event("selectionchange"));
      }, { height, top });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => getSelection()!.toString()), "service worker 在这个场景能干嘛");
      assert(await editor.evaluate(node => node === (window as any).keptEditor));
      assert.equal(await editor.textContent(), draft);
      const order = await shell.evaluate(node => {
        const material = getComputedStyle(node, "::before");
        // Check the boxes that actually paint: display:contents has no layer.
        const front = [node.querySelector(".opencraft-composer-input-row")!,
          ...node.querySelectorAll(".opencraft-composer-footer > *")].filter(item => getComputedStyle(item).display !== "none");
        return { material: Number(material.zIndex), filter: material.backdropFilter || material.getPropertyValue("-webkit-backdrop-filter"),
          front: front.map(item => ({ z: Number(getComputedStyle(item).zIndex), position: getComputedStyle(item).position })),
          rect: node.getBoundingClientRect().toJSON() };
      });
      assert.equal(order.material, 0, "material stays in the nonnegative background plane");
      assert(order.front.every(item => item.position !== "static" && item.z > order.material), "editable and command boxes have an independent foreground, including flattened footer items");
      assert(order.filter.includes("blur("));
      assert(order.rect.y >= -1 && order.rect.bottom <= height + top + 1, JSON.stringify(order));
    }
    // Pixel evidence for BOTH input and commands, without relying on DOM
    // visibility (which cannot detect a layer covering otherwise-visible text).
    await page.evaluate(() => { (document.querySelector(".opencraft-composer-shell") as HTMLElement).style.setProperty("--composer-surface-background", "rgb(140, 180, 200)"); });
    const painted = await shell.screenshot();
    const hideInput = await page.addStyleTag({ content: ".opencraft-composer-input-row{visibility:hidden}" });
    const noInput = await shell.screenshot(); await hideInput.evaluate(node => node.remove());
    assert(!painted.equals(noInput), "input text/placeholder actually paints above the material");
    const hideCommands = await page.addStyleTag({ content: ".opencraft-composer-footer > *{visibility:hidden}" });
    const noCommands = await shell.screenshot(); await hideCommands.evaluate(node => node.remove());
    assert(!painted.equals(noCommands), "command contents actually paint above the material");
    await shell.evaluate(node => (node as HTMLElement).style.removeProperty("--composer-surface-background"));
    await page.screenshot({ path: `${output}/${engine}-${mode}-${newera}-${draft ? "draft" : "empty"}.png` });
    await editor.tap(); assert.equal(await editor.textContent(), draft);
    await editor.press("End"); await page.keyboard.type("X");
    assert.equal(await editor.textContent(), `${draft}X`, "same editor remains editable after selection ends");
    assert.deepEqual(errors, []);
    results.push({ mode, newera, draft: !!draft, stages: stages.length });
    await context.close();
  }
  await writeFile(`${output}/${engine}.json`, JSON.stringify({ engine, results }, null, 2));
  console.log(`PASS ${engine}: ${results.length} actual Composer scenes, selected transcript, viewport recovery, foreground pixels and continued editing`);
} finally { await browser.close(); await vite.close(); }
