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
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette,lavenderThemePalette} from '@opencraft/design-system/theme-engine';
import {TimelineBlockRendererProvider,TimelineBlockRendererRegistryService} from '@opencraft/timeline-render-react';
import {BuiltinTimelineRendererPlugin} from '/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin.ts';
import {Conversation} from '/apps/workbench-web/src/components/conversation.tsx';
import {ConversationRecoveryEmptyState,ConversationRecoveryNotice,conversationRecoveryPresentation,conversationRecoveryIsPending,conversationRecoveryIsUnstable} from '/apps/workbench-web/src/components/conversation-recovery.tsx';
import {useConversationRecoveryDiagnostic} from '/apps/workbench-web/src/runtime/conversation-recovery-diagnostic.ts';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import '/apps/workbench-web/src/styles/app.scss';
const ctx=new Context();
await ctx.plugin(TimelineBlockRendererRegistryService);
await ctx.plugin(BuiltinTimelineRendererPlugin);
const key=createConversationKey('fixture','loading');
const controller=createComposerController({type:'existing-thread',key},{now:Date.now,createId:()=>crypto.randomUUID()});
const history=projectTimeline({key,revision:1,authoritative:true,phase:'live',turns:Array.from({length:20},(_,i)=>({id:'turn-'+i,status:'complete',items:[
 {id:'u-'+i,type:'userMessage',payload:{id:'u-'+i,type:'userMessage',content:[{type:'text',text:'Prompt '+i}]}},
 {id:'a-'+i,type:'agentMessage',payload:{id:'a-'+i,type:'agentMessage',text:('Retained response '+i+'\\n\\n').repeat(6),phase:'final_answer'}}
]}))},createDefaultTimelineProjectorRegistry());
function theme(mode,family){
 document.documentElement.dataset.theme=mode;
 const palette=family==='custom'?lavenderThemePalette[mode]:opencraftNeutralThemePalette[mode];
 for(const [name,value] of Object.entries(buildOpenCraftThemeCssProperties(mode,palette)))document.documentElement.style.setProperty(name,value);
}
theme('light','neutral');
window.loadingFixture={theme};
function Demo(){
 const [state,setState]=useState('cold-stage');
 window.loadingFixture.set=setState;
 const [scope,setScope]=useState('a');
 const [tick,setTick]=useState(0);
 window.loadingFixture.setScope=setScope; window.loadingFixture.render=()=>setTick(x=>x+1);
 const warm=state.startsWith('warm')||state==='ready';
 const failed=state.endsWith('error');
 const requiresUpdate=state.endsWith('update-error');
 const diagnostic=useConversationRecoveryDiagnostic({scope,failed,active:state!=='ready',stage:warm?'history':'connection',error:null,runtime:state==='warm-reconnecting'?'reconnecting':failed?'error':'ready',transport:{state:failed?'failed':'open'}});
 const presentation=conversationRecoveryPresentation({authoritative:state==='ready',hasVisibleHistory:warm,failed});
 return <main className="local-conversation-page" style={{height:'100vh','--thread-content-top-inset':'0px',background:'var(--color-background-surface)',overflow:'hidden'}}>
  <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}>
   <Conversation scrollPolicy="natural" timeline={warm?history:null}
     emptyState={<ConversationRecoveryEmptyState failed={failed} requiresUpdate={requiresUpdate}/>}
     footer={<footer style={{padding:8}}>
      {presentation==='warm-error'?<ConversationRecoveryNotice failed requiresUpdate={requiresUpdate}/>:null}
      <OpenCraftComposer controller={controller} isStreaming={false} isUnstable={conversationRecoveryIsUnstable(presentation,diagnostic)} isRecovering={conversationRecoveryIsPending(presentation,diagnostic,requiresUpdate)} onSubmit={()=>false} onCancel={()=>{}}/>
     </footer>}/>
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
  for (const width of [1280, 320, 390]) for (const family of ["neutral", "custom"]) for (const mode of ["light", "dark"]) {
    const touch = width < 600;
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch, permissions: ["clipboard-read", "clipboard-write"] });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.addInitScript("window.__name=value=>value");
      await page.goto(origin);
      const scan = page.locator(".opencraft-composer-recovery");
      const beam = page.locator(".opencraft-composer-recovery__beam").first();
      await scan.waitFor();
      await page.evaluate(({ mode, family }: any) => (window as any).loadingFixture.theme(mode, family), { mode, family });
      const setState = async (state: string) => page.evaluate(state => (window as any).loadingFixture.set(state), state);
      const expectActive = async () => {
        await page.waitForFunction(() => {
          const el = document.querySelector(".opencraft-composer-recovery");
          return el?.getAttribute("data-active") === "true" && Number(getComputedStyle(el).opacity) > .99;
        });
      };
      for (const stage of ["cold-stage", "cold-view"]) {
        await setState(stage);
        await expectActive();
        assert.equal(await page.locator('.opencraft-composer-shell').getAttribute('data-warning'), null, 'ordinary entry is not a reconnect warning');
        assert.equal(await page.locator('.opencraft-composer-shell').getAttribute('data-loading'), 'true', 'ordinary loading gets the faint tint');
        const rendered = await scan.evaluate(el => {
          const svg = el.querySelector("svg")!;
          const rect = el.getBoundingClientRect();
          const shell = el.parentElement!.getBoundingClientRect();
          return { width: rect.width, height: rect.height,
            shellWidth: shell.width, shellHeight: shell.height,
            labelWidth: el.querySelector("span")!.getBoundingClientRect().width,
            pointer: getComputedStyle(el).pointerEvents,
            focusable: svg.getAttribute("focusable"), hidden: svg.getAttribute("aria-hidden"),
            stroke: getComputedStyle(svg).stroke };
        });
        assert.ok(rendered.width > 200 && rendered.height > 30);
        assert.ok(Math.abs(rendered.width - rendered.shellWidth) <= 2 && Math.abs(rendered.height - rendered.shellHeight) <= 2, "scan follows existing composer border");
        assert.ok(rendered.labelWidth <= 1, "label remains screen-reader only");
        assert.equal(rendered.pointer, "none"); assert.equal(rendered.focusable, "false"); assert.equal(rendered.hidden, "true");
        assert.notEqual(rendered.stroke, "none");
        assert.equal(await page.locator(".conversation-recovery-loading,.conversation-recovery-cold-stage").count(), 0, "no central loading chrome");
        const offset = await beam.evaluate(el => getComputedStyle(el).strokeDashoffset);
        await page.waitForTimeout(180);
        assert.notEqual(await beam.evaluate(el => getComputedStyle(el).strokeDashoffset), offset, "scan must move");
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await beam.evaluate(el => getComputedStyle(el).animationName), "none");
        assert.ok(Number(await scan.evaluate(el => getComputedStyle(el).opacity)) > .99);
        await page.emulateMedia({ reducedMotion: "no-preference" });
      }
      await page.emulateMedia({ forcedColors: "active" });
      assert.notEqual(await page.locator(".opencraft-composer-recovery__scan").evaluate(el => getComputedStyle(el).stroke), "none");
      await page.emulateMedia({ forcedColors: "none" });
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `${width}-${family}-${mode}.png`) });
      await setState("cold-error");
      assert.equal(await page.getByRole("alert").count(),0);
      assert.equal(await page.locator('.conversation-recovery-details').count(),0);
      const retry = page.getByRole("button", { name: "Try again" });
      assert.equal(await retry.count(),0);
      assert.equal(await scan.getAttribute("data-active"), "false", "terminal failure stops scanning");
      if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `silent-cold-error-${width}-${family}-${mode}.png`) });
      await setState("cold-update-error");
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").innerText(), /Update or reload to reconnect/);
      assert.equal(await retry.count(), 0);
      assert.equal(await scan.getAttribute("data-active"), "false");
      await setState("ready");
      await page.locator(".thread-scroll").waitFor();
      await page.getByText("Prompt 19", { exact: true }).waitFor();
      assert.equal(await scan.getAttribute("data-active"), "false");
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
      await page.locator(".ProseMirror").fill("Keep my unsent input");
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
        (window as any).retainedDraft = document.querySelector(".ProseMirror");
        return { scroll: scroll.scrollTop, anchor: [...document.querySelectorAll("[data-turn-key]")].at(-1)!.getBoundingClientRect().top };
      });
      let loadingTint: number[] = [];
      for (const state of ["warm-loading", "warm-syncing", "warm-reconnecting", "warm-error", "warm-update-error", "ready"]) {
        await setState(state);
        if (state === "warm-update-error") await page.locator(".conversation-recovery-notice").waitFor();
        else await page.locator(".conversation-recovery-notice").waitFor({ state: "detached" });
        assert.equal(await scan.getAttribute("data-active"), state === "warm-loading" || state === "warm-syncing" || state === "warm-reconnecting" ? "true" : "false");
        await page.evaluate(async () => {
          for (let frame = 0; frame < 10; frame++) await new Promise(requestAnimationFrame);
        });
        assert.equal(await page.locator('.opencraft-composer-shell').getAttribute('data-warning'),
          state === 'warm-reconnecting' || state.endsWith('error') ? 'true' : null,
          'only actual reconnect/failure warns');
        assert.equal(await page.locator('.opencraft-composer-shell').getAttribute('data-loading'),
          state === 'warm-loading' || state === 'warm-syncing' ? 'true' : null,
          'loading is faint, warning takes precedence, ready clears all tint');
        const tint = await page.locator('.opencraft-composer-shell').evaluate(el => {
          const style = getComputedStyle(el, '::before');
          return { alphas: [...style.backgroundImage.matchAll(/color\(srgb[^)]*?\/\s*([\d.]+)\)/g)].map(m => Number(m[1])), shadow: style.boxShadow };
        });
        if (state === 'warm-loading') {
          loadingTint = tint.alphas.slice(0, 2);
          assert.equal(loadingTint.length, 2, 'loading paints a real tint gradient');
          assert.match(tint.shadow, /(?:rgba\(0, 0, 0, 0\)|color\(srgb[^)]*\/ 0\))/, 'loading outer glow stays transparent');
        }
        if (state === 'warm-reconnecting') {
          assert.equal(tint.alphas.length >= 2, true);
          assert.ok(loadingTint.every((alpha, i) => alpha > 0 && alpha < tint.alphas[i]),
            'loading gradient is visibly quieter than reconnect');
          if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `reconnecting-${width}-${family}-${mode}.png`) });
        }
        const retained = await page.evaluate(() => ({
          sameScroll: (window as any).retainedScroll === document.querySelector(".thread-scroll"),
          scroll: (document.querySelector(".thread-scroll")! as HTMLElement).scrollTop,
          sameDraft: (window as any).retainedDraft === document.querySelector(".ProseMirror"),
          draft: document.querySelector(".ProseMirror")!.textContent,
          anchor: [...document.querySelectorAll("[data-turn-key]")].at(-1)!.getBoundingClientRect().top,
        }));
        assert.equal(retained.sameScroll, true); assert.equal(retained.sameDraft, true);
        assert.ok(Math.abs(retained.anchor - original.anchor) <= 1, JSON.stringify({ state, original, ...retained }));
        if (state === "warm-loading" || state === "warm-syncing") assert.ok(Math.abs(retained.scroll - original.scroll) <= 1);
        assert.equal(retained.draft, "Keep my unsent input");
        assert.equal(await page.getByText("Prompt 19", { exact: true }).count(), 1);
        if (state === "warm-loading" || state === "warm-syncing") {
          assert.equal(await page.locator(".conversation-recovery-notice").count(), 0, "background recovery adds no floating chrome");
          if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `sync-${width}-${family}-${mode}.png`) });
        }
        if (state === "warm-update-error") {
          const geometry = await page.locator(".conversation-recovery-notice").evaluate(el => {
            const rect = el.getBoundingClientRect();
            const input = document.querySelector(".ProseMirror")!.getBoundingClientRect();
            return { position: getComputedStyle(el).position, background: getComputedStyle(el).backgroundColor, bottom: rect.bottom, inputTop: input.top };
          });
          assert.equal(geometry.position, "static");
          assert.notEqual(geometry.background, "rgba(0, 0, 0, 0)", "terminal action text cannot mix with scrolled history behind the sticky footer");
          assert.ok(geometry.bottom <= geometry.inputTop, "manual recovery stays above the draft in normal flow");
        }
        if (state === "warm-update-error") {
          const notice = page.locator(".conversation-recovery-notice");
          assert.match(await notice.innerText(), /Update or reload to reconnect/);
          assert.equal(await notice.getByRole("button", { name: "Try again" }).count(), 0);
          assert.equal(await notice.locator("details, pre, button").count(),0);
          const rect = await notice.boundingBox();
          assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= 800 && rect.x >= 0
            && rect.x + rect.width <= width, "update instruction must be inside the viewport");
          if (evidenceDir) await page.screenshot({ path: join(evidenceDir, `update-${width}-${family}-${mode}.png`) });
        }
      }
      assert.deepEqual(errors, []);
      results.push({ width, touch, family, mode, coldSlots: 2, warmHistoryPreserved: true, reducedMotion: true, silentErrors: true, updateInstruction: true });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: true, cases: results.length, externalWrites: false, results }, null, 2));
} finally { await browser?.close(); await vite.close(); }
