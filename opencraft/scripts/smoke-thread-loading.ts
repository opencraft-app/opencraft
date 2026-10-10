import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

// Actual Conversation, recovery state and stylesheet. No Host/inference writes.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {Context} from '@deepseek-ai/cordis';
import {createConversationKey,createDefaultTimelineProjectorRegistry,projectTimeline} from '@opencraft/chat-core';
import {buildCodexThemeCssProperties,codexThemePalette,lavenderThemePalette} from '@opencraft/design-system/theme-engine';
import {TimelineBlockRendererProvider,TimelineBlockRendererRegistryService} from '@opencraft/timeline-render-react';
import {BuiltinTimelineRendererPlugin} from '/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin.ts';
import {Conversation} from '/apps/workbench-web/src/components/conversation.tsx';
import {ConversationRecoveryEmptyState,ConversationRecoveryNotice,conversationRecoveryPresentation} from '/apps/workbench-web/src/components/conversation-recovery.tsx';
import '/apps/workbench-web/src/styles/app.scss';
const ctx=new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const key=createConversationKey('fixture','loading');
const history=projectTimeline({key,revision:1,authoritative:true,phase:'live',turns:Array.from({length:20},(_,i)=>({id:'turn-'+i,status:'complete',items:[
 {id:'u-'+i,type:'userMessage',payload:{id:'u-'+i,type:'userMessage',content:[{type:'text',text:'Prompt '+i}]}},
 {id:'a-'+i,type:'agentMessage',payload:{id:'a-'+i,type:'agentMessage',text:('Retained response '+i+'\\n\\n').repeat(6),phase:'final_answer'}}
]}))},createDefaultTimelineProjectorRegistry());
function theme(mode,family){
 document.documentElement.dataset.theme=mode;
 const palette=family==='custom'?lavenderThemePalette[mode]:codexThemePalette[mode];
 for(const [name,value] of Object.entries(buildCodexThemeCssProperties(mode,palette)))document.documentElement.style.setProperty(name,value);
}
theme('light','codex');
window.loadingFixture={theme};
function Demo(){
 const [state,setState]=useState('cold-stage');
 window.loadingFixture.set=setState;
 const warm=state.startsWith('warm')||state==='ready';
 const failed=state.endsWith('error');
 const presentation=conversationRecoveryPresentation({authoritative:state==='ready',hasVisibleHistory:warm,failed});
 const retry=()=>setState('cold-view');
 return <main className="local-conversation-page" style={{height:'100vh',background:'var(--color-background-surface)'}}>
  <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
   {state==='cold-stage'?<div className="conversation-recovery-cold-stage"><ConversationRecoveryEmptyState failed={false}/></div>:
    <Conversation scrollPolicy="natural" timeline={warm?history:null}
     emptyState={<ConversationRecoveryEmptyState failed={failed} onRetry={retry}/>}
     footer={<footer style={{height:60,padding:8}}><input aria-label="Draft" defaultValue="preserved draft"/></footer>}/>
   }
   {presentation==='warm-loading'||presentation==='warm-error'?<ConversationRecoveryNotice failed={failed} reconnecting={true} onRetry={()=>setState('warm-loading')}/>:null}
  </TimelineBlockRendererProvider>
 </main>;
}
createIntlTestRoot(document.getElementById('root')).render(<Demo/>);
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-thread-loading",
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "thread-loading-fixture",
    resolveId: id => id === "/loading-probe.tsx" ? id : null,
    load: id => id === "/loading-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<html><head><title>Thread loading regression</title></head><body><div id="root"></div><script type="module" src="/loading-probe.tsx"></script></body></html>');
    }); },
  }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const evidenceDir = process.env.OPENCRAFT_THREAD_LOADING_EVIDENCE_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const results: unknown[] = [];
  for (const touch of [false, true]) for (const family of ["codex", "custom"]) for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 800 }, hasTouch: touch });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.addInitScript("window.__name=value=>value");
      await page.goto(origin);
      const ring = page.locator(".workbench-loading-spinner");
      await ring.waitFor();
      await page.evaluate(({ mode, family }: any) => (window as any).loadingFixture.theme(mode, family), { mode, family });
      const setState = async (state: string) => page.evaluate(state => (window as any).loadingFixture.set(state), state);
      for (const stage of ["cold-stage", "cold-view"]) {
        await setState(stage);
        await ring.waitFor();
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".conversation-recovery-loading")!).opacity === "1");
        const rendered = await ring.evaluate((el: SVGElement) => {
          const rect = el.getBoundingClientRect();
          const parent = el.parentElement!.getBoundingClientRect();
          const label = el.parentElement!.querySelector("span")!;
          const probe = document.createElement("span");
          probe.style.color = "var(--color-text-secondary)";
          el.parentElement!.append(probe);
          const expectedColor = getComputedStyle(probe).color;
          probe.remove();
          return { width: parseFloat(getComputedStyle(el).width), height: parseFloat(getComputedStyle(el).height),
            dx: rect.x + rect.width / 2 - parent.x - parent.width / 2,
            dy: rect.y + rect.height / 2 - parent.y - parent.height / 2,
            regionHeight: parent.height, regionTop: parent.top, regionBottom: parent.bottom,
            labelWidth: label.getBoundingClientRect().width,
            color: getComputedStyle(el).color, expectedColor,
            pointer: getComputedStyle(el).pointerEvents,
            animation: getComputedStyle(el).animationName,
            focusable: el.getAttribute("focusable"), hidden: el.getAttribute("aria-hidden") };
        });
        assert.equal(rendered.width, 24); assert.equal(rendered.height, 24);
        assert.ok(Math.abs(rendered.dx) <= 1 && Math.abs(rendered.dy) <= 1, JSON.stringify(rendered));
        assert.ok(rendered.regionHeight > 500 && rendered.regionBottom <= 800, "empty slot must occupy available chat height, not content height or whole page overflow");
        assert.ok(rendered.labelWidth <= 1, "label must remain screen-reader only");
        assert.equal(rendered.pointer, "none"); assert.equal(rendered.focusable, "false"); assert.equal(rendered.hidden, "true");
        assert.equal(rendered.color, rendered.expectedColor, "spinner uses semantic theme color, not blue/accent");
        assert.equal(rendered.animation, "workbench-loading-spin");
        assert.equal(await page.locator(".conversation-recovery-loading").evaluate(el =>
          [...el.children].filter(child => child.tagName.toLowerCase() !== "svg" && child.className !== "conversation-recovery-loading__label").length), 0, "only ring and screen-reader label, no visible loading prose");
        await page.waitForFunction(() => document.querySelector(".workbench-loading-spinner")!.getAnimations().some(a => a.currentTime !== null && Number(a.currentTime) > 50));
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await ring.evaluate(el => getComputedStyle(el).animationName), "none");
        assert.equal(await ring.evaluate(el => getComputedStyle(el.parentElement!).opacity), "1");
        await page.emulateMedia({ reducedMotion: "no-preference" });
      }
      await page.emulateMedia({ forcedColors: "active" });
      assert.ok(await ring.evaluate(el => getComputedStyle(el).color !== "rgba(0, 0, 0, 0)"));
      await page.emulateMedia({ forcedColors: "none" });
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `${touch ? "touch" : "desktop"}-${family}-${mode}.png`) });
      await setState("cold-error");
      await page.getByRole("alert").waitFor();
      assert.equal(await ring.count(), 0, "error must not keep spinning indefinitely");
      const retry = page.getByRole("button", { name: "Try again" });
      if (touch) await retry.tap(); else await retry.click();
      await ring.waitFor();
      await setState("ready");
      await page.locator(".thread-scroll").waitFor();
      await page.getByText("Prompt 19", { exact: true }).waitFor();
      assert.equal(await ring.count(), 0);
      // The real virtualizer measures a newly populated history after paint.
      // Begin the recovery assertion only after that initial layout settles.
      await page.evaluate(async () => {
        const scroll = document.querySelector(".thread-scroll")! as HTMLElement;
        let lastHeight = -1, stableFrames = 0;
        while (stableFrames < 8) {
          await new Promise(requestAnimationFrame);
          const height = scroll.scrollHeight;
          stableFrames = height === lastHeight ? stableFrames + 1 : 0;
          lastHeight = height;
        }
      });
      await page.getByRole("textbox", { name: "Draft" }).fill("Keep my unsent input");
      const original = await page.evaluate(async () => {
        const scroll = document.querySelector(".thread-scroll")! as HTMLElement;
        scroll.scrollTop = -150;
        let last = NaN, stable = 0;
        while (stable < 8) {
          await new Promise(requestAnimationFrame);
          stable = scroll.scrollTop === last ? stable + 1 : 0;
          last = scroll.scrollTop;
        }
        (window as any).retainedScroll = scroll;
        (window as any).retainedDraft = document.querySelector("input");
        return scroll.scrollTop;
      });
      for (const state of ["warm-loading", "warm-error", "ready"]) {
        await setState(state);
        if (state !== "ready") await page.locator(".conversation-recovery-notice").waitFor();
        else await page.locator(".conversation-recovery-notice").waitFor({ state: "detached" });
        assert.equal(await ring.count(), 0);
        const retained = await page.evaluate(() => ({
          sameScroll: (window as any).retainedScroll === document.querySelector(".thread-scroll"),
          scroll: (document.querySelector(".thread-scroll")! as HTMLElement).scrollTop,
          sameDraft: (window as any).retainedDraft === document.querySelector("input"),
          draft: document.querySelector("input")!.value,
        }));
        assert.equal(retained.sameScroll, true); assert.equal(retained.sameDraft, true);
        assert.ok(Math.abs(retained.scroll - original) <= 1, JSON.stringify({ state, original, ...retained }));
        assert.equal(retained.draft, "Keep my unsent input");
        assert.equal(await page.getByText("Prompt 19", { exact: true }).count(), 1);
      }
      assert.deepEqual(errors, []);
      results.push({ touch, family, mode, coldSlots: 2, warmHistoryPreserved: true, reducedMotion: true, retry: true });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: true, cases: results.length, externalWrites: false, results }, null, 2));
} finally { await browser?.close(); await vite.close(); }
