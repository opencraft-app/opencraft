import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { AppHostServer } from "../../../packages/app-host-server/src/index";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { createWorkbenchWebServer as createStaticWorker } from "../../workbench-web-server.mjs";
import { createHeadlessBackendProxy } from "../../web-deployment/headless-backend.mjs";

// Full built Application: a Conversation-only fixture misses a parent hiding
// valid display data behind a network-backed lease. Both smoke and gate use it.
const root = resolve(process.env.OPENCRAFT_COLD_OPEN_WEB_ROOT ?? 'apps/workbench-web/dist');
const output = resolve(process.env.OPENCRAFT_COLD_OPEN_EVIDENCE ?? '.local/session-cold-open');
const samples = Number(process.env.OPENCRAFT_COLD_OPEN_SAMPLES ?? 1);
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100);
const timing = samples >= 10;
const durationOnly = process.env.OPENCRAFT_COLD_OPEN_DURATION_ONLY === '1';
const regroupPreview = process.env.OPENCRAFT_COLD_OPEN_REGROUPED_PREVIEW === '1';
const clockSelector = '.thread-agent-activity__turn-header, [data-work-status], [data-work-duration]';
const version = JSON.parse(await readFile(join(root, 'version.json'), 'utf8'));
assert.equal(version.headlessServer, true, 'Build the Headless Web profile');
await mkdir(output, { recursive: true });
const threadId='cold-open-fixture',question='Previously seen question',cachedAnswer='Previously seen answer',restoredAnswer='Fresh authoritative answer';
const thread={id:threadId,name:'Cold open fixture',preview:question,cwd:'/fixture',path:null,historyMode:'paginated',modelProvider:'openai',createdAt:1,updatedAt:1,status:{type:'idle'},source:'appServer',turns:[]};
let hold=false,fresh=false,active=false,previewStage=false,longActive=false;
const previewAnswer='Fresh preview answer';
const heldResume:Array<()=>void>=[];
const releaseResume=()=>{for(const deliver of heldResume.splice(0))deliver()};
let heldArrived: (() => void) | undefined;
const held:Array<()=>void>=[],requests:string[]=[],mutations:string[]=[];
const release=()=>{hold=false;for(const deliver of held.splice(0))deliver()};
const appHost=new AppHostServer({logicalClientRouting:true,createTransport(){
 let status:any={state:'idle'};
 const messages=new Set<(frame:string)=>void>(),statuses=new Set<(value:any)=>void>();
 return {get status(){return status},async connect(){status={state:'open'};for(const listener of statuses)listener(status)},
  subscribeMessage(listener){messages.add(listener);return()=>{messages.delete(listener)}},subscribeStatus(listener){statuses.add(listener);return()=>{statuses.delete(listener)}},
  async send(frame){
   const rpc=JSON.parse(frame);if(rpc.id===undefined)return;requests.push(rpc.method);
   let result:unknown,error:unknown;
   const turn={id:'fixture-turn',historyWindowId:'fixture-window',status:active?'inProgress':'completed',error:null,itemsView:'full',startedAt:1700000000,completedAt:active?null:1700000054,startedAtMs:1700000000000,firstTurnWorkItemStartedAtMs:1700000000000,finalAssistantStartedAtMs:active?null:1700000054000,durationMs:active?null:54000,completedAtMs:active?null:1700000054000,items:[
    {type:'userMessage',id:'fixture-question',sender:{kind:'employee',loginName:'fixture.employee'},sentAtMs:1700000000000,content:[{type:'text',text:question,textElements:[]}]},
    {type:'reasoning',id:'fixture-reasoning',summary:['Checking the answer'],content:[],startedAtMs:1700000000000},
    {type:'agentMessage',id:'fixture-answer',startedAtMs:1700000054000,text:fresh?restoredAnswer:cachedAnswer,phase:'final_answer'}]};
   if (durationOnly && !active) {
    delete (turn as any).firstTurnWorkItemStartedAtMs;
    delete (turn as any).finalAssistantStartedAtMs;
    for (const item of turn.items) {
      if (item.type === 'agentMessage') (item as any).sentAtMs = 1700000054000;
      delete (item as any).startedAtMs;
    }
   }
   if (active && longActive) turn.items.splice(1, 0, ...Array.from({ length: 68 }, (_, i) => ({
    type: 'reasoning', id: `long-reasoning-${i}`, summary: [`Long active reasoning ${i}`], content: [], startedAtMs: 1700000000000 + i,
   })));
   switch(rpc.method){
    case 'initialize':result={userAgent:'cold-open-fixture',codexHome:'/fixture',platformFamily:'unix',platformOs:'linux',capabilities:{extensions:{...(previewStage?{'opencraft/message-window-history':{version:1}}:{}),'opencraft/resume-history':{version:1,mode:previewStage?'message-window':'paginated',initialTurnsPage:true}}}};break;
    case 'thread/list':result={data:[{...thread,historyMode:previewStage?'message-window':'paginated'}],nextCursor:null};break;
    case 'thread/read':result={thread:{...thread,historyMode:previewStage?'message-window':'paginated'}};break;
    case 'thread/resume':result={thread:{...thread,historyMode:previewStage?'message-window':'paginated'},model:'fixture-model',modelProvider:'openai',cwd:'/fixture',runtimeWorkspaceRoots:['/fixture'],approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'},initialTurnsPage:{data:[turn],nextCursor:null}};break;
    case 'thread/turns/list':result={data:[turn],nextCursor:null};break;
    case 'thread/items/list':result={data:turn.items.map(item=>({turnId:turn.id,item})),nextCursor:null};break;
    case 'thread/loaded/list':result={data:[threadId]};break;
    case 'model/list':case 'permissionProfile/list':case 'thread/queue/list':result={data:[],nextCursor:null};break;
    case 'config/read':result={config:{},origins:{}};break;
    case 'skills/list':result={data:[]};break;
    default:
     if(/^(?:turn\/|thread\/(?:start|fork)|.*\/(?:set|write|create|delete)$)/.test(rpc.method))mutations.push(rpc.method);
     error={code:-32601,message:'Read-only fixture operation unavailable'};
   }
   const reply=JSON.stringify({id:rpc.id,...(error?{error}:{result}),__opencraftClient:rpc.__opencraftClient});
   const deliver=()=>{for(const listener of messages)listener(reply)};
   if(previewStage&&rpc.method==='thread/resume') {
    assert.equal(typeof rpc.params.historyPreviewToken,'string','Preview has a request-scoped owner');
    const {startedAt,completedAt,startedAtMs,firstTurnWorkItemStartedAtMs,finalAssistantStartedAtMs,completedAtMs,durationMs,...partial}=turn;
    const preview={...partial,...(regroupPreview?{id:'regrouped-window'}:{}),items:turn.items.map(item=>{
      const {startedAtMs,sentAtMs,sender,...message}=item as any;
      return message.type==='agentMessage'?{...message,text:previewAnswer}:message;
    })};
    for(const listener of messages) listener(JSON.stringify({method:'thread/history/preview',params:{threadId,token:rpc.params.historyPreviewToken,turns:[preview]},__opencraftClient:rpc.__opencraftClient}));
    heldResume.push(deliver); return;
   }
   if(hold&&rpc.method==='initialize') { held.push(deliver); heldArrived?.(); } else { await new Promise(resolve => setTimeout(resolve, 40)); deliver(); }
  },async close(){status={state:'closed'};for(const listener of statuses)listener(status)}};
}});

const backend = await createWorkbenchWebServer({ root, appHostServer: appHost, appServerTarget: null, loopbackOnly: true });
const backendAddress = await backend.listen({ host: '127.0.0.1', port: 0 });
const backendTarget = `http://127.0.0.1:${backendAddress.port}`;
// Serve the production compressed assets, proxying the isolated AppHost only.
const web = await createStaticWorker({ root, appServerTarget: null, headlessServer: true, headlessBackendTarget: backendTarget });
web.server.removeAllListeners('upgrade');
const proxy = createHeadlessBackendProxy(backendTarget)!;
web.server.on('upgrade', (request, socket, head) => proxy.upgrade(request, socket, head, () => {}, new Set()));
const address = await web.listen({ host: '127.0.0.1', port: 0 });
const url = `http://127.0.0.1:${address.port}/local/${threadId}?hostId=local-codex`;
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
const results: unknown[] = [], evidence: unknown[] = [];
let activePage: Page | undefined;

async function openPage(width: number, cpuRate: number, storageState?: Awaited<ReturnType<BrowserContext['storageState']>>) {
  const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width === 390, storageState });
  const page = await context.newPage(); activePage = page;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  // A new browser context has no HTTP cache. Only persisted display state can
  // be carried across navigation; time starts at navigation, before bootstrap.
  await page.addInitScript('window.__name = value => value');
  await page.addInitScript(({ cachedAnswer, restoredAnswer }) => {
    const metrics: { firstPaintMs?: number; firstUserDates?: number; firstAssistantDates?: number; firstWorkClock?: string | null; firstSender?: string | null; firstAvatarWidth?: number; firstRules?: number } = {};
    (window as any).coldOpenMetrics = metrics;
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      const frames = [...document.querySelectorAll('.thread-frame')];
      if (!frames.some(frame => frame.textContent?.includes(cachedAnswer) || frame.textContent?.includes(restoredAnswer))) return;
      scheduled = true;
      requestAnimationFrame(() => {
        metrics.firstPaintMs = performance.now();
        metrics.firstUserDates = document.querySelectorAll('.thread-user-message time').length;
        metrics.firstAssistantDates = document.querySelectorAll('[data-assistant-message-sent-time]').length;
        metrics.firstSender = document.querySelector('.thread-user-message__sender')?.textContent ?? null;
        metrics.firstAvatarWidth = document.querySelector('.thread-user-message__sender-avatar')?.getBoundingClientRect().width ?? 0;
        metrics.firstRules = document.querySelectorAll('.thread-agent-activity__turn-header .thread-work-status__rule').length;
        metrics.firstWorkClock = document.querySelector('.thread-agent-activity__turn-header, [data-work-status], [data-work-duration]')?.textContent ?? null;
      });
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }, { cachedAnswer, restoredAnswer });
  return { context, page, errors };
}
async function assertDateDisclosure(page: Page) {
  // Display data is present before connection. Touch clocks are readable at
  // rest; desktop clocks use the message's existing hover/focus disclosure.
  const editor = page.locator('[contenteditable="true"]').first();
  await page.mouse.move(0, 0);
  await editor.focus();
  const hoverCapable = await page.evaluate(() => matchMedia('(any-hover: hover) and (any-pointer: fine)').matches
    && !document.documentElement.hasAttribute('data-touch-interaction'));
  const touchInput = await page.evaluate(() => matchMedia('(any-pointer: coarse), (hover: none)').matches
    || document.documentElement.hasAttribute('data-touch-interaction'));
  for (const selector of ['.thread-user-message time', '[data-assistant-message-sent-time]']) {
    const date = page.locator(selector).first();
    await date.waitFor();
    const expectVisibility = async (visible: boolean) => {
      await page.waitForFunction(({ selector, visible }) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        let opacity = 1;
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          opacity *= Number(style.opacity);
        }
        const rect = element.getBoundingClientRect();
        return (visible ? opacity > 0.99 : opacity < 0.01)
          && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
      }, { selector, visible });
    };
    await expectVisibility(touchInput);
    const restingBounds = await date.boundingBox();
    const frame = date.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " thread-user-message ") or contains(concat(" ", normalize-space(@class), " "), " thread-frame--assistant ")][1]');
    await frame.locator('button').first().focus();
    await expectVisibility(true);
    assert.deepEqual(await date.boundingBox(), restingBounds, 'Focus reveals a clock without moving its slot');
    await editor.focus();
    await expectVisibility(touchInput);
    if (hoverCapable) {
      await frame.hover();
      await expectVisibility(true);
      assert.deepEqual(await date.boundingBox(), restingBounds, 'Hover reveals a clock without moving its slot');
      await page.mouse.move(0, 0);
      await expectVisibility(touchInput);
    }
  }
  assert.equal(await page.locator('[data-assistant-message-sent-time]').first().getAttribute('datetime'), '2023-11-14T22:14:14.000Z');
}
async function firstPaint(page: Page) {
  await page.waitForFunction(() => (window as any).coldOpenMetrics?.firstPaintMs !== undefined);
  const metrics = await page.evaluate(() => (window as any).coldOpenMetrics);
  assert.equal(metrics.firstUserDates, 1, 'User date exists at the first text paint, without waiting for it');
  assert.equal(metrics.firstAssistantDates, 1, 'Assistant date exists at the first text paint, without waiting for it');
  assert.match(metrics.firstWorkClock ?? '', /54/, 'Completed clock exists at the first text paint');
  const metadata = { sender: metrics.firstSender === 'fixture.employee', avatarSlot: metrics.firstAvatarWidth === 20, rule: metrics.firstRules === 1 };
  assert.deepEqual(metadata, { sender: true, avatarSlot: true, rule: true }, 'Sender, fixed avatar slot and rule exist with first body, before metadata waits');
  return { firstPaintMs: metrics.firstPaintMs as number, ...metadata };
}
async function waitForHeldInitialize() {
  if (held.length) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { heldArrived = undefined; reject(new Error('No held initialize request arrived')); }, 5000);
    heldArrived = () => { clearTimeout(timer); heldArrived = undefined; resolve(); };
  });
}
try {
  for (const { id, width, cpuRate } of [{ id: 'desktop', width: 1100, cpuRate: 1 }, { id: 'narrow', width: 390, cpuRate: 4 }]) {
    const coldSamples: unknown[] = [], cachedSamples: unknown[] = [];
    for (let n = 0; n < samples + (timing ? 1 : 0); n++) {
      releaseResume(); previewStage = false; release(); fresh = false;
      const cold = await openPage(width, cpuRate);
      await cold.page.goto(url, { waitUntil: 'domcontentloaded' });
      await cold.page.getByText(cachedAnswer, { exact: true }).waitFor();
      const coldMetric = await firstPaint(cold.page);
      await cold.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('opencraft.display.') && localStorage.getItem(key)?.includes('Previously seen answer')));
      await cold.page.locator(clockSelector).first().filter({hasText:'54'}).waitFor();
      assert.equal(await cold.page.locator('.thread-user-message time').getAttribute('datetime'), '2023-11-14T22:13:20.000Z');
      const state = await cold.context.storageState();
      assert.deepEqual(cold.errors, []);
      await cold.context.close();
      // New context: cold resources, with an actually persisted display cache.
      hold = true; fresh = true; previewStage = true;
      const cached = await openPage(width, cpuRate, state);
      const requestStart = requests.length;
      await cached.page.goto(url, { waitUntil: 'domcontentloaded' });
      await cached.page.getByText(cachedAnswer, { exact: true }).waitFor({ timeout: 5000 });
      const cachedMetric = await firstPaint(cached.page);
      await waitForHeldInitialize();
      assert.equal(await cached.page.locator('.thread-user-message time').getAttribute('datetime'), '2023-11-14T22:13:20.000Z', 'Date paints before initialization completes');
      assert.match(await cached.page.locator(clockSelector).first().innerText(), /54/, 'Completed clock paints with cached text');
      await assertDateDisclosure(cached.page);
      assert.equal(await cached.page.locator('.thread-agent-activity button').count(), 0, 'No expandable tool bodies restored from display cache');
      assert.equal(requests.slice(requestStart).includes('thread/resume'), false, 'Cached paint cannot resume or authorize execution');
      assert.equal(await cached.page.locator('.conversation-recovery-cold-stage').count(), 0);
      const editor = cached.page.locator('[contenteditable="true"]').first();
      await editor.fill('Keep this unsent draft');
      if (n === (timing ? 1 : 0)) await cached.page.screenshot({ path: join(output, `cached-before-connect-${width}.png`) });
      await cached.page.evaluate(() => {
        (window as any).missingPreviewClocks = [];
        const watch = () => {
          if (document.querySelector('.thread-frame')) {
            if (!document.querySelector('.thread-user-message time') || !document.querySelector('[data-assistant-message-sent-time]')
              || document.querySelector('.thread-user-message__sender')?.textContent !== 'fixture.employee'
              || !document.querySelector('.thread-agent-activity__turn-header .thread-work-status__rule')
              || !document.querySelector('.thread-agent-activity__turn-header, [data-work-status], [data-work-duration]')?.textContent?.includes('54')) (window as any).missingPreviewClocks.push(performance.now());
          }
          (window as any).clockWatch = requestAnimationFrame(watch);
        };
        watch();
      });
      release();
      if (regroupPreview) {
        const deadline = Date.now() + 10_000;
        while (!heldResume.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(heldResume.length, 'Regrouped preview was delivered before the final Resume');
        await cached.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await cached.page.getByText(cachedAnswer, { exact: true }).count(), 1, 'Cached text keeps its dates while regrouped preview is provisional');
        assert.equal(await cached.page.getByText(previewAnswer, { exact: true }).count(), 0);
      } else await cached.page.getByText(previewAnswer, { exact: true }).waitFor();
      assert.ok(heldResume.length > 0, 'Final Resume is still held after preview');
      await assertDateDisclosure(cached.page);
      assert.match(await cached.page.locator(clockSelector).first().innerText(), /54/, 'Preview keeps the already known completed clock');
      if (n === (timing ? 1 : 0)) await cached.page.screenshot({ path: join(output, `preview-before-resume-${width}.png`) });
      releaseResume(); previewStage = false;
      await cached.page.getByText(restoredAnswer, { exact: true }).waitFor();
      assert.equal(await editor.innerText(), 'Keep this unsent draft', 'Canonical restoration preserves the unsent draft');
      assert.equal(await cached.page.getByText(cachedAnswer, { exact: true }).count(), 0, 'Canonical history replaces old display');
      assert.deepEqual(await cached.page.evaluate(() => { cancelAnimationFrame((window as any).clockWatch); return (window as any).missingPreviewClocks; }), [], 'Every paint through preview and authority retains clocks, sender and rule');
      assert.deepEqual(cached.errors, []);
      await cached.context.close();
      if (!timing || n > 0) { coldSamples.push(coldMetric); cachedSamples.push(cachedMetric); }
    }
    // Persist the currently streaming Turn, then reopen before initialization.
    release(); active = true; fresh = false;
    const running = await openPage(width, cpuRate);
    await running.page.goto(url, { waitUntil: 'domcontentloaded' });
    await running.page.getByText(cachedAnswer, { exact: true }).waitFor();
    await running.page.waitForFunction(() => Object.keys(localStorage).some(key => {
      if (!key.startsWith('opencraft.display.')) return false;
      const saved = JSON.parse(localStorage.getItem(key)!);
      return saved.messages?.some((message: any) => message.kind === 'reasoning')
        && saved.messages?.some((message: any) => message.text === 'Previously seen answer' && message.completed === false);
    }));
    const runningState = await running.context.storageState();
    assert.deepEqual(running.errors, []); await running.context.close();
    hold = true; active = false; fresh = true;
    const resumed = await openPage(width, cpuRate, runningState);
    const runningRequestStart = requests.length;
    await resumed.page.goto(url, { waitUntil: 'domcontentloaded' });
    await resumed.page.getByText(cachedAnswer, { exact: true }).waitFor({ timeout: 5000 });
    await waitForHeldInitialize();
    await resumed.page.getByText(question, { exact: true }).waitFor();
    await resumed.page.locator('.thread-agent-activity__turn-toggle').first().click();
    await resumed.page.getByText('Checking the answer', { exact: true }).first().waitFor();
    assert.equal(await resumed.page.locator('.thread-user-message time').getAttribute('datetime'), '2023-11-14T22:13:20.000Z');
    assert.equal(await resumed.page.locator('[data-work-status="working"]').count(), 0, 'Painted progress cannot restart the live clock');
    assert.match(await resumed.page.locator('[data-work-status="worked"]').innerText(), /54/, 'Ended work paints with the cached partial reply');
    assert.equal(requests.slice(runningRequestStart).includes('thread/resume'), false);
    await assertDateDisclosure(resumed.page);
    const activeEditor = resumed.page.locator('[contenteditable="true"]').first();
    await activeEditor.fill('Draft while reconnecting');
    await resumed.page.screenshot({ path: join(output, `active-before-connect-${width}.png`) });
    release(); await resumed.page.getByText(restoredAnswer, { exact: true }).waitFor();
    assert.equal(await resumed.page.getByText(cachedAnswer, { exact: true }).count(), 0);
    assert.equal(await activeEditor.innerText(), 'Draft while reconnecting');
    assert.deepEqual(resumed.errors, []); await resumed.context.close();
    // A fresh profile has no retained history; routine connection loading stays
    // neutral and must still preserve input before the authoritative baseline.
    hold = true;
    // Long active histories used to evict the dated input from the 24-block tail.
    release(); longActive = true; active = true; fresh = false; previewStage = false;
    const longRun = await openPage(width, cpuRate);
    await longRun.page.goto(url, { waitUntil: 'domcontentloaded' });
    await longRun.page.getByText(cachedAnswer, { exact: true }).waitFor();
    await longRun.page.waitForFunction(() => Object.keys(localStorage).some(key => {
      if (!key.startsWith('opencraft.display.')) return false;
      const value = JSON.parse(localStorage.getItem(key)!);
      return value.messages?.some((message: any) => message.id === 'user-message:fixture-question')
        && value.messages?.some((message: any) => message.id === 'reasoning:long-reasoning-67');
    }));
    const longState = await longRun.context.storageState();
    await longRun.context.close(); hold = true;
    const longReload = await openPage(width, cpuRate, longState);
    await longReload.page.goto(url, { waitUntil: 'domcontentloaded' });
    await longReload.page.getByText(question, { exact: true }).waitFor({ timeout: 5000 });
    await longReload.page.getByText(cachedAnswer, { exact: true }).waitFor();
    await waitForHeldInitialize();
    assert.equal(await longReload.page.locator('.thread-user-message time').getAttribute('datetime'), '2023-11-14T22:13:20.000Z');
    await assertDateDisclosure(longReload.page);
    assert.equal(await longReload.page.locator('[data-work-status="working"]').count(), 0, 'Long activity never resumes a live clock');
    assert.match(await longReload.page.locator('[data-work-status="worked"]').innerText(), /54/, 'Observed ended work is static while reply text arrives');
    assert.deepEqual(longReload.errors, []);
    await longReload.context.close(); longActive = false; active = false; fresh = true;
    const isolated = await openPage(width, cpuRate);
    await isolated.page.goto(url, { waitUntil: 'domcontentloaded' });
    await isolated.page.locator('.local-conversation-page').waitFor();
    await waitForHeldInitialize();
    assert.equal(await isolated.page.getByText(cachedAnswer, { exact: true }).count(), 0);
    assert.equal(await isolated.page.getByText(restoredAnswer, { exact: true }).count(), 0);
    assert.equal(await isolated.page.locator('.conversation-recovery-cold-stage').count(), 0);
    const isolatedEditor = isolated.page.locator('[contenteditable="true"]').first();
    await isolatedEditor.fill('Draft before initial connection');
    release(); await isolated.page.getByText(restoredAnswer, { exact: true }).waitFor();
    assert.equal(await isolatedEditor.innerText(), 'Draft before initial connection');
    assert.deepEqual(isolated.errors, []); await isolated.context.close();
    results.push({ width, cpuRate, cacheBeforeConnection: true, baselineStillRequired: true, canonicalReplacement: true, draftPreserved: true, isolatedProfile: true, activeTurnBeforeConnection: true, previewTimingContinuous: true });
    evidence.push({ id: `session-navigation-cold-${id}`, samples: coldSamples }, { id: `session-navigation-cached-${id}`, samples: cachedSamples });
  }
  assert.deepEqual(mutations, []);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ workloadVersion: 5, durationOnly, regroupPreview, browser: browser.version(), build: version, results, mutations, evidence,
    boundary: 'Built Application and compressed static worker, isolated identity/protocol. Navigation through first history DOM plus next animation frame. Cached context retains display storage only; initialize remains held until cache is visible; a timestamp-free message-window preview then precedes a separately held final Resume. Synthetic fixture excludes real network/login/model and is not a population p95.' }, null, 2));
  console.log(JSON.stringify({ success: true, results }));
} catch (error) {
  await activePage?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally { releaseResume(); release(); await browser.close(); await web.close(); await backend.close(); await appHost.close(); }
