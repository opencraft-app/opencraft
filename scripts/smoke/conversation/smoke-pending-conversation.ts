import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_PENDING_EVIDENCE ?? ".local/pending-conversation";
await mkdir(output, { recursive: true });
const source = `
import React,{useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {PendingConversationPage} from '/apps/workbench-web/src/components/pending-conversation-page.tsx';
import {UserMessageBlock} from '/apps/workbench-web/src/components/conversation/user-message.tsx';
import {ConversationDocumentContext} from '/apps/workbench-web/src/components/conversation/document-context.ts';
import {createWebChatRenderRuntime,WebChatRenderRuntimeProvider} from '@opencraft/chat-render-web';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const render=await createWebChatRenderRuntime();
let set, retryCount=0, lastIntent=null;
const samples={text:'测试发送新的会话',code:'Code sample\\n\\n~~~ts\\nconst answer = 42;\\n~~~',long:Array(35).fill('长消息 Mixed text with a link https://example.com').join('\\n'),files:''};
const execution={hostId:'local',workspace:{cwd:null,runtimeWorkspaceRoots:[]}};
function App(){const [state,update]=useState({sample:'text',phase:'submitting',normal:false,theme:'light'});set=update;
 const text=samples[state.sample],files=state.sample==='files'?[{id:'a',name:'first.txt',mimeType:'text/plain',size:12,uri:'file:///fixture/first.txt',lifecycle:'ready',error:null},{id:'b',name:'second.pdf',mimeType:'application/pdf',size:12,uri:'file:///fixture/second.pdf',lifecycle:'ready',error:null}]:[];
 const intent={commandId:'command',clientMessageId:'message',target:{type:'new-thread',draftId:'draft',execution},document:{version:1,blocks:[{type:'paragraph',children:[{type:'text',text}]}]},attachments:files,context:[],selections:{},options:{autoContext:false},createdAt:100};
 lastIntent=intent;
 const draft={id:'draft',scopeId:'scope',entrypoint:'new-chat',target:intent.target,phase:state.phase,error:state.phase==='submit-failed'?new Error('Synthetic host rejection'):null,receipt:null,submission:intent,createdAt:100};
 const context={conversationId:null,cwd:null,hostId:'local',theme:state.theme};
 const normal={type:'user-message',id:'server-message',sourceItemIds:[],message:text,content:[],attachments:[],messageKind:'user',clientId:'message',sentAtMs:100,deliveryStatus:'sent',steeringStatus:null,referencesPriorConversation:false,reviewMode:false,pullRequestFixMode:false,autoResolveSync:false,goal:false,hookFeedback:false,commentCount:0,hasExternalAttachments:false};
 return <WebChatRenderRuntimeProvider runtime={render}><div className='app-shell-root main-content-viewport' style={{height:'100vh'}}>{state.normal?<main className='thread-scroll'><div className='thread-scroll-surface'><div className='thread-content thread-layout-width'><ConversationDocumentContext.Provider value={context}><UserMessageBlock block={normal}/></ConversationDocumentContext.Provider></div></div></main>:<PendingConversationPage conversation={draft} documentContext={context} onRetry={received=>{if(received!==lastIntent)throw new Error('retry changed immutable input');retryCount++;update({...state,phase:'submitting'})}}/>}</div></WebChatRenderRuntimeProvider>;
}
window.fixture={show:state=>{setThemePreference(state.theme);set(state)},retryCount:()=>retryCount};
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const server = await createServer({ root: process.cwd(), configFile: false, logLevel: "error",
  cacheDir: "node_modules/.vite-pending-conversation", resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic", target: "esnext" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "pending-fixture", resolveId: id => id === "/pending.tsx" ? id : null,
    load: id => id === "/pending.tsx" ? source : null,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next(); res.setHeader("Content-Type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/pending.tsx"></script>');
    }); } }] });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results: unknown[] = [];
try {
  await server.listen();
  for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    const errors: string[] = [], identityRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/enterprise-identity.*session|identity.*session/.test(request.url())) identityRequests.push(request.url()); });
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.locator('.pending-conversation-page[data-pending-conversation-phase="submitting"]').waitFor();
    const show = async (sample: string, phase = "submitting", normal = false) => {
      await page.evaluate(state => (window as any).fixture.show(state), { sample, theme, phase, normal });
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
      await page.waitForTimeout(100);
    };
    const metrics = () => page.locator('[data-user-message-bubble]').evaluate(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, background: style.backgroundColor,
        font: style.fontSize, lineHeight: style.lineHeight, padding: style.padding, radius: style.borderRadius };
    });
    for (const sample of ["text", "code", "long"]) {
      await show(sample);
      assert.equal(await page.getByRole("status").count(), 0, "pending submission has no redundant startup status");
      assert.equal(await page.getByText("Starting task…", { exact: true }).count(), 0);
      const pending = await metrics();
      assert.notEqual(pending.background, "rgba(0, 0, 0, 0)", "pending bubble has a visible surface");
      assert.ok(pending.x >= 0 && pending.x + pending.width <= width, "bubble stays inside viewport");
      if (sample === "code") assert.equal(await page.locator('pre').count() > 0, true, "code renders before server binding");
      if (sample === "long") assert.equal(await page.locator('[aria-expanded="false"]').count(), 1, "long input uses shared collapse");
      await page.screenshot({ path: `${output}/${width}-${theme}-${sample}.png` });
      await show(sample, "submitting", true);
      const normal = await metrics();
      for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(pending[key] - normal[key]) < 0.1, `pending/bound ${key} matches within subpixel rounding`);
      assert.deepEqual({ ...pending, x: 0, y: 0, width: 0, height: 0 }, { ...normal, x: 0, y: 0, width: 0, height: 0 }, "pending/bound typography and surface match");
      assert.ok(pending.y > 0, "shared viewport top inset applies");
      results.push({ width, theme, sample, pending, normal });
    }
    await show("files");
    assert.equal(await page.locator('[data-user-message-bubble]').count(), 0, "attachment-only has no fabricated text");
    assert.match(await page.locator('.pending-conversation-content').innerText(), /first.txt/);
    assert.match(await page.locator('.pending-conversation-content').innerText(), /second.pdf/);
    await show("text", "submit-failed");
    await page.getByRole("alert").waitFor();
    const failed = await metrics();
    await page.getByRole("button", { name: "Try again" }).click();
    await page.locator('.pending-conversation-page[data-pending-conversation-phase="submitting"]').waitFor();
    assert.equal(await page.evaluate(() => (window as any).fixture.retryCount()), 1);
    assert.deepEqual(await metrics(), failed, "retry preserves message geometry");
    await show("text", "promoting");
    assert.equal(await page.getByRole("status").count(), 0, "promoting has no redundant startup status");
    assert.equal(await page.locator('[contenteditable="true"]').count(), 0, "submitted draft has no second Composer");
    assert.deepEqual(identityRequests, [], "rendering never fetches identity");
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log("Pending/bound geometry parity: 12 scenarios; attachment-only, failed/retry, promoting, no identity fetch: 4 scenarios passed.");
} finally { await browser.close(); await server.close(); }
