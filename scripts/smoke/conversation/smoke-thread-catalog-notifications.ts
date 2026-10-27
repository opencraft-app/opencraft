import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { chromium } from "playwright";

// Synthetic cache data with the production notification owner and QueryClient.
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
import {QueryClient} from '@tanstack/react-query';
import {bindThreadCatalogNotifications} from './apps/workbench-web/src/runtime/thread-catalog-notifications.ts';
const errors=[];addEventListener('unhandledrejection',e=>errors.push(e.reason.message));
const q=new QueryClient();let emit;
const stop=bindThreadCatalogNotifications({subscribeNotification(fn){emit=fn;return()=>{}}},'fixture',q);
const key=['appserver','fixture','threads','sidebar'];
const archiveKey=['appserver','fixture','threads','archived','management'];
const archived=[{id:'archived',name:'Fixture'}];
q.setQueryData(key,{data:[{id:'fixture',pinned:true,status:{type:'idle'}}]});q.setQueryData(archiveKey,archived);
window.probe=async()=>{
 emit({method:'turn/started',params:{threadId:'fixture'}});await new Promise(r=>setTimeout(r,50));
 const active=q.getQueryData(key).data[0].status.type;
 emit({method:'thread/status/changed',params:{threadId:'fixture',status:{type:'idle'}}});await new Promise(r=>setTimeout(r,50));
 const result={errors,active,status:q.getQueryData(key).data[0].status.type,archiveIdentity:q.getQueryData(archiveKey)===archived,pinned:q.getQueryData(key).data[0].pinned};
 stop();q.clear();return result;
};` }, bundle: true, format: "esm", platform: "browser", write: false });
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/probe.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/probe.js" ? bundle.outputFiles[0]!.text : '<!doctype html><script type="module" src="/probe.js"></script>');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
  await page.waitForFunction(() => typeof (window as any).probe === "function");
  const result = await page.evaluate(() => (window as any).probe());
  assert.deepEqual(result, { errors: [], active: "active", status: "idle", archiveIdentity: true, pinned: true });
  console.log(JSON.stringify({ browser: "Chromium", ...result }));
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
