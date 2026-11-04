import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { ConversationHistory } from "../../../packages/app-host-server/src/conversation-history.js";
import { ConversationHistoryTransport } from "../../../packages/app-host-server/src/conversation-history-transport.js";
import { openServerDatabase } from "../../../packages/storage-node/src/server/index.js";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

type Value = Record<string, any>;
const output = resolve(process.env.OPENCRAFT_STATUS_EVIDENCE ?? ".local/sidebar-status-owner");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "sidebar-status-owner-"));
const storage = await openServerDatabase(directory);
const history = new ConversationHistory(storage.database, "synthetic");
const row = { id: "owner-thread", name: "Streaming owner task", cwd: "/synthetic", createdAt: 1, updatedAt: 2, turns: [], status: { type: "idle" } };
history.importResult("initialize", {}, { capabilities: { extensions: {} } }, 0);
history.importResult("thread/list", {}, { data: [row], nextCursor: null }, history.catalogRevision());
class Engine implements DuplexTransport {
  status: TransportStatus = { state: "open" };
  messages = new Set<(frame: string) => void>(); methods: string[] = [];
  async connect() {}
  async close() {}
  subscribeMessage(fn: (frame: string) => void) { this.messages.add(fn); return () => { this.messages.delete(fn); }; }
  subscribeStatus() { return () => {}; }
  emit(packet: Value) { for (const listener of this.messages) listener(JSON.stringify(packet)); }
  async send(frame: string) {
    const packet = JSON.parse(frame); this.methods.push(packet.method);
    if (packet.id !== undefined) this.emit({ ...packet, method: undefined,
      result: packet.method === "initialize" ? { capabilities: { extensions: {} } }
        : packet.method === "thread/list" ? { data: [row], nextCursor: null } : {} });
  }
}
const engine = new Engine(), transport = new ConversationHistoryTransport(engine, history);
let sequence = 0;
async function rpc(method: string) {
  const id = ++sequence; let result: Value | undefined;
  const stop = transport.subscribeMessage(frame => { const packet = JSON.parse(frame); if (packet.id === id && !packet.method) result = packet.result; });
  try { await transport.send(JSON.stringify({ id, method, params: {} })); assert.ok(result); return result; } finally { stop(); }
}
await transport.connect(); await rpc("initialize");
const source = `
import React,{useState}from'react';import{createIntlTestRoot}from'/tests/fixtures/intl-root.tsx';
import{Sidebar}from'/apps/workbench-web/src/components/sidebar.tsx';
import{projectAppServerThread,threadServerOrigin}from'@opencraft/workbench-runtime';
import{SidebarLayoutStore}from'@opencraft/sidebar-layout';
import{initializeAppearanceTheme}from'/apps/workbench-web/src/appearance-theme.ts';
import'/apps/workbench-web/src/styles/app.scss';initializeAppearanceTheme();
const layout=await SidebarLayoutStore.open({load:async()=>null,save:async(_,value)=>value});
function App(){const[threads,setThreads]=useState([]);window.refreshOwnerDirectory=async()=>{const page=await(await fetch('/directory')).json();setThreads(page.data.map(row=>({...projectAppServerThread(row),connectionHostId:'synthetic',connectionHostLabel:'Fixture',serverOrigin:threadServerOrigin({serverId:'synthetic',label:'Fixture'}),serverRouteLocality:'local'})));};return <div style={{width:300,height:700}}><Sidebar threads={threads} activeHostId='synthetic' activeThreadId='owner-thread' sidebarLayout={layout} onSelectThread={()=>{}} onNewTask={()=>{}} onOpenSettings={()=>{}} showFooter={false}/></div>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "status-owner-fixture",
    resolveId: id => id === "/probe.tsx" ? id : null, load: id => id === "/probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === "/directory") { void rpc("thread/list").then(value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); }); return; }
      if (req.url !== "/") return next();
      res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>');
    }); },
  }] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen(); browser = await chromium.launch({ headless: true });
  const evidence: Value[] = [];
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1024, height: 768 }, hasTouch: touch, isMobile: touch });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`, { waitUntil: "domcontentloaded" });
    try { await page.waitForFunction(() => typeof (window as any).refreshOwnerDirectory === "function", undefined, { timeout: 60000 }); }
    catch (error) { console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() })); throw error; }
    for (const [state, status] of Object.entries({ running: { type: "active", activeFlags: [] }, waiting: { type: "active", activeFlags: ["waitingOnApproval"] }, ready: { type: "idle" } })) {
      engine.emit({ method: "thread/status/changed", params: { threadId: row.id, status } });
      // The source directory deliberately still returns idle, and durable
      // history still says notLoaded, while the real Sidebar consumes the read.
      await page.evaluate(() => (window as any).refreshOwnerDirectory());
      const glyph = page.locator(`.sidebar-activity-item__status.is-${state === "waiting" ? "review" : state}`);
      await glyph.waitFor({ state: "attached" });
      assert.equal(await glyph.locator("svg").count(), state === "running" ? 1 : 0);
      if (state === "running") assert.equal(await glyph.evaluate(el => getComputedStyle(el).animationName), "sidebar-activity-spin");
      await page.screenshot({ path: join(output, `${touch ? "touch" : "desktop"}-${state}.png`) });
      evidence.push({ touch, state, status });
    }
    assert.deepEqual(errors, []); await page.close();
  }
  assert.equal(engine.methods.some(method => ["thread/resume", "turn/start"].includes(method)), false);
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, evidence, nativeMethods: engine.methods }, null, 2));
  console.log(JSON.stringify({ passed: true, output, states: evidence.length }));
} finally { await browser?.close(); await vite.close(); await transport.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); }
