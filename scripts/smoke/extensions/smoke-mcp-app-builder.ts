import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, loadConfigFromFile } from "vite";
import { WebSocketServer } from "ws";
import { startHeadlessServer } from "../../headless-application.mjs";
import { chromium } from "playwright";
const output = path.resolve(
  process.env.OPENCRAFT_MCP_APP_OUTPUT ?? "/tmp/opencraft-mcp-app-builder",
);
await mkdir(output, { recursive: true });
const root = await mkdtemp(
  path.join(tmpdir(), "opencraft-app-builder-browser-"),
);
let app: any, browser: any;
const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => upstream.once("listening", resolve));
let sequence = 0;
const engineItems: any[] = [];
upstream.on("connection", (socket) => {
  const pending = new Map<string, string | number>();
  socket.on("message", (data) => {
    const p = JSON.parse(String(data));
    const reply = (result: unknown) =>
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: p.id, result }));
    if (!p.method) {
      const id = pending.get(String(p.id));
      if (id !== undefined) {
        pending.delete(String(p.id));
        if (p.result?.success) for (const block of p.result.contentItems ?? []) {
          try {
            const envelope = JSON.parse(block.text);
            if (envelope.kind === "opencraft-mcp-app") engineItems.push({ id: String(p.id), type: "dynamicToolCall", namespace: "opencraft_apps", tool: "manage", status: "completed", success: true, arguments: {}, contentItems: p.result.contentItems });
          } catch {}
        }
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: p.result }));
      }
      return;
    }
    if (p.method === "initialize") {
      reply({
        userAgent: "synthetic-engine",
        platformFamily: "unix",
        platformOs: "linux",
        capabilities: { extensions: {} },
      });
      return;
    }
    if (p.method === "thread/read") {
      reply({ thread: { id: p.params.threadId, turns: [{ id: "saved-turn", items: engineItems }] } }); return;
    }
    if (p.method === "fixture/model-tool") {
      const callId = "model-tool-" + ++sequence;
      pending.set(callId, p.id);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: callId,
          method: "item/tool/call",
          params: {
            threadId: "fixture-thread",
            turnId: "fixture-turn",
            callId,
            namespace: "opencraft_apps",
            tool: "manage",
            arguments: p.params,
          },
        }),
      );
      return;
    }
    if (p.id !== undefined)
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: p.id,
          error: {
            code: -32601,
            message: "Synthetic engine does not own this method",
          },
        }),
      );
  });
});
const source = `
import React,{useMemo,useState}from'react';
import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{Conversation}from'/apps/workbench-web/src/components/conversation.tsx';
import{Context}from'@deepseek-ai/cordis';
import{TimelineBlockRendererProvider,TimelineBlockRendererRegistryService}from'@opencraft/timeline-render-react';
import{BuiltinTimelineRendererPlugin}from'/apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import{createConversationKey,createDefaultTimelineProjectorRegistry,projectTimeline}from'@opencraft/chat-core';
import{JsonRpcAppServerClient}from'@opencraft/appserver-client';
import{WebSocketTransport}from'@opencraft/appserver-transport-websocket';
import{installMcpAppsDynamicToolHandler}from'/packages/mcp-apps/src/dynamic-tools.ts';
import{createMcpAppOwner}from'/apps/workbench-web/src/mcp-apps/owner.ts';
import{initializeAppearanceTheme}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const ctx=new Context();await ctx.plugin(TimelineBlockRendererRegistryService);await ctx.plugin(BuiltinTimelineRendererPlugin);
const client=new JsonRpcAppServerClient({hostId:'host',transport:new WebSocketTransport({url:location.origin.replace('http','ws')+'/appserver'})});
const stop=installMcpAppsDynamicToolHandler(client);await client.connect({clientInfo:{name:'builder-browser',version:'1'},capabilities:{experimentalApi:true}});
const registry=createDefaultTimelineProjectorRegistry();let items=[];
function App(){const [revision,setRevision]=useState(0);const port=useMemo(()=>createMcpAppOwner({key:'host:fixture-thread:1',threadId:'fixture-thread',assertCurrent:()=>{if(client.status.state!=='open')throw Error('closed')},request:(method,params)=>client.requestRaw(method,params),sendMessage:async text=>{window.fixture.messages.push(text)},openLink:()=>{}}),[]);
window.fixture={client,messages:[],cached(envelope){items=[{id:'cached-card',type:'dynamicToolCall',payload:{namespace:'opencraft_apps',tool:'manage',status:'completed',success:true,arguments:{},contentItems:[{type:'inputText',text:JSON.stringify(envelope)}]}}];setRevision(x=>x+1);},async tool(input,shape='native'){const r=await client.requestRaw('fixture/model-tool',input);if(!r.success)throw Error(r.contentItems[0].text);const data=JSON.parse(r.contentItems[0].text);if(data.kind==='opencraft-mcp-app'){items=[{id:'launch-'+revision,type:'dynamicToolCall',payload:{namespace:shape==='native'?'opencraft_apps':'deepseek-harness',tool:shape==='native'?'manage':'opencraft_apps__manage',status:'completed',success:true,arguments:input,contentItems:r.contentItems}}];setRevision(x=>x+1)}return data;},hide(hidden){Object.defineProperty(document,"visibilityState",{configurable:true,value:hidden?"hidden":"visible"});document.dispatchEvent(new Event("visibilitychange"));},close(){stop();client.close()}};
const timeline=useMemo(()=>projectTimeline({key:createConversationKey('host','fixture-thread'),revision,authoritative:true,phase:'live',turns:[{id:'turn',status:'complete',items}]},registry),[revision]);
return <TimelineBlockRendererProvider registry={ctx.timelineBlockRenderers}><Conversation timeline={timeline} scrollPolicy='natural' documentContext={{conversationId:'fixture-thread',cwd:null,hostId:'host',theme:'light',mcpApps:port}}/></TimelineBlockRendererProvider>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
try {
  const entry = path.resolve(".local/mcp-app-builder/index.html"),
    outDir = path.join(output, "production");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(
    entry,
    '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/mcp-app-builder.tsx"></script>',
  );
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    "apps/workbench-web/vite.config.ts",
  );
  assert.ok(loaded);
  const plugins = (loaded.config.plugins ?? []).filter(
    (p) =>
      ![
        "opencraft-startup-resources",
        "opencraft-embedded-workbench-dev-entry",
      ].includes((p as any)?.name ?? ""),
  );
  await build({
    ...loaded.config,
    configFile: false,
    root: process.cwd(),
    logLevel: "error",
    base: "/",
    plugins: [
      ...plugins,
      {
        name: "builder-fixture",
        resolveId: (id) => (id === "/mcp-app-builder.tsx" ? id : null),
        load: (id) => (id === "/mcp-app-builder.tsx" ? source : null),
      },
    ],
    build: {
      ...loaded.config.build,
      outDir,
      emptyOutDir: true,
      rolldownOptions: {
        ...loaded.config.build?.rolldownOptions,
        input: entry,
      },
    },
  });
  await writeFile(
    path.join(outDir, "index.html"),
    await readFile(path.join(outDir, ".local/mcp-app-builder/index.html")),
  );
  await writeFile(
    path.join(outDir, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "builder-browser",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const principal = (name: string) => ({
    provider: "fixture",
    subject: name,
    displayName: name,
    expiresAt: Date.now() + 600000,
  });
  app = await startHeadlessServer(
    {
      root,
      webRoot: outDir,
      dataDirectory: path.join(root, "data"),
      port: 0,
      accessMemberProviders: ["fixture"],
      startAgentHost: async () => ({
        websocketUrl: `ws://127.0.0.1:${(upstream.address() as any).port}`,
        close: async () => {},
      }),
    },
    {
      createIdentity: async () => ({
        providers: [
          {
            authenticate: (req: any) => {
              const name = /fixture=(alice|bob)/.exec(
                req.headers.cookie ?? "",
              )?.[1];
              return name ? principal(name) : null;
            },
          },
        ],
        close() {},
      }),
    },
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  });
  const results = [];
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: width === 390,
    });
    await context.addCookies([
      { name: "fixture", value: "alice", url: app.url },
    ]);
    const page = await context.newPage(),
      errors: string[] = [];
    let listRequests = 0, blockedFormRequests = 0;
    page.on("websocket", (socket) =>
      socket.on("framesent", (frame) => {
        try {
          const p = JSON.parse(String(frame.payload));
          if (
            p.method === "mcpServer/tool/call" &&
            p.params?.arguments?.action === "list"
          )
            listRequests++;
        } catch {}
      }),
    );
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(app.url);
    await page.waitForFunction(() => !!(window as any).fixture);
    const tool = (input: unknown, shape = "native") =>
      page.evaluate(
        ({ input, shape }) => (window as any).fixture.tool(input, shape),
        { input, shape },
      );
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).fixture.client.initializeResult.capabilities
            .extensions["opencraft/mcp-app-builder"].version,
      ),
      1,
    );
    const spec = {
      appId: "calculator" + width,
      title: "Calculator",
      description: "Real server calculator",
      entryTool: "calculate",
      uiHtml:
        '<!doctype html><html><body><h2>Calculator</h2><button id="go">7 + 8</button><output id="value">Ready</output><form id="choice"><input id="draft" aria-label="Draft"><button id="send" type="submit">Send choice</button></form><script>document.getElementById("choice").onsubmit=e=>{e.preventDefault();window.openai.sendFollowUpMessage({prompt:document.getElementById("draft").value})};document.getElementById("go").onclick=async()=>{try{const r=await window.openai.callTool("calculate",{a:7,b:8});document.getElementById("value").textContent=r.structuredContent.sum}catch(e){document.getElementById("value").textContent="Inactive"}};</script></body></html>',
      tools: [
        {
          name: "calculate",
          description: "Add two numbers",
          readOnlyHint: true,
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
            additionalProperties: false,
          },
          handler: {
            kind: "javascript",
            source: "return {sum:args.a+args.b};",
          },
        },
      ],
    };
    const help: any = await tool({ action: "help" });
    assert.match(help.guide, /expectedVersion/);
    await tool({ action: "validate", spec_json: JSON.stringify(spec) });
    const published: any = await tool({
      action: "publish",
      appId: spec.appId,
      spec_json: JSON.stringify(spec),
      expectedVersion: 0,
    });
    assert.equal(published.activeRevision, 1);
    const firstOpen = await tool(
      { action: "open", appId: spec.appId },
      width === 390 ? "dsh" : "native",
    );
    const frame = page.frameLocator("iframe");
    await frame.locator("#go").click();
    await frame.locator("#value").filter({ hasText: "15" }).waitFor();
    await page.screenshot({
      path: path.join(output, `calculator-${width}.png`),
    });
    const idle = await page.locator("iframe").count();
    await page.waitForTimeout(350);
    assert.equal(await page.locator("iframe").count(), idle);
    await tool({ action: "openBuilder" });
    await frame.locator("#status").filter({ hasText: "已完成" }).waitFor();
    const bob = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width === 390 });
    await bob.addCookies([{ name: "fixture", value: "bob", url: app.url }]);
    const other = await bob.newPage();
    other.on("request", request => { if (request.url().endsWith("/blocked-form-submit")) blockedFormRequests++; });
    await other.goto(app.url);
    await other.waitForFunction(() => !!(window as any).fixture);
    assert.deepEqual((await other.evaluate(() => (window as any).fixture.tool({ action: "list" }))).apps, []);
    await other.evaluate(envelope => (window as any).fixture.cached(envelope), firstOpen);
    const otherFrame = other.frameLocator("iframe");
    await otherFrame.locator("#go").click();
    await otherFrame.locator("#value").filter({ hasText: "15" }).waitFor();
    await otherFrame.locator("#draft").fill("Apple x 1");
    await otherFrame.locator("#send").click();
    await other.waitForFunction(() => (window as any).fixture.messages.length === 1);
    assert.deepEqual(await other.evaluate(() => (window as any).fixture.messages), ["Apple x 1"]);
    await otherFrame.locator("body").evaluate(async (body, url) => {
      const blocked = new Promise<void>(resolve => document.addEventListener("securitypolicyviolation", event => {
        if (event.effectiveDirective === "form-action") resolve();
      }, { once: true }));
      const form = document.createElement("form"); form.action = url; form.method = "post";
      body.append(form); form.requestSubmit(); form.remove();
      await blocked;
    }, new URL("blocked-form-submit", app.url).href);
    assert.equal(blockedFormRequests, 0, "CSP blocks network submission even though local submit events work");
    await other.screenshot({ path: path.join(output, `historical-shared-${width}.png`) });
    await other.reload();
    await other.waitForFunction(() => !!(window as any).fixture);
    await other.evaluate(envelope => (window as any).fixture.cached(envelope), firstOpen);
    await otherFrame.locator("#go").click();
    await otherFrame.locator("#value").filter({ hasText: "15" }).waitFor();
    const beforeGlobals = listRequests;
    assert.ok(beforeGlobals > 0, "observe real App list requests before testing quiescence");
    await frame.locator("body").evaluate(() => {
      for (let n = 0; n < 4; n++)
        window.dispatchEvent(
          new CustomEvent("openai:set_globals", {
            detail: { globals: { theme: "light" } },
          }),
        );
    });
    await page.waitForTimeout(100);
    assert.equal(
      listRequests,
      beforeGlobals,
      "host globals must not requery the App list",
    );
    await frame.locator("#appId").fill(spec.appId);
    await frame.locator('[data-action="get"]').click();
    await frame.locator("#status").filter({ hasText: "已完成" }).waitFor();
    assert.match(await frame.locator("#spec").inputValue(), /Calculator/);
    await page.screenshot({ path: path.join(output, `builder-${width}.png`) });
    await tool({ action: "unpublish", appId: spec.appId, expectedVersion: 1 });
    await assert.rejects(
      tool({ action: "open", appId: spec.appId }),
      /inactive/,
    );
    await otherFrame.locator("#go").click();
    await otherFrame.locator("#value").filter({ hasText: "Inactive" }).waitFor();
    await tool({
      action: "rollback",
      appId: spec.appId,
      revision: 1,
      expectedVersion: 2,
    });
    await tool({ action: "open", appId: spec.appId });
    await frame.locator("#go").click();
    await frame.locator("#value").filter({ hasText: "15" }).waitFor();
    await tool({ action: "openBuilder" });
    await frame.locator("#appId").fill(spec.appId);
    await frame.locator('[data-action="get"]').click();
    await frame.locator("#status").filter({ hasText: "已完成" }).waitFor();
    const draftText = (await frame.locator("#spec").inputValue()) + "\n";
    await frame.locator("#spec").fill(draftText);
    await page.waitForTimeout(30);
    await page.evaluate(() => (window as any).fixture.hide(true));
    await page.waitForFunction(
      () => document.querySelectorAll("iframe").length === 0,
    );
    await page.evaluate(() => (window as any).fixture.hide(false));
    await frame.locator("#spec").waitFor({ state: "visible" });
    await page.waitForTimeout(150);
    assert.equal(await frame.locator("#spec").inputValue(), draftText);
    await frame.locator('[data-action="delete"]').click();
    await frame.locator("#confirm-delete").click();
    await frame.locator("#status").filter({ hasText: "已完成" }).waitFor();
    await assert.rejects(
      tool({ action: "open", appId: spec.appId }),
      /inactive/,
    );
    await bob.close();
    assert.deepEqual(errors, []);
    results.push({
      width,
      realGateway: true,
      realStore: true,
      realQuickJS: true,
      dynamicTool: true,
      inlineApp: true,
      builder: true,
      rollback: true,
      actorIsolation: true,
      historicalSharedCard: true,
      sharedToolAndFollowup: true,
      reconnectHistory: true,
      sharedRevocation: true,
      formSubmitEvent: true,
      formNetworkBlocked: true,
      globalsNoRequery: true,
      pageerrors: errors,
    });
    await context.close();
  }
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        results,
        syntheticBoundary:
          "engine/model and human proof provider only; actual production Conversation, client tool handler, WebSocket gateway, actor binding, SQLite and QuickJS",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  await app?.close();
  for (const client of upstream.clients) client.terminate();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
