import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, build, preview, loadConfigFromFile } from "vite";
import path from "node:path";

if (process.env.OPENCRAFT_MCP_APP_PRODUCTION === "1") process.env.NODE_ENV = "production";
const output = process.env.OPENCRAFT_MCP_APP_OUTPUT ?? "/tmp/opencraft-mcp-app-host";
const legacy = `<!doctype html><style>body{font:16px system-ui;margin:16px;background:#f7f8fa;color:#171717}button{padding:12px;margin:6px}</style><h2>Counter App</h2><output id="result">Loading</output><button id="increment">Increment</button><button id="message">Send followup</button><button id="context">Update context</button><button id="state">Save state</button><div id="theme"></div><div id="isolation"></div><script>
window.boots=(window.boots||0)+1;
try{parent.document.body;isolation.textContent='unsafe'}catch{isolation.textContent='isolated'}
async function increment(){try{const result=await openai.callTool('increment',{amount:2});document.querySelector('#result').textContent=JSON.stringify(result.structuredContent)}catch(error){document.querySelector('#result').textContent=error.message}}
document.querySelector('#increment').onclick=increment;
document.querySelector('#message').onclick=()=>openai.sendFollowUpMessage({prompt:'Use this result'});
document.querySelector('#context').onclick=()=>openai.updateModelContext({structuredContent:{count:7}});
document.querySelector('#state').onclick=()=>openai.setWidgetState({selected:9});
const theme=()=>document.querySelector('#theme').textContent=openai.theme+' state='+JSON.stringify(openai.widgetState);
window.addEventListener('openai:set_globals',theme);theme();increment();
</script>`;
const standard = `<style>body{font:16px system-ui;padding:12px}</style><h2>Standard MCP App</h2><output id="result">Loading</output><div id="events"></div><div id="theme"></div><script>
let seq=0;const pending=new Map();window.hostContexts=[];
function request(method,params){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}
window.addEventListener('message',event=>{if(event.source!==parent)return;const d=event.data;if(d.id&&pending.has(d.id)){const p=pending.get(d.id);pending.delete(d.id);d.error?p.reject(Error(d.error.message)):p.resolve(d.result)}
if(d.method==='ui/notifications/tool-input'||d.method==='ui/notifications/tool-result')document.querySelector('#events').textContent+=d.method+';';
if(d.method==='ui/notifications/host-context-changed'){window.hostContexts.push(d.params);window.hostContext={...window.hostContext,...d.params};document.querySelector('#theme').textContent=d.params.theme;}
});
(async()=>{const init=await request('ui/initialize',{appInfo:{name:'Counter',version:'1'},appCapabilities:{},protocolVersion:'2026-01-26'});window.hostContext=init.hostContext;document.querySelector('#theme').textContent=init.hostContext.theme;parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');const result=await request('tools/call',{name:'increment',arguments:{amount:3}});document.querySelector('#result').textContent=JSON.stringify(result.structuredContent)})()
</script>`;
const reference = process.env.OPENCRAFT_MCP_APP_HYPERNODE_REFERENCE;
const hypernode = reference ? (await readFile(reference, "utf8")).match(/export const MCP_APP_BUILDER_HTML = String.raw`([\s\S]*?)`;\n/)?.[1] : null;
if (reference && !hypernode) throw new Error("Hypernode builder HTML was not found");
const sdkPath = process.env.OPENCRAFT_MCP_APP_SDK_PATH;
const sdkBundle = sdkPath ? await readFile(sdkPath, "utf8") : null;
const sdkHtml = `<h2>Official MCP Apps SDK</h2><output id="result">Loading</output><div id="events"></div><div id="sdk-theme"></div><script type="module">
import{App}from"__SDK_ORIGIN__/mcp-app-sdk.js";
const app=new App({name:"Official SDK probe",version:"1"},{});
app.ontoolresult=result=>document.querySelector('#events').textContent=JSON.stringify(result);
app.onhostcontextchanged=context=>document.querySelector('#sdk-theme').textContent=context.theme;
await app.connect();
const result=await app.callServerTool({name:'increment',arguments:{amount:4}});
await app.updateModelContext({structuredContent:{sdk:true}});
await app.sendMessage({role:'user',content:[{type:'text',text:'From official SDK'}]});
document.querySelector('#result').textContent=JSON.stringify(result.structuredContent);
</script>`;
const source = `
import React,{useMemo,useState}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{Conversation}from'/apps/workbench-web/src/components/conversation.tsx';
import{Context}from'@deepseek-ai/cordis';
import{TimelineBlockRendererProvider,TimelineBlockRendererRegistryService}from'@opencraft/timeline-render-react';
import{BuiltinTimelineRendererPlugin}from'/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import{createConversationKey,createDefaultTimelineProjectorRegistry,projectTimeline}from'@opencraft/chat-core';
import{initializeAppearanceTheme}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const ctx=new Context();await ctx.plugin(TimelineBlockRendererRegistryService);await ctx.plugin(BuiltinTimelineRendererPlugin);
const projectors=createDefaultTimelineProjectorRegistry();
import{createMcpAppOwner}from'/apps/workbench-web/src/mcp-apps/owner.ts';
import{ConversationDocumentContext}from'/apps/workbench-web/src/components/conversation/document-context.ts';
const fixture=window.fixture={generation:1,mode:'legacy',historyReads:0,historyReady:false,reads:[],calls:[],messages:[],hold:false,release:null};
const html={legacy:${JSON.stringify(legacy)},standard:${JSON.stringify(standard)},hypernode:${JSON.stringify(hypernode)},sdk:${JSON.stringify(sdkHtml)}};
function App(){const[widgetStates]=useState(()=>new Map());const[fallback,setFallback]=useState(false);const[available,setAvailable]=useState(false);const[resourceUri,setResourceUri]=useState('ui://counter/app.html');const[displayName,setDisplayName]=useState('Counter');const[mode,setMode]=useState('legacy'),[generation,setGeneration]=useState(1),[theme,setTheme]=useState('light'),[show,setShow]=useState(true);
const port=useMemo(()=>createMcpAppOwner({key:'host:thread:'+generation,threadId:'thread',widgetStateStore:{scope:'host:thread',entries:widgetStates},assertCurrent:()=>{if(fixture.generation!==generation)throw Error('stale owner')},request:async(method,params)=>{
if(method==='thread/read'){fixture.historyReads++;if(fixture.historyReads===1)throw Error('Temporary history read failure');fixture.historyReady=true;return {}}
if(method==='mcpServer/resource/read'){fixture.reads.push(params);if(params.uri==='ui://opencraft/apps/recovered'&&!fixture.historyReady)throw Error('Canonical App reference not loaded');if(fixture.holdResource)await new Promise(resolve=>{fixture.releaseResource=resolve});return{contents:[{uri:params.uri,mimeType:'text/html;profile=mcp-app',text:html[mode].replaceAll('__SDK_ORIGIN__',location.origin),_meta:mode==='sdk'?{ui:{csp:{resourceDomains:[location.origin]}}}:undefined}]}}
if(method==='mcpServerStatus/list')return{data:[{name:'counter',tools:Object.fromEntries(['increment','appBuilder.list','appBuilder.saveDraft','appBuilder.publish','appBuilder.read'].map(name=>[name,{name,inputSchema:{type:'object'}}]))},{name:'opencraft-app-recovered-r1',tools:{increment:{name:'increment',inputSchema:{type:'object'}}}}],nextCursor:null};
if(method==='mcpServer/tool/call'){fixture.calls.push(params);if(params.tool==='appBuilder.list')return{content:[],structuredContent:{apps:[]}};if(params.tool==='appBuilder.saveDraft')return{content:[],structuredContent:{appId:params.arguments.spec.appId}};if(fixture.hold)await new Promise(resolve=>{fixture.release=resolve});return{content:[],structuredContent:{count:params.arguments.amount},_meta:{private:'for UI'}}}throw Error(method)
},sendMessage:async text=>{fixture.messages.push(text)},openLink:url=>fixture.messages.push(url)}),[mode,generation]);
const surfacePort=useMemo(()=>fallback?{...port,widgetState:undefined}:port,[port,fallback]);
Object.assign(fixture,{setFallback,setAvailable,setTheme,setResourceUri,setDisplayName,switchMode:value=>{fixture.mode=value;setMode(value)},revoke:()=>{fixture.generation++;setGeneration(fixture.generation)},hide:value=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:value?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'))},unmount:()=>setShow(false),mount:()=>setShow(true),port});
const timeline=useMemo(()=>projectTimeline({key:createConversationKey('host','thread'),revision:1,authoritative:true,phase:'live',turns:[{id:'turn',status:'complete',items:[{id:'question',type:'userMessage',payload:{content:[{type:'text',text:'Show a counter'}]}},{id:'call1',type:'mcpToolCall',payload:{server:resourceUri==='ui://opencraft/apps/recovered'?'opencraft-app-recovered-r1':'counter',tool:'Counter',status:'completed',mcpAppResourceUri:resourceUri,appContext:{appName:displayName},arguments:{count:0},result:{content:[],structuredContent:{count:0},_meta:{private:'initial'}}}},{id:'ordinary',type:'mcpToolCall',payload:{server:'counter',tool:'plain_tool',status:'completed',result:{content:[{type:'text',text:'Plain MCP output'}]}}},{id:'answer',type:'agentMessage',payload:{text:'Use the app above.',phase:'final_answer'}}]}]},projectors),[mode,resourceUri,displayName]);
return <><input aria-label='Draft' defaultValue='Keep my draft'/>{show?<div style={{height:'80vh'}}><TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><Conversation key={mode} timeline={timeline} scrollPolicy='natural' documentContext={{conversationId:'thread',cwd:null,hostId:'host',theme,mcpApps:available?surfacePort:undefined}}/></TimelineBlockRendererProvider></div>:null}<div style={{height:2000}}/></>}

createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const vite = await createServer({ configFile: "apps/workbench-web/vite.config.ts", root: process.cwd(), logLevel: "error",
  cacheDir: "node_modules/.vite-mcp-app-host", resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: ["/mcp-app-fixture.tsx"], include: ["react", "react-dom/client", "react/jsx-runtime"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "mcp-app-fixture", resolveId: id => id === "/mcp-app-fixture.tsx" ? id : null,
    load: id => id === "/mcp-app-fixture.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req,res,next) => {
      if (req.url === "/mcp-app-sdk.js" && sdkBundle) { res.setHeader("content-type","text/javascript"); res.setHeader("access-control-allow-origin","*"); res.end(sdkBundle); return; }
      if (req.url !== "/mcp-app-fixture") return next(); res.setHeader("content-type","text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/mcp-app-fixture.tsx"></script>');
    }); } }],
});
let browser: any;
let productionServer: Awaited<ReturnType<typeof preview>> | undefined;
const results: unknown[] = [];
try {
  await mkdir(output,{recursive:true}); await vite.listen();
  let base = vite.resolvedUrls!.local[0];
  if (process.env.OPENCRAFT_MCP_APP_PRODUCTION === "1") {
    const entry = path.resolve(".local/mcp-app-host-build/index.html");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/mcp-app-fixture.tsx"></script>');
    const outDir = path.resolve(output, "production");
    const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, "apps/workbench-web/vite.config.ts");
    if (!loaded) throw new Error("Production renderer config was not loaded");
    // Keep production React resolution, browser targets and compatibility checks.
    // Product entry packaging/startup budgets apply to build:web, not this single-entry fixture.
    const fixturePlugins = (loaded.config.plugins ?? []).filter(plugin => !["opencraft-startup-resources", "opencraft-embedded-workbench-dev-entry"].includes((plugin as { name?: string } | null)?.name ?? ""));
    await build({ ...loaded.config, configFile: false, root: process.cwd(), logLevel: "error", base: "/",
      plugins: [...fixturePlugins, { name: "mcp-app-build-fixture", resolveId: id => id === "/mcp-app-fixture.tsx" ? id : null, load: id => id === "/mcp-app-fixture.tsx" ? source : null }],
      build: { ...loaded.config.build, outDir, emptyOutDir: true, rolldownOptions: { ...loaded.config.build?.rolldownOptions, input: entry } } });
    await writeFile(path.join(outDir,"index.html"), await readFile(path.join(outDir,".local/mcp-app-host-build/index.html")));
    if (sdkBundle) await writeFile(path.join(outDir,"mcp-app-sdk.js"),sdkBundle);
    productionServer = await preview({ configFile: false, root: process.cwd(), build: { outDir }, preview: { host: "127.0.0.1", port: 0, cors: true } });
    base = productionServer.resolvedUrls.local[0];
  }
  const { chromium } = await import("playwright");
  browser = await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
  for (const width of [390,1280]) {
    const context = await browser.newContext({viewport:{width,height:844},hasTouch:width===390});
    await context.addInitScript(() => Object.defineProperty(Crypto.prototype, "randomUUID", { configurable: true, value: undefined }));
    const page = await context.newPage(); const errors: string[] = []; const protocolErrors: string[] = [];
    page.on("console",message=>{if(message.type()==="error"&&message.text().includes("Failed to parse message"))protocolErrors.push(message.text())});
    page.on("pageerror",(error:any)=>{errors.push(String(error));console.error("[browser]",String(error))});
    await page.goto(base+(productionServer?"index.html":"mcp-app-fixture"));
    const app=page.frameLocator("iframe");
    await page.waitForFunction(()=>window.fixture?.setAvailable);
    assert.equal(await page.locator("iframe").count(),0);
    await page.evaluate(()=>window.fixture.setAvailable(true));
    await app.locator("#result").filter({hasText:'"count":2'}).waitFor();
    assert.equal(await app.locator("#isolation").textContent(),"isolated");
    const appFrame = await page.locator("iframe").elementHandle();
    await app.locator("body").evaluate(element => {
      const input = document.createElement("input");
      input.id = "disclosure-draft";
      element.append(input);
    });
    await app.locator("#disclosure-draft").fill("Keep this App input");
    const details = page.locator(".thread-agent-activity__turn-toggle > button");
    for (let toggle = 0; toggle < 4; toggle++) {
      await details.click();
      assert.equal(await page.locator("iframe").count(), 1, "expanded details must not duplicate the App");
      assert.equal(await appFrame!.evaluate(element => element.isConnected), true, "detail toggles retain the original iframe");
      assert.equal(await app.locator("#disclosure-draft").inputValue(), "Keep this App input");
    }
    await app.locator("#disclosure-draft").evaluate(element => element.remove());
    // Let the scheduled iframe measurement reach the parent before sampling.
    await app.locator("body").evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const initialHeight = await page.locator("iframe").evaluate(element=>element.getBoundingClientRect().height);
    await app.locator("body").evaluate(element=>{const extra=document.createElement("div");extra.id="size-probe";extra.style.height="500px";element.append(extra)});
    await page.waitForFunction(height=>document.querySelector("iframe").getBoundingClientRect().height>height+400,initialHeight);
    await app.locator("#size-probe").evaluate(element=>element.remove());
    await page.waitForFunction(height=>Math.abs(document.querySelector("iframe").getBoundingClientRect().height-height)<4,initialHeight);
    await app.locator("body").evaluate(element=>{element.style.minHeight='100vh'});
    await page.waitForTimeout(250);
    const viewportHeight = await page.locator("iframe").evaluate(element=>element.clientHeight);
    await page.waitForTimeout(500);
    assert.equal(await page.locator("iframe").evaluate(element=>element.clientHeight),viewportHeight,"100vh plus margins must settle instead of feeding viewport growth back into auto-height");
    assert.ok(viewportHeight < initialHeight + 100,"auto-height must not grow to its safety cap");
    await app.locator('body').evaluate(element=>{element.style.color='rgb(20, 20, 20)'});
    await page.waitForTimeout(150);
    assert.equal(await page.locator('iframe').evaluate(element=>element.clientHeight),viewportHeight,'a paint-only DOM change must not restart the height feedback');
    await app.locator("body").evaluate(element=>{const extra=document.createElement('div');extra.id='size-probe';extra.style.height='500px';element.append(extra)});
    await page.waitForFunction(height=>document.querySelector('iframe').clientHeight>height+400,viewportHeight);
    await app.locator("body").evaluate(element=>{element.style.minHeight='';element.querySelector('#size-probe')!.remove()});
    await page.waitForFunction(height=>Math.abs(document.querySelector('iframe').clientHeight-height)<4,initialHeight);
    assert.equal(await page.locator("iframe").getAttribute("sandbox"),"allow-scripts allow-forms");
    assert.equal(await app.locator("#theme").textContent(),"light state=null");
    const before=await page.evaluate(()=>window.fixture.calls.length);
    await page.evaluate(()=>window.postMessage({jsonrpc:"2.0",id:10,method:"tools/call",params:{name:"increment",arguments:{amount:99}}},"*"));
    await page.waitForTimeout(50); assert.equal(await page.evaluate(()=>window.fixture.calls.length),before);
    await page.evaluate(()=>window.fixture.setTheme("dark"));
    await app.locator("#theme").filter({hasText:"dark"}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.reads.length),1);
    assert.equal(await page.locator(".mcp-app iframe").count(),1);
    assert.equal(await app.locator("body").evaluate(async()=>{try{await fetch("https://mcp-app-denied.invalid/leak");return false}catch{return true}}),true);
    await app.locator("#message").click(); await page.waitForFunction(()=>window.fixture.messages.length===1);
    await app.locator("#context").click();
    await page.waitForFunction(()=>window.fixture.port.augment({context:[]}).context.length===1);
    await app.locator("#state").click(); await page.waitForTimeout(60);
    await page.screenshot({path:output+`/legacy-${width}.png`});
    await page.getByRole("button",{name:"Pause app"}).click(); assert.equal(await page.locator("iframe").count(),0);
    await page.getByRole("button",{name:"Open app"}).click();
    await app.locator("#theme").filter({hasText:'state={"selected":9}'}).waitFor();
    await page.evaluate(()=>window.fixture.hide(true)); assert.equal(await page.locator("iframe").count(),0);
    await page.evaluate(()=>window.fixture.hide(false)); await app.locator("#result").filter({hasText:'"count":2'}).waitFor();
    const previousSection = await page.locator('.mcp-app').elementHandle();
    await page.evaluate(()=>window.fixture.unmount());
    await page.locator('.mcp-app').waitFor({state:'detached'});
    assert.equal(await previousSection!.evaluate(element=>element.isConnected),false);
    await page.evaluate(()=>window.fixture.mount());
    await app.locator("#theme").filter({hasText:'state={"selected":9}'}).waitFor();
    await page.evaluate(()=>window.fixture.hold=true);
    await app.locator("#increment").click(); await page.waitForFunction(()=>!!window.fixture.release);
    await page.evaluate(()=>{const release=window.fixture.release;window.fixture.hold=false;window.fixture.revoke();release()});
    await app.locator("#result").filter({hasText:'"count":2'}).waitFor();
    await app.locator("#theme").filter({hasText:'state={"selected":9}'}).waitFor();
    await page.getByRole("button",{name:"Pause app"}).click();
    const pausedCounts = await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length}));
    await page.evaluate(()=>window.fixture.unmount());
    await page.locator('.mcp-app').waitFor({state:'detached'});
    await page.evaluate(()=>window.fixture.mount());
    await page.getByRole("button",{name:"Open app"}).waitFor();
    await page.evaluate(()=>window.fixture.revoke());
    await page.getByRole("button",{name:"Open app"}).waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('iframe').count(),0,"Explicit pause survives whole-row and owner replacement");
    assert.deepEqual(await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length})),pausedCounts,"Recovery must not load or run a manually paused App");
    await page.evaluate(()=>window.fixture.setResourceUri('ui://counter/other.html'));
    await app.locator("#theme").filter({hasText:'state=null'}).waitFor();
    await page.getByRole("button",{name:"Pause app"}).waitFor();
    await page.evaluate(()=>window.fixture.setResourceUri('ui://counter/app.html'));
    await page.getByRole("button",{name:"Open app"}).waitFor();
    assert.equal(await page.locator('iframe').count(),0,"Returning to the original identity retains its own pause");
    await page.getByRole("button",{name:"Open app"}).click();
    await app.locator("#theme").filter({hasText:'state={"selected":9}'}).waitFor();
    const beforeRenameFrame = await page.locator('iframe').elementHandle();
    const beforeRenameCounts = await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length}));
    await page.evaluate(()=>window.fixture.setDisplayName('Renamed Counter'));
    await page.locator('.mcp-app__header span').filter({hasText:'Renamed Counter'}).waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await beforeRenameFrame!.evaluate(element=>element.isConnected),true,'Display names do not replace the document');
    assert.deepEqual(await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length})),beforeRenameCounts);
    await page.evaluate(()=>{window.fixture.holdResource=true;window.fixture.setResourceUri('ui://counter/active-first.html')});
    await page.waitForFunction(()=>!!window.fixture.releaseResource);
    assert.equal(await beforeRenameFrame!.evaluate(element=>element.isConnected),false,'New identity disposes the old document before its read completes');
    assert.equal(await page.locator('iframe').count(),0,'Loading a different App never exposes the previous document');
    await page.evaluate(()=>{window.fixture.oldResourceRelease=window.fixture.releaseResource;window.fixture.holdResource=false;window.fixture.setResourceUri('ui://counter/active-second.html')});
    await app.locator('#theme').filter({hasText:'state=null'}).waitFor();
    await app.locator('#result').filter({hasText:'"count":2'}).waitFor();
    const replacementFrame = await page.locator('iframe').elementHandle();
    await page.evaluate(()=>window.fixture.oldResourceRelease());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await replacementFrame!.evaluate(element=>element.isConnected),true,'Late old resource cannot replace the new App');
    assert.equal(await page.getByRole('alert').count(),0);
    await page.evaluate(()=>window.fixture.setResourceUri('ui://counter/app.html'));
    await app.locator('#theme').filter({hasText:'state={"selected":9}'}).waitFor();
    assert.equal(await replacementFrame!.evaluate(element=>element.isConnected),false);
    await page.evaluate(()=>window.fixture.switchMode("standard"));
    await app.locator("#result").filter({hasText:'"count":3'}).waitFor();
    await app.locator("#events").filter({hasText:"ui/notifications/tool-result"}).waitFor();
    const toolEvents = await app.locator("#events").textContent();
    await page.evaluate(()=>window.fixture.setTheme("light")); await app.locator("#theme").filter({hasText:"light"}).waitFor();
    assert.equal(await app.locator("#events").textContent(),toolEvents);
    // Resize the App container without changing the window or remounting the App.
    const readsBeforeResize = await page.evaluate(()=>window.fixture.reads.length);
    const callsBeforeResize = await page.evaluate(()=>window.fixture.calls.length);
    const frameHandle = await page.locator('iframe').elementHandle();
    await page.locator('.mcp-app').evaluate(element=>{element.style.width='280px'});
    const embedded = page.frames().find(frame=>frame.parentFrame() !== null)!;
    await embedded.waitForFunction(()=>window.hostContext.containerDimensions.maxWidth===innerWidth);
    const narrowWidth = await app.locator('body').evaluate(()=>window.hostContext.containerDimensions.maxWidth);
    await page.locator('.mcp-app').evaluate(element=>{element.style.width='300px';element.style.width='320px'});
    await embedded.waitForFunction(()=>window.hostContext.containerDimensions.maxWidth===innerWidth&&innerWidth>280);
    const resizeEvents = await app.locator('body').evaluate(()=>window.hostContexts.length);
    await page.waitForTimeout(200);
    assert.equal(await app.locator('body').evaluate(()=>window.hostContexts.length),resizeEvents,'idle geometry must not keep notifying');
    assert.equal(await frameHandle!.evaluate(element=>element===document.querySelector('iframe')),true);
    assert.equal(await page.evaluate(()=>window.fixture.reads.length),readsBeforeResize);
    assert.equal(await page.evaluate(()=>window.fixture.calls.length),callsBeforeResize);
    assert.equal(await app.locator('#events').textContent(),toolEvents,'resize must not replay tool results');
    await page.locator('.mcp-app').evaluate(element=>{element.style.width=''});
    await page.screenshot({path:output+`/standard-${width}.png`});
    assert.equal(await page.getByRole("textbox",{name:"Draft"}).inputValue(),"Keep my draft");
    if (sdkBundle) {
      await page.evaluate(()=>window.fixture.switchMode("sdk"));
      await app.locator("#result").filter({hasText:'"count":4'}).waitFor();
      await app.locator("#events").filter({hasText:'"private":"initial"'}).waitFor();
      assert.ok(await page.evaluate(()=>window.fixture.messages.includes('From official SDK')));
      await page.evaluate(()=>window.fixture.setTheme("dark")); await app.locator("#sdk-theme").filter({hasText:"dark"}).waitFor();
      const compatibilityResult = await app.locator("body").evaluate(async()=>window.openai.callTool("increment",{amount:5}));
      assert.equal(compatibilityResult.structuredContent.count,5);
      assert.ok(await page.evaluate(()=>window.fixture.port.augment({context:[]}).context.some(entry=>entry.metadata.value.includes('"sdk":true'))));
    }
    if (hypernode) {
      await page.evaluate(()=>window.fixture.switchMode("hypernode"));
      await app.locator("h1").filter({hasText:"MCP App 构建器"}).waitFor();
      await app.locator("#appId").fill("test-counter"); await app.locator("#title").fill("Counter");
      await app.locator("#save").click();
      await app.locator("#status").filter({hasText:"草稿已保存"}).waitFor();
      assert.ok(await page.evaluate(()=>window.fixture.calls.some(call=>call.tool==='appBuilder.saveDraft'&&call.arguments.spec.appId==='test-counter')));
      await page.screenshot({path:output+`/hypernode-${width}.png`});
    }
    const rpc=await page.evaluate(()=>window.fixture.calls);
    assert.ok(rpc.every((call:any)=>call.threadId==='thread'&&call.server==='counter'));
    assert.deepEqual(protocolErrors,[]);
    await app.locator("body").evaluate(()=>{location.href="about:blank"});
    await page.getByRole("alert").filter({hasText:"App navigation is not allowed"}).waitFor();
    await page.evaluate(()=>window.fixture.unmount()); assert.equal(await page.locator("iframe").count(),0);
    assert.deepEqual(errors,[]);
    results.push({width,legacy:true,standard:true,isolated:true,sourceForgeryBlocked:true,themeWithoutReload:true,stateRetained:true,wholeRowStateRetained:true,replacementLeaseStateRetained:true,manualPauseRetained:true,pauseIdentityIsolated:true,activeResourceIdentityIsolated:true,displayNameStable:true,lateResourceReleased:true,hiddenReleased:true,unmounted:true,calls:rpc.length,pageerrors:errors,hypernodeBuilder:!!hypernode,officialSdk:!!sdkBundle,protocolErrors,production:!!productionServer,cspBlocked:true,staleGenerationReleased:true,navigationRevoked:true,viewportHeightSettled:viewportHeight,containerResize:true,narrowWidth,resizeEvents});
    await context.close();
  }
  for (const width of [390,1280]) {
    const context = await browser.newContext({viewport:{width,height:844},hasTouch:width===390});
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(base+(productionServer?"index.html":"mcp-app-fixture"));
    await page.waitForFunction(()=>window.fixture?.setAvailable);
    await page.evaluate(()=>{window.fixture.setFallback(true);window.fixture.setAvailable(true)});
    const app=page.frameLocator("iframe");
    const activate=(target:any)=>width===390?target.tap():target.click();
    await app.locator("#result").filter({hasText:'"count":2'}).waitFor();
    await page.evaluate(()=>{
      window.fixture.widgetSaves=[];
      window.addEventListener("message",event=>{
        if(event.data?.method==="opencraft/widget-state")window.fixture.widgetSaves.push(event.data.params.state);
      });
    });
    await activate(app.locator("#state"));
    await page.waitForFunction(()=>window.fixture.widgetSaves.length===1);
    assert.deepEqual(await page.evaluate(()=>window.fixture.widgetSaves),[{selected:9}]);
    await activate(page.getByRole("button",{name:"Pause app"}));
    assert.equal(await page.locator("iframe").count(),0);
    await page.evaluate(()=>window.fixture.setResourceUri("ui://counter/other.html"));
    await app.locator("#theme").filter({hasText:"state=null"}).waitFor();
    assert.equal(await page.getByRole("button",{name:"Open app"}).count(),0,"A new resource cannot inherit fallback manual pause");
    assert.equal(await app.locator("body").evaluate(()=>window.openai.widgetState),null,"A new resource cannot inherit another App's fallback JSON");
    const alternateFrame=await page.locator("iframe").elementHandle();
    const beforeReturn=await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length}));
    await page.evaluate(()=>window.fixture.setResourceUri("ui://counter/app.html"));
    await page.getByRole("button",{name:"Open app"}).waitFor();
    assert.equal(await page.locator("iframe").count(),0,"Returning to an original fallback identity retains its own pause");
    assert.equal(await alternateFrame!.evaluate(element=>element.isConnected),false);
    assert.deepEqual(await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length})),beforeReturn);
    await activate(page.getByRole("button",{name:"Open app"}));
    await app.locator("#theme").filter({hasText:'state={"selected":9}'}).waitFor();
    const originalFrame=await page.locator("iframe").elementHandle();
    const beforeRename=await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length}));
    await page.evaluate(()=>window.fixture.setDisplayName("Renamed fallback App"));
    await page.locator(".mcp-app__header span").filter({hasText:"Renamed fallback App"}).waitFor();
    assert.equal(await originalFrame!.evaluate(element=>element.isConnected),true,"Fallback display names retain the current document");
    assert.deepEqual(await page.evaluate(()=>({reads:window.fixture.reads.length,calls:window.fixture.calls.length})),beforeRename);
    await page.screenshot({path:output+`/fallback-restored-${width}.png`});
    await page.evaluate(()=>window.fixture.revoke());
    await app.locator("#theme").filter({hasText:"state=null"}).waitFor();
    assert.equal(await originalFrame!.evaluate(element=>element.isConnected),false,"A different port key replaces the fallback document");
    assert.equal(await page.getByRole("textbox",{name:"Draft"}).inputValue(),"Keep my draft");
    assert.deepEqual(await page.evaluate(()=>window.fixture.messages),[]);
    assert.deepEqual(errors,[]);
    results.push({width,fallbackStore:true,resourceJsonIsolated:true,manualPauseIsolated:true,originalIdentityRestored:true,displayNameStable:true,newPortFresh:true,pageerrors:errors});
    await context.close();
  }
  // Restored built-in cards must recover when the first canonical-history
  // read fails transiently. Exercise the actual Pause/Open UI on one owner.
  for (const width of [390,1280]) for (const theme of ["light","dark"]) {
    const context=await browser.newContext({viewport:{width,height:844},hasTouch:width===390,colorScheme:theme});
    const page=await context.newPage();const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(base+(productionServer?"index.html":"mcp-app-fixture"));
    await page.waitForFunction(()=>window.fixture?.setAvailable);
    await page.evaluate(theme=>{window.fixture.setAvailable(true);window.fixture.setTheme(theme)},theme);
    const app=page.frameLocator("iframe");const activate=(target:any)=>width===390?target.tap():target.click();
    await app.locator("#result").filter({hasText:'"count":2'}).waitFor();
    await page.getByRole("textbox",{name:"Draft"}).fill("Keep retry draft");
    await activate(app.locator("#state"));await page.waitForTimeout(60);
    await page.evaluate(()=>window.fixture.setResourceUri("ui://opencraft/apps/recovered"));
    await page.getByRole("alert").filter({hasText:"Canonical App reference not loaded"}).waitFor();
    assert.equal(await page.locator("iframe").count(),0);
    assert.equal(await page.evaluate(()=>window.fixture.historyReads),1);
    const before=await page.evaluate(()=>window.fixture.calls.length);
    await activate(page.getByRole("button",{name:"Pause app"}));
    await activate(page.getByRole("button",{name:"Open app"}));
    try { await app.locator("#result").filter({hasText:'"count":2'}).waitFor({timeout:3000}); }
    catch(error){await page.screenshot({path:output+`/retry-failed-${theme}-${width}.png`});console.error("retry diagnosis",await page.evaluate(()=>({hydrations:window.fixture.historyReads,reads:window.fixture.reads.length,alert:document.querySelector('[role="alert"]')?.textContent})));throw error;}
    assert.equal(await page.evaluate(()=>window.fixture.historyReads),2,"explicit retry reacquires the failed history read");
    assert.equal(await page.evaluate(()=>window.fixture.reads.filter((r:any)=>r.uri==="ui://opencraft/apps/recovered").length),3,"one denied first attempt plus denied-and-accepted retry");
    assert.equal(await page.evaluate(()=>window.fixture.calls.length),before+1,"recovery runs the newly opened App once without replaying earlier tool calls");
    const frame=await page.locator("iframe").elementHandle();
    await app.locator("body").evaluate(element=>{const input=document.createElement('input');input.id='retry-draft';element.append(input)});
    await app.locator("#retry-draft").fill("Keep App retry input");
    await page.evaluate(theme=>window.fixture.setTheme(theme==="light"?"dark":"light"),theme);
    await app.locator("#theme").filter({hasText:theme==="light"?"dark":"light"}).waitFor();
    assert.equal(await frame!.evaluate(element=>element.isConnected),true);
    assert.equal(await app.locator("#retry-draft").inputValue(),"Keep App retry input");
    await page.screenshot({path:output+`/retry-restored-${theme}-${width}.png`});
    await page.evaluate(()=>window.fixture.setResourceUri("ui://counter/app.html"));
    // The original App's saved widget data remains isolated from the recovered App.
    await app.locator("#theme").filter({hasText:'state={"selected":9}'}).waitFor();
    assert.equal(await page.getByRole("textbox",{name:"Draft"}).inputValue(),"Keep retry draft");
    assert.deepEqual(errors,[]);results.push({width,theme,historyFailureRetry:true,hydrations:2,resourceReads:3,noToolReplay:true,draftRetained:true,originalWidgetStateRetained:true,pageerrors:errors});
    await context.close();
  }
  await writeFile(output+"/result.json",JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
} finally { await browser?.close(); if (productionServer) await new Promise<void>(resolve => productionServer!.httpServer.close(()=>resolve())); await vite.close(); }
