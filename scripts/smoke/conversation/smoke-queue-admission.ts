import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Real Conversation Runtime, queue projection and Composer; only the command
// boundary is held to exercise delayed RPC acknowledgement and queue snapshots.
const source = `
import React, {useSyncExternalStore} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createConversationKey} from '@opencraft/chat-core';
import {createComposerController} from '@opencraft/composer-core';
import {createReplicaConversationRuntime} from '@opencraft/chat-runtime';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {queuedSubmissionPresentation} from '/apps/workbench-web/src/queued-submission-presentation.ts';
import * as themes from '@opencraft/design-system/theme-engine';
import '/apps/workbench-web/src/styles/app.scss';
const mode = new URLSearchParams(location.search).get('mode') ?? 'light';
document.documentElement.dataset.theme=mode;
for(const [key,value] of Object.entries(themes.buildOpenCraftThemeCssProperties(mode,themes.opencraftNeutralThemePalette[mode]))) document.documentElement.style.setProperty(key,value);
const key=createConversationKey('queue-fixture','one');
const replica={revision:1,phase:'live',authoritative:true,entities:new Map([['one',{thread:{id:'one',status:{type:'active'}},turns:[]}]])};
let accept, intent;
const runtime=createReplicaConversationRuntime({key,replica:{getSnapshot:()=>replica,subscribe:()=>()=>{}},
 getSubmissionSender:()=>({kind:'employee',loginName:'queue.author'}),
 commands:{submit:input=>{intent=input;return new Promise(resolve=>accept=resolve)}},history:{loadOlder:async()=>{}}});
const controller=createComposerController({type:'existing-thread',key},{now:Date.now,createId:()=>crypto.randomUUID()});
const frames=[];
let sampling=false;
function sample(){if(!sampling)return;frames.push({at:performance.now(),rows:document.querySelectorAll('.opencraft-composer-queue-item').length});requestAnimationFrame(sample)}
window.fixture={runtime,controller,frames, start(){sampling=true;requestAnimationFrame(sample)},stop(){sampling=false},
 authoritative(){runtime.replaceQueuedSubmissions([{id:'server-queue',clientUserMessageId:intent.clientMessageId,input:[{type:'text',text:'Next queued message',text_elements:[]}],createdAt:101,pausedReason:null}])},
 consume(){runtime.replaceQueuedSubmissions([])},
 accept(){accept({commandId:intent.commandId,clientMessageId:intent.clientMessageId,hostId:key.hostId,threadId:key.threadId,turnId:null,acceptedAt:102,replayed:false})}};
function Fixture(){const snapshot=useSyncExternalStore(runtime.subscribe,runtime.getSnapshot);return <main style={{maxWidth:760,margin:'80px auto',padding:12}}><OpenCraftComposer controller={controller} isStreaming awaitSubmission placeholder='Write a message'
 queuedSubmissions={snapshot.queuedSubmissions.map(s=>queuedSubmissionPresentation(s,true))}
 onSubmit={input=>{window.fixture.start();void runtime.submit({...input,target:{type:'enqueue-follow-up',key}}).catch(()=>{});return true}} onCancel={()=>{}}/></main>}
createIntlTestRoot(document.getElementById('root')).render(<Fixture/>);
`;
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), logLevel: "error",
  optimizeDeps: { entries: [] },
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "queue-admission", resolveId: id => id === "/queue-admission.tsx" ? id : null,
    load: id => id === "/queue-admission.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/queue-admission.tsx"></script>');
    }); } }],
});
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const output = process.env.OPENCRAFT_SMOKE_OUTPUT;
if (output) await mkdir(output, { recursive: true });
let browser;
const results = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const touch of [false, true]) for (const mode of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1280, height: 700 }, hasTouch: touch });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`${vite.resolvedUrls!.local[0]}?mode=${mode}`);
    const editor = page.locator(".opencraft-composer-editor[contenteditable=true]");
    await editor.fill("Next queued message");
    if (touch) await page.getByRole("button", { name: "Queue follow-up", exact: true }).tap();
    else await editor.press("Enter");
    await page.locator(".opencraft-composer-queue-item").waitFor();
    assert.equal((await editor.innerText()).trim(), "", "draft is consumed without waiting for RPC");
    await page.evaluate(() => {
      const row = document.querySelector(".opencraft-composer-queue-item")!;
      (window as any).originalRow = row;
      (window as any).originalAvatar = row.querySelector(".opencraft-composer-queue-item__avatar");
    });
    await page.waitForTimeout(1100);
    await page.evaluate(() => (window as any).fixture.authoritative());
    await page.waitForFunction(() => document.querySelector('.opencraft-composer-queue-item [aria-label="Delete queued message"]:not(:disabled)'));
    assert.equal(await page.evaluate(() => document.querySelector(".opencraft-composer-queue-item") === (window as any).originalRow), true, "server admission retains the same row DOM");
    assert.equal(await page.evaluate(() => document.querySelector(".opencraft-composer-queue-item__avatar") === (window as any).originalAvatar), true, "avatar is not remounted at admission");
    const frames = await page.evaluate(() => { (window as any).fixture.stop(); return (window as any).fixture.frames; });
    const first = frames.findIndex((f: any) => f.rows === 1);
    assert(first >= 0 && first <= 1, "pending queue paints in the first available frame");
    assert(frames.slice(first).every((f: any) => f.rows === 1), "queue stays visible during delayed admission");
    if (output) await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${mode}.png` });
    await page.evaluate(() => (window as any).fixture.consume());
    await page.waitForFunction(() => !document.querySelector(".opencraft-composer-queue-item"));
    await page.evaluate(() => (window as any).fixture.accept());
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".opencraft-composer-queue-item").count(), 0, "late ACK cannot resurrect a consumed entry");
    assert.deepEqual(errors, []);
    results.push({ touch, mode, frames: frames.length, firstVisibleFrame: first, continuous: true, sameRow: true, sameAvatar: true, lateAck: "retired" });
    await page.close();
  }
  if (output) await writeFile(`${output}/browser.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser?.close(); await vite.close(); }
