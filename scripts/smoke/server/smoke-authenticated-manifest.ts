import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { pluginBranding } from "../../../apps/workbench-web/plugin-branding.vite";
// The managed site does not advertise installation. Exercise the platform's optional manifest
// support through a synthetic product, without re-enabling the managed descriptor.
const fixtureRoot = await mkdtemp(join(tmpdir(), 'opencraft-manifest-fixture-'));
const fixturePlugin = join(fixtureRoot, 'plugins', 'fixture');
await mkdir(join(fixturePlugin, 'public'), {recursive: true});
await writeFile(join(fixturePlugin, 'package.json'), JSON.stringify({opencraft: {extensionId:'fixture',webBranding:'branding.json',webAssets:'public'}}));
await writeFile(join(fixturePlugin, 'branding.json'), JSON.stringify({id:'fixture',name:'Fixture',manifestUrl:'/plugin-assets/fixture/app.webmanifest'}));
const manifest = JSON.stringify({id:'/',name:'Fixture',short_name:'Fixture',start_url:'/',scope:'/',display:'standalone'});
await writeFile(join(fixturePlugin, 'public', 'app.webmanifest'), manifest);
const plugin = pluginBranding(fixtureRoot, ['fixture']);
const output = (plugin.transformIndexHtml as Function)('<html><head><title>OpenCraft</title></head><body></body></html>');
const tag = output.tags.find((tag: any) => tag.attrs.rel === 'manifest');
const attrs = (values: Record<string,string>) => Object.entries(values).map(([k,v]) => `${k}="${v}"`).join(' ');
const bundled = await build({ stdin: { contents: `import {applyApplicationBranding} from "./apps/workbench-web/src/runtime/application-branding.ts";applyApplicationBranding(document,{id:"fixture",name:"Fixture",markUrl:"/icon.svg",manifestUrl:${JSON.stringify(tag.attrs.href)}});`, resolveDir: resolve('.') }, bundle: true, format: 'esm', platform: 'browser', write: false });
let redirects = 0, authenticatedReads = 0;
const login = createServer((_,res) => { res.setHeader('Content-Type','text/html');res.end('<title>Gateway login fixture</title>'); });
login.listen(0,'127.0.0.1');await once(login,'listening');
const server = createServer((req,res) => {
  if (req.url === '/runtime.js') {res.setHeader('Content-Type','text/javascript');res.end(bundled.outputFiles[0]!.text);return;}
  if (req.url === tag.attrs.href) {
    if (!req.headers.cookie?.includes('fixture_gateway=admitted')) { redirects++;res.writeHead(302,{location:`http://127.0.0.1:${(login.address() as any).port}/signin`});res.end();return; }
    authenticatedReads++;res.setHeader('Content-Type','application/manifest+json');res.setHeader('Cache-Control','no-store');res.end(manifest);return;
  }
  res.setHeader('Content-Type','text/html');res.setHeader('Set-Cookie','fixture_gateway=admitted; HttpOnly; SameSite=Lax; Path=/');
  let html = output.html;
  if (req.url === '/runtime') html=html.replace('</head>','<script type="module" src="/runtime.js"></script></head>');
  else { const selected={...tag.attrs};if(req.url === '/negative') delete selected.crossorigin;html=html.replace('</head>',`<link ${attrs(selected)}></head>`); }
  res.end(html);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://localhost:${(server.address() as any).port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  for (const route of ['/negative','/initial','/runtime']) {
    const context=await browser.newContext(),page=await context.newPage();
    await page.goto(base+route);await page.waitForFunction(()=>Boolean(document.querySelector('link[rel="manifest"]')));
    const cdp=await context.newCDPSession(page);const result=await cdp.send('Page.getAppManifest');
    console.log(JSON.stringify({route,url:result.url,errors:result.errors,dataLength:result.data?.length,redirects,authenticatedReads}));
    if(route==='/negative') {assert.equal(result.data, '');assert.ok(redirects>0);assert.equal(authenticatedReads,0);}
    else {assert.deepEqual(result.errors,[]);assert.equal(JSON.parse(result.data).name,'Fixture');assert.equal(await page.locator('link[rel="manifest"]').getAttribute('crossorigin'),'use-credentials');}
    await context.close();
  }
  assert.ok(authenticatedReads>=2);
  console.log(JSON.stringify({browser:'Chromium',negativeRedirectsToLogin:true,initialManifestAuthenticated:true,runtimeManifestAuthenticated:true,authenticatedReads,redirects}));
} finally {await browser.close();server.closeAllConnections();login.closeAllConnections();server.close();login.close();await rm(fixtureRoot,{recursive:true,force:true});}
