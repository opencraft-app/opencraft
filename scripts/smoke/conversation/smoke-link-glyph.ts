import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { compile } from 'sass';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright';

// Actual resource-link renderer and styles; only network image outcomes are fixtures.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/link-glyph');
await mkdir(output, { recursive: true });
const built = await build({ stdin: { contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalUrlLink } from './packages/chat-render-web/src/renderers/resource-link/resource-link';
function App(){const [target,setTarget]=useState('https://first.example/page');window.setTarget=setTarget;
return <p>控制台 <ExternalUrlLink context={{streaming:false}} decision={{kind:'external',allowed:true,target}} label="TokenHub" title="TokenHub" /> 恢复后继续。</p>}
createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: process.cwd(), loader: 'tsx' },
 bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.scss': 'empty', '.css': 'empty' } });
const css = compile('packages/chat-render-web/src/renderers/resource-link/resource-link.scss', { loadPaths: ['node_modules'], importers: [{ findFileUrl(url) { if (!url.startsWith('@')) return null; return pathToFileURL(createRequire(import.meta.url).resolve(url)); } }] }).css;
const server = createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?built.outputFiles[0]!.contents:`<!doctype html><style>${css}body{font:20px sans-serif;color:#182c43;background:#f4f8ff;padding:24px}body.dark{color:#eee;background:#20242a}</style><div id="root"></div><script type="module" src="/app.js"></script>`);});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const profile = await mkdtemp(join(tmpdir(),'link-glyph-'));
await writeFile(join(profile,'app.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname);app.whenReady().then(()=>new BrowserWindow({show:true,width:390,height:844}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;delete env.DISPLAY;
const browser=await _electron.launch({executablePath:process.env.OPENCRAFT_ELECTRON_EXECUTABLE??'/opt/opencraft/runtime/browser/electron/electron',args:['--ozone-platform=headless','--ozone-override-screen-size=1600,1200','--disable-dev-shm-usage','--disable-gpu',join(profile,'app.cjs')],env});
try {
 const page=await browser.firstWindow();const errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.setDefaultTimeout(10000);
 
 await page.route("https://**/*",route=>route.abort());
 await page.goto(`http://127.0.0.1:${(server.address() as any).port}`, {waitUntil:"domcontentloaded"});
 const icon=page.locator('.chat-external-link__icon');
 const fallback=icon.locator('.chat-external-link__icon-fallback');
 await fallback.waitFor();const bounds=await icon.boundingBox();
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M4 18a8 8 0 0 1 16-4a6 6 0 1 1 4 12H8a4 4 0 0 1-4-8" fill="none" stroke="#00a4ff" stroke-width="3"/></svg>';
 await page.waitForFunction(()=>document.querySelectorAll('.chat-external-link__icon img').length===2);
 await page.waitForTimeout(100);
 // First success owns presentation; a transparent center must show only page background.
 await icon.locator('img').nth(0).evaluate((img,svg)=>(img as HTMLImageElement).src='data:image/svg+xml,'+encodeURIComponent(svg),svg);
 await icon.locator('img.is-loaded').waitFor();assert.equal(await fallback.count(),0);
 const selected=await icon.locator('img.is-loaded').getAttribute('src');
 await icon.locator('img').nth(1).evaluate((img,svg)=>(img as HTMLImageElement).src='data:image/svg+xml,'+encodeURIComponent(svg),svg);await page.waitForTimeout(60);
 assert.equal(await icon.locator('img.is-loaded').count(),1);assert.equal(await icon.locator('img.is-loaded').getAttribute('src'),selected);
 assert.deepEqual(await icon.boundingBox(),bounds);
 for(const dark of [false,true]){await page.evaluate(d=>document.body.classList.toggle('dark',d),dark);await page.screenshot({path:join(output,dark?'dark.png':'light.png')});}
 // Losing the selected source promotes another ready candidate; all failures restore fallback.
 await icon.locator('img.is-loaded').dispatchEvent('error');assert.equal(await fallback.count(),0);
 await icon.locator('img.is-loaded').dispatchEvent('error');await fallback.waitFor();
 // A target change transfers ownership synchronously, including A -> B -> A.
 await page.evaluate(()=>{(window as any).oldImage=document.querySelector('.chat-external-link__icon img');(window as any).setTarget('https://second.example/page');});
 await page.waitForFunction(()=>document.querySelector('a')?.getAttribute('href')==='https://second.example/page');
 await page.evaluate(()=>(window as any).oldImage.dispatchEvent(new Event('load')));
 assert.equal(await icon.locator('img.is-loaded').count(),0);await fallback.waitFor();
 await page.evaluate(()=>(window as any).setTarget('https://first.example/page'));
 await page.waitForFunction(()=>document.querySelector('a')?.getAttribute('href')==='https://first.example/page');
 await page.evaluate(()=>(window as any).oldImage.dispatchEvent(new Event('load')));
 assert.equal(await icon.locator('img.is-loaded').count(),0);await fallback.waitFor();
 assert.deepEqual(errors,[]);console.log('PASS transparent glyph, exclusive fallback, stable first success, failure promotion, target ownership and ABA stale callback');
} finally {await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
