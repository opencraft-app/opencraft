import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer, loadConfigFromFile } from "vite";
import react from "@vitejs/plugin-react";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const source = `import '/apps/workbench-web/src/runtime/web-crypto-compat';
import React from 'react';import {Context} from '@deepseek-ai/cordis';import {BlobResourceService} from '@opencraft/blob-resources';
import {WebChatDocument} from '@opencraft/chat-render-web';import {createAppServerMediaSourceLoader} from '/apps/workbench-web/src/runtime/appserver-media-loader';
import {createIntlTestRoot} from '/tests/fixtures/intl-root';import '/apps/workbench-web/src/styles/app.scss';
const ctx=new Context();await ctx.plugin(BlobResourceService,{storage:{get:async()=>undefined,put:async()=>{},delete:()=>new Promise(resolve=>setTimeout(resolve,30)),clear:async()=>{},close:()=>{}}});window.events=[];
let connectionGeneration=1;const runtime={resources:{host:{getConnectionGeneration:()=>connectionGeneration}}};
const cases=[['blocked','https://untrusted.invalid/x.png',false,'restricted'],['denied','/fixture/denied.png',true],['html','/fixture/html.png',true],['valid','/fixture/valid.png',true],['download',location.origin+'/__opencraft_files?hostId=local-codex&path=%2Ffixture%2Fflaky.png',true],['external',location.origin+'/direct.png',false]];
function App(){const [generation,setGeneration]=React.useState(connectionGeneration);window.reconnect=()=>{connectionGeneration++;setGeneration(connectionGeneration)};const load=React.useMemo(()=>createAppServerMediaSourceLoader(runtime,ctx.blobResources,'local-codex'),[generation]);return <main style={{padding:20}}>{cases.map(([id,url,host,policy])=><section key={id} data-case={id}><WebChatDocument documentId={id} cwd='/fixture' source={'!['+id+']('+url+')'} loadMediaSource={host?load:undefined} externalResourcePolicy={policy} onMediaDiagnostic={e=>window.events.push({documentId:e.documentId,phase:e.phase,outcome:e.outcome,contentType:e.contentType,policy:e.policy,transport:e.transport,readAttempts:e.readAttempts,httpStatus:e.error?.httpStatus})}/></section>)}</main>}
createIntlTestRoot(document.getElementById('root')).render(<App/>);`;
const config = await loadConfigFromFile({ command: "serve", mode: "development" }, resolve("apps/workbench-web/vite.config.ts"));
let denied = true;
let deniedRequests = 0;
let flakyReads = 0;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic" }, optimizeDeps: { ...config!.config.optimizeDeps, entries: [] }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [react(), { name: "chat-media-diagnostics", enforce: "pre", resolveId: id => id === "/media-fixture.tsx" ? id : null,
    load: id => id === "/media-fixture.tsx" ? source : null, configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, "http://fixture");
      if (url.pathname === "/recover") { denied = false; res.writeHead(204); res.end(); return; }
      if (url.pathname === "/__opencraft_files") {
        const path = url.searchParams.get("path");
        if (path === "/fixture/flaky.png" && ++flakyReads <= 4) { res.writeHead(503); res.end(); return; }
        if (path === "/fixture/denied.png") deniedRequests++;
        if (path === "/fixture/denied.png" && denied) { res.writeHead(403); res.end("forbidden"); }
        else if (path === "/fixture/html.png") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Sign in</title>"); }
        else { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(png); }
        return;
      }
      if (url.pathname === "/direct.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(png); return; }
      if (url.pathname !== "/") return next();
      res.setHeader("content-type", "text/html");
      if (url.searchParams.has("csp")) res.setHeader("content-security-policy", "img-src 'none'");
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script id="opencraft-deployment-config" type="application/json">{"hosts":[],"builtinAgents":false,"hypernode":false,"fileDownloads":true}</script><div id="root"></div><script type="module" src="/media-fixture.tsx"></script>');
    }); } }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen(); browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/`);
  await page.waitForFunction(() => (window as any).events?.filter((e: any) => e.phase === "decode").length >= 3, { timeout: 60_000 });
  await page.waitForFunction(() => (window as any).events.some((event: any) => event.documentId === "download" && event.phase === "decode" && event.outcome === "ok"));
  assert.equal(flakyReads, 5, "the observed four failed reads recover without a user click");
  assert.match((await page.locator('[data-case="download"] img.chat-markdown-image').getAttribute("src"))!, /^blob:/u);
  assert.ok(await page.evaluate(() => (window as any).events.some((event: any) => event.documentId === "download" && event.phase === "source" && event.transport === "host" && event.readAttempts === 5)));
  const events = await page.evaluate(() => (window as any).events as { documentId: string; phase: string; outcome: string; contentType?: string; httpStatus?: number }[]);
  assert.ok(events.some(e => e.documentId === "blocked" && e.phase === "policy" && e.outcome === "failed"));
  assert.ok(events.some(e => e.documentId === "denied" && e.phase === "source" && e.outcome === "failed" && e.httpStatus === 403));
  assert.ok(events.some(e => e.documentId === "html" && e.phase === "source" && e.outcome === "ok" && e.contentType === "text/html"));
  assert.ok(events.some(e => e.documentId === "html" && e.phase === "decode" && e.outcome === "failed"));
  for (const id of ["valid", "external"]) assert.ok(events.some(e => e.documentId === id && e.phase === "decode" && e.outcome === "ok"));
  assert.equal(await page.locator(".chat-markdown-media-unavailable").count(), 3);
  // A failed read must be retried through the resource owner, retaining denial
  // until the transport itself recovers. Remounting a view alone is insufficient.
  const deniedCase = page.locator('[data-case="denied"]');
  await deniedCase.getByRole("button", { name: "Try again", exact: true }).tap();
  await page.waitForFunction(() => (window as any).events.filter((event: any) => event.documentId === "denied" && event.phase === "source" && event.outcome === "failed").length >= 2);
  assert.equal(deniedRequests, 2);
  assert.equal(await deniedCase.locator(".chat-markdown-media-unavailable").count(), 1);
  await page.evaluate(() => fetch("/recover"));
  await deniedCase.getByRole("button", { name: "Try again", exact: true }).tap();
  await page.waitForFunction(() => (window as any).events.some((event: any) => event.documentId === "denied" && event.phase === "decode" && event.outcome === "ok"));
  assert.equal(deniedRequests, 3);
  assert.equal(await deniedCase.locator(".chat-markdown-media-unavailable").count(), 0);
  await deniedCase.locator("[data-markdown-image-preview-trigger]").tap();
  assert.equal(await page.locator("dialog[open]").count(), 1);
  await page.getByRole("button", { name: "Close image preview", exact: true }).tap();
  const validDecodes = await page.evaluate(() => (window as any).events.filter((event: any) => event.documentId === "valid" && event.phase === "decode" && event.outcome === "ok").length);
  await page.evaluate(() => (window as any).reconnect());
  await page.waitForFunction(previous => (window as any).events.filter((event: any) => event.documentId === "valid" && event.phase === "decode" && event.outcome === "ok").length > previous, validDecodes);
  assert.equal(await page.locator('[data-case="valid"] .chat-markdown-media-placeholder').count(), 0);
  await page.locator('[data-case="valid"] [data-markdown-image-preview-trigger]').tap();
  assert.equal(await page.locator("dialog[open]").count(), 1);
  await page.getByRole("button", { name: "Close image preview", exact: true }).tap();
  await page.screenshot({ path: process.env.OPENCRAFT_MEDIA_DIAGNOSTICS_SCREENSHOT ?? "/tmp/chat-media-diagnostics.png" });
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?csp`);
  await page.waitForFunction(() => (window as any).events?.some((event: any) => event.documentId === "valid" && event.policy === "csp"));
  assert.ok(await page.evaluate(() => (window as any).events.some((event: any) => event.documentId === "valid" && event.policy === "csp")));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scopedDownloadHostPath: true, automaticTransientRecovery: true, flakyReads, connectionGenerationRebind: true, explicitRetry: true, denialPreserved: true, deniedRequests, policy: true, csp: true, http403: true, html200DecodeFailure: true, validImage: true, externalImage: true, touchGallery: true, events }));
} finally { await browser?.close(); await vite.close(); }
