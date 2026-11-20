import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const root=process.cwd(),output=resolve(process.env.OPENCRAFT_AVATAR_OUTPUT??'.local/avatar-loading');
const source=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{renderToStaticMarkup}from'react-dom/server';import{AvatarImage}from'@opencraft/extension-react';
window.avatarMarkup=src=>renderToStaticMarkup(<AvatarImage src={src} fallback={<span data-fallback>Default portrait</span>}/>);function Fixture(){const[state,set]=useState({src:null,show:false,key:0});window.avatarFixture={set:value=>flushSync(()=>set(s=>({...s,...value}))),frames:[]};return <div id="tile" style={{width:40,height:40,background:'rgb(240,240,240)'}}>{state.show&&<AvatarImage key={state.key} src={state.src} fallback={<span data-fallback>Default portrait</span>}/>}</div>};createRoot(document.getElementById('root')).render(<Fixture/>);
window.recordAvatarFrames=()=>{window.avatarFrames=[];window.recording=true;const frame=()=>{if(!window.recording)return;const tile=document.getElementById('tile'),img=tile?.querySelector('img'),r=tile?.getBoundingClientRect();window.avatarFrames.push({fallback:!!tile?.querySelector('[data-fallback]'),state:img?.dataset.avatarState,visible:!!img&&getComputedStyle(img).visibility!=='hidden'&&img.naturalWidth>0,src:img?.getAttribute('src'),width:r?.width,height:r?.height});requestAnimationFrame(frame)};requestAnimationFrame(frame)};`;
let retries=0;
const server=await createServer({root,configFile:false,cacheDir:output+'/vite',publicDir:false,logLevel:'error',resolve:{dedupe:['react','react-dom']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['react','react-dom/client','react-dom','react/jsx-runtime']},plugins:[{name:'avatar-loading',resolveId:id=>id==='/fixture.tsx'?id:null,load:id=>id==='/fixture.tsx'?source:null,configureServer(vite){vite.middlewares.use((req,res,next)=>{
 if(req.url?.startsWith('/portrait/')){if(req.url.includes('failure')||(req.url.includes('retry')&&retries++===0)){res.setHeader('cache-control','no-store');res.writeHead(404).end();return}res.setHeader('cache-control','public, max-age=600');res.setHeader('content-type','image/svg+xml');setTimeout(()=>res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#567b9e"/></svg>'),req.url.includes('slow')?200:0);return}
 if(!req.headers.accept?.includes('text/html'))return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>img{width:100%;height:100%;object-fit:cover}</style><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
 })}}]});let browser;
const results=[];
try{await mkdir(output,{recursive:true});await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox']});
for(const touch of [true,false]){
 retries=0;const context=await browser.newContext({viewport:{width:touch?390:1280,height:900},hasTouch:touch,isMobile:touch}),page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.resolvedUrls!.local[0]!);await page.waitForFunction(()=>!!(window as any).avatarFixture);
 const set=async(value:Record<string,unknown>)=>page.evaluate(v=>(window as any).avatarFixture.set(v),value);
 const loaded=()=>page.waitForFunction(()=>document.querySelector<HTMLImageElement>('#tile img')?.naturalWidth!>0&&document.querySelector<HTMLImageElement>('#tile img')!.style.visibility!=='hidden');
 const start=(value:Record<string,unknown>)=>page.evaluate(v=>{(window as any).recordAvatarFrames();(window as any).avatarFixture.set(v);},value);const frames=()=>page.evaluate(()=>{(window as any).recording=false;return (window as any).avatarFrames as {fallback:boolean;visible:boolean;src:string;width:number;height:number}[]});
 await set({src:null,show:true});assert.equal(await page.locator('[data-fallback]').count(),1,'unresolved identity retains default');
 await start({src:'/portrait/slow-a.svg'});await loaded();await page.waitForTimeout(60);const cold=await frames();assert.ok(cold.length>3);assert.ok(cold.every(f=>!f.fallback&&f.width===40&&f.height===40),'loading must not flash default or alter geometry');
 await set({show:false});await start({show:true,key:1});await loaded();await page.waitForTimeout(60);const remount=await frames();assert.ok(remount.length>0);assert.ok(remount.every(f=>!f.fallback&&f.visible),'known portrait must paint directly after remount');
 // Browser cache already warm, but no successful React instance has seen this URL.
 await page.evaluate(async()=>{const i=new Image();i.src='/portrait/predecoded.svg';await i.decode()});await start({src:'/portrait/predecoded.svg'});await loaded();await page.waitForTimeout(60);const browserWarm=await frames();assert.ok(browserWarm.every(f=>!f.fallback&&f.visible),'complete browser-cached photo must settle before paint');
 await start({src:'/portrait/slow-b.svg'});await loaded();await page.waitForTimeout(40);const changed=await frames();assert.ok(changed.every(f=>!f.fallback&&f.src==='/portrait/slow-b.svg'),'URL change cannot show stale identity or default');
 assert.ok((await page.evaluate(()=>(window as any).avatarMarkup('/portrait/slow-b.svg'))).includes('style="visibility:hidden"'),'browser readiness is never guessed during server rendering');
 const inline='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>');
 await set({src:inline});await loaded();assert.ok((await page.evaluate(src=>(window as any).avatarMarkup(src),inline)).includes('style="visibility:hidden"'),'inline image bytes must not be retained as readiness keys');
 const long='/portrait/long.svg?padding='+'a'.repeat(5000);await set({src:long});await loaded();assert.ok((await page.evaluate(src=>(window as any).avatarMarkup(src),long)).includes('style="visibility:hidden"'),'readiness keys have a length bound');
 await set({src:'/portrait/failure.svg'});await page.locator('[data-fallback]').waitFor();assert.equal(await page.locator('#tile img').count(),0,'failed photos use default without broken image');
 await set({src:'/portrait/retry.svg'});await page.locator('[data-fallback]').waitFor();await set({show:false});await set({show:true,key:2});await loaded();assert.equal(await page.locator('[data-fallback]').count(),0,'failure must not poison later remount retries');
 await set({src:'/portrait/slow-unmounted.svg'});await set({src:null});await page.waitForTimeout(240);assert.equal(await page.locator('[data-fallback]').count(),1);assert.equal(await page.locator('#tile img').count(),0,'late completion cannot replace new identity');
 await page.screenshot({path:output+'/fallback-'+(touch?'touch':'pointer')+'.png'});assert.deepEqual(errors,[]);results.push({touch,coldFrames:cold.length,warmFrames:remount.length,browserWarmFrames:browserWarm.length,stableGeometry:true,noTransientFallback:true,failureAndRetry:true,urlAndLateResultIsolation:true,browserOwnsReadiness:true});await context.close();
}await writeFile(output+'/report.json',JSON.stringify(results,null,2));console.log(JSON.stringify({passed:true,results}));
}finally{await browser?.close();await server.close()}
