import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {motion, useTransform} from 'motion/react';
import {usePanelFullWidthAnimation} from '/apps/workbench-web/src/components/use-panel-animation.ts';
function Demo(){
 const [full,setFull]=useState(false),[scope,setScope]=useState('one');
 const progress=usePanelFullWidthAnimation(full,scope,true);
 const width=useTransform(progress,p=>300+500*Math.max(0,Math.min(1,p)));
 window.probe=()=>progress.get();
 window.toggle=()=>setFull(v=>!v);
 window.switchScope=()=>{setScope('two');setFull(false);};
 return <motion.div id="panel" style={{width,height:100,background:'gray'}}/>;
}
createRoot(document.getElementById('root')).render(<Demo/>);`;
const vite = await createServer({configFile:false,root:process.cwd(),logLevel:"error",server:{host:"127.0.0.1",port:0},plugins:[{
 name:"full-width-smoke",resolveId:id=>id==="/probe.tsx"?id:null,load:id=>id==="/probe.tsx"?source:null,
 configureServer(server){server.middlewares.use((request,response,next)=>{
  if(request.url!=="/")return next();
  response.setHeader("content-type","text/html");
  response.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>');
 });},
}]});
let browser: any;
try {
 await vite.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:["--no-sandbox"]});
 const page=await browser.newPage();
 const errors:string[]=[];page.on("pageerror",(error:Error)=>errors.push(error.message));
 const url=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
 await page.goto(url);await page.waitForFunction(()=>typeof (window as any).probe==='function');
 assert.equal(await page.evaluate(()=>(window as any).probe()),0);
 await page.evaluate(()=>(window as any).toggle());
 await page.waitForFunction(()=>{const p=(window as any).probe();return p>0.05&&p<0.95;});
 const before=await page.evaluate(()=>(window as any).probe());
 await page.evaluate(()=>(window as any).toggle());
 const after=await page.evaluate(()=>(window as any).probe());
 assert.ok(Math.abs(after-before)<0.3,"reversal must not jump to an endpoint");
 await page.waitForFunction(()=>Math.abs((window as any).probe())<0.0001);
 await page.evaluate(()=>(window as any).toggle());
 await page.waitForFunction(()=>(window as any).probe()>0.1);
 await page.evaluate(()=>(window as any).switchScope());
 await page.waitForFunction(()=>(window as any).probe()===0);
 await page.emulateMedia({reducedMotion:"reduce"});
 await page.reload();await page.waitForFunction(()=>typeof (window as any).probe==='function');
 await page.evaluate(()=>(window as any).toggle());
 await page.waitForFunction(()=>(window as any).probe()===1);
 assert.deepEqual(errors,[]);
 console.log("Full-width motion passed: intermediate frames, reversal, scope reset, reduced motion.");
} finally {await browser?.close();await vite.close();}
