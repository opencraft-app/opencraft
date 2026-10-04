import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
import {WebHostProxyBroker} from './apps/workbench-web/src/browser/web-host-proxy-broker.ts';
import {WebBrowserPageRuntime} from './apps/workbench-web/src/browser/web-browser-runtime.ts';
import {WebIframeSurfaceHost} from './apps/workbench-web/src/browser/web-browser-surface-host.ts';
window.evidence={proxyReady:false,documentReady:false,targets:[]};
navigator.serviceWorker.ready.then(()=>window.evidence.documentReady=true);
const broker=new WebHostProxyBroker(async(host,url)=>{
  if(host!=='confirmed-host')throw new Error('wrong Host');
  window.evidence.targets.push(url);
  return new Response(url.endsWith('style.css')?'body{color:rgb(12,34,56)}':
    '<html><head><title>Remote preview</title><link rel="stylesheet" href="/style.css"></head><body>Cloud page</body></html>',
    {headers:{'content-type':url.endsWith('style.css')?'text/css':'text/html'}});
});
const surfaces=new WebIframeSurfaceHost(); surfaces.setRoot(document.getElementById('previews'));
const pages=new WebBrowserPageRuntime(surfaces,broker,()=> 'confirmed-host', {getItem:()=>null,setItem:()=>{}});
const live=pages.create({ownerId:'conversation',initialUrl:'http://localhost:3000/'});
pages.prepareSurface(live);
const closed=pages.create({ownerId:'conversation',initialUrl:'http://localhost:3001/'});
pages.prepareSurface(closed); pages.close(closed);
const stopped=pages.create({ownerId:'conversation',initialUrl:'http://localhost:3002/'});
pages.prepareSurface(stopped); pages.stop(stopped);
window.fixture={broker,pages,surfaces,live,stopped};
void broker.start().then(ready=>{window.evidence.proxyReady=ready;window.evidence.proxyAt=performance.now()});
document.querySelector('button').onclick=()=>document.querySelector('output').textContent='chat interactive';
window.evidence.chatAt=performance.now();
` }, bundle: true, write: false, format: "esm", platform: "browser" });
const worker = await readFile("apps/workbench-web/public/opencraft-host-proxy-sw.js");
const bridge = await build({ entryPoints: ["packages/browser-preview-bridge/src/auto-install.ts"],
  bundle: true, write: false, format: "iife", platform: "browser" });
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0].contents);
  } else if (request.url === "/__opencraft/opencraft-host-proxy-sw.js") {
    response.setHeader("content-type", "text/javascript");
    response.setHeader("cache-control", "no-cache");
    setTimeout(() => response.end(worker), 800);
  } else if (request.url === "/__opencraft/preview-bridge.js") {
    response.setHeader("content-type", "text/javascript"); response.end(bridge.outputFiles[0].contents);
  } else {
    response.setHeader("content-type", "text/html");
    response.end('<button>Chat</button><output></output><div id="previews"></div><script type="module" src="/fixture.js"></script>');
  }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [], rawLoopback = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (new URL(request.url()).port === "3000" || /localhost:300[12]/.test(request.url())) rawLoopback.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/agents/chat`);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  assert.equal(await page.locator("output").textContent(), "chat interactive");
  assert.equal(await page.evaluate(() => window.evidence.proxyReady), false);
  await page.waitForFunction(() => window.evidence.proxyReady);
  await page.waitForFunction(() => window.fixture.pages.getSnapshot(window.fixture.live)?.title === "Remote preview");
  const evidence = await page.evaluate(() => ({ ...window.evidence,
    controlled: navigator.serviceWorker.controller !== null,
    stoppedLoading: window.fixture.pages.getSnapshot(window.fixture.stopped)?.navigation.isLoading,
    physical: [...document.querySelectorAll('iframe')].map(frame => frame.getAttribute('src')),
  }));
  assert.equal(evidence.controlled, false);
  assert.equal(evidence.documentReady, false);
  assert.equal(evidence.stoppedLoading, false);
  assert.deepEqual(evidence.targets.sort(), ["http://localhost:3000/", "http://localhost:3000/style.css"]);
  assert.equal(evidence.physical.filter(url => url?.includes("host-proxy")).length, 1);
  assert.deepEqual(rawLoopback, []);
  assert.deepEqual(errors, []);
  console.log("PASS real Chromium + narrow Service Worker + broker + iframe: scoped activation works outside the document scope; pending preview/asset fetch uses the confirmed Host; stopped/closed pages do not resume. Remote HTTP is synthetic, chat button is a responsiveness probe (not Application boot).", JSON.stringify({ chatAt: Math.round(evidence.chatAt), proxyAt: Math.round(evidence.proxyAt) }));
  await page.evaluate(() => { window.fixture.pages.dispose(); window.fixture.surfaces.dispose(); window.fixture.broker.dispose(); });
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
