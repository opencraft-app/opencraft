import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { chromium } from "playwright";

const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
import {QueryClient,InfiniteQueryObserver} from '@tanstack/react-query';
import {bindThreadCatalogNotifications} from './apps/workbench-web/src/runtime/thread-catalog-notifications.ts';
import {threadCatalogUpdates} from './apps/workbench-web/src/runtime/thread-catalog-updates.ts';
import {threadDirectoryIncomplete} from '@opencraft/appserver-protocol';
window.probe=async(incremental)=>{
 const q=new QueryClient({defaultOptions:{queries:{retry:false}}});let receive,reads=0;
 const stop=bindThreadCatalogNotifications({initializeResult:{capabilities:{extensions:incremental?{'opencraft/thread-directory-updates':{version:1}}:{}}},subscribeNotification(fn){receive=fn;return()=>{}}},'fixture',q);
 const key=['appserver','fixture','threads','sidebar'];
 const journal=threadCatalogUpdates(q,key,'fixture');journal.enabled=true;
 const row=i=>({id:'t'+i,cwd:'/fixture',createdAt:1,updatedAt:1,name:'Thread '+i,preview:'before',status:{type:'idle'},ephemeral:false,turns:[]});
 const observer=new InfiniteQueryObserver(q,{queryKey:key,initialPageParam:0,queryFn:async({pageParam})=>{reads++;return{data:[row(pageParam)],nextCursor:pageParam<16?pageParam+1:null}},getNextPageParam:last=>last.nextCursor});
 const remove=observer.subscribe(()=>{});
 try {
  await observer.refetch();for(let i=1;i<17;i++)await observer.fetchNextPage();
  const baseline=reads;
  for(let i=0;i<10;i++)receive({method:'turn/completed',params:{threadId:'t16'}});
  await new Promise(r=>setTimeout(r,50));
  const turnReads=reads-baseline;
  receive({method:'opencraft/thread-catalog/changed',params:{version:1,source:'directory',revision:1,change:{type:'upsert',thread:{...row(16),preview:'after',updatedAt:2,recencyAt:20}}}});
  const raw=q.getQueryData(key);const projected=journal.project({data:raw.pages.flatMap(p=>p.data),nextCursor:null});
  document.body.textContent=projected.data[0].id+':'+projected.data[0].preview;
  const result={incremental,baseline,turnReads,first:document.body.textContent,warmingIncomplete:threadDirectoryIncomplete({data:[],nextCursor:null,catalog:{state:'warming',coverage:'unknown'}})};
  return result;
 }finally{remove();stop();q.clear()}
};` }, bundle: true, format: "esm", platform: "browser", write: false });
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/probe.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/probe.js" ? bundle.outputFiles[0]!.text : '<!doctype html><script type="module" src="/probe.js"></script>');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
  await page.waitForFunction(() => typeof (window as any).probe === "function");
  const old = await page.evaluate(() => (window as any).probe(false));
  const current = await page.evaluate(() => (window as any).probe(true));
  assert.ok(old.turnReads >= 17); assert.equal(current.turnReads, 0);
  assert.equal(current.baseline, 17); assert.equal(current.first, "t16:after"); assert.equal(current.warmingIncomplete, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: "Chromium", scope: "production notification and paged cache modules with synthetic metadata", old, current, errors }));
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
