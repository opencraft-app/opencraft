import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "vite";

// Real TerminalPanel + xterm + application CSS. Only the PTY/session boundary
// is synthetic; this test never attaches to a user's terminal or sends shell input.
// Requires an already available agent-browser CLI (npx --no-install).
const execute = promisify(execFile);
const sessionName = `terminal-geometry-${process.pid}`;
const browser = async (...args: string[]) => {
  const { stdout } = await execute("npx", ["--no-install", "agent-browser", "--session", sessionName, "--json", ...args],
    { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  const result = JSON.parse(stdout);
  if (!result.success) throw new Error(result.error ?? "Browser operation failed");
  return result.data;
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createWorkbenchPanelReactRuntime} from '/packages/workbench-panels-react/src/index.ts';
import {WorkbenchTerminalSessionRegistry,createTerminalWorkbenchPanelPlugin} from '/plugins/terminal/src/index.tsx';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const callbacks=new Set();
let state={revision:0,hostId:'fixture',processId:'fixture',connectionGeneration:1,phase:'running',output:[],exitCode:null,error:null};
let grid=null, sizes=[], sequence=0;
const session={processId:'fixture',getSnapshot:()=>state,subscribe:fn=>{callbacks.add(fn);return()=>callbacks.delete(fn)},
  resize:async(cols,rows)=>{grid={cols,rows};sizes.push(grid)},write:async()=>{throw new Error('No shell input in this fixture')},
  terminate:async()=>{},dispose:async()=>{}};
const registry=new WorkbenchTerminalSessionRegistry(()=>({resources:{terminal:{open:()=>session}}}));
const resource=registry.open({hostId:'fixture',cwd:null});
const runtime=await createWorkbenchPanelReactRuntime();
await runtime.install(createTerminalWorkbenchPanelPlugin(registry));
const Panel=runtime.renderers.resolve(runtime.renderers.getSnapshot(),'terminal');
const root=createRoot(document.getElementById('root'));
let epoch=0;
const mount=()=>{grid=null;root.render(<Panel key={++epoch} ownerId="fixture" presentationId="fixture" tab={{id:'fixture',kind:'terminal',region:'right',title:'Terminal',resource}}/>)};
const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
const until=async fn=>{const deadline=performance.now()+8000;while(!fn()){if(performance.now()>deadline)throw new Error('Geometry did not settle');await new Promise(r=>setTimeout(r,10))}};
const write=text=>{state={...state,revision:state.revision+1,output:[...state.output,{sequence:++sequence,deltaBase64:btoa(unescape(encodeURIComponent(text)))}]};for(const fn of callbacks)fn()};
const measure=()=>{
  const screen=document.querySelector('.xterm-screen'),host=document.querySelector('.terminal-panel__host');
  const row=Array.from(document.querySelectorAll('.xterm-rows>div')).find(e=>e.textContent.includes('X'));
  if(!screen||!host||!row)throw new Error('Missing measured terminal');
  const range=document.createRange();range.selectNodeContents(row);
  const cursor=document.querySelector('.xterm-cursor');
  // xterm 5.5 DOM WidthCache measures 32 glyphs with integer offsetWidth:
  // <= 0.5/32 px per cell, plus <= 1px canvas/layout rounding. This is an
  // upstream precision budget, not extra padding or fewer terminal columns.
  return {cols:grid.cols,roundingBudget:1+grid.cols/64,screen:screen.getBoundingClientRect().width,host:host.getBoundingClientRect().width,
    overflow:range.getBoundingClientRect().right-screen.getBoundingClientRect().right,
    cursorOverflow:cursor?cursor.getBoundingClientRect().right-screen.getBoundingClientRect().right:null,
    boundaryTracking:getComputedStyle(host).letterSpacing,rowTracking:getComputedStyle(row).letterSpacing};
};
const paint=async(wide=false)=>{
  await until(()=>grid&&document.querySelector('.xterm-rows'));
  await frame();
  const text=wide?'界'.repeat(Math.floor((grid.cols-1)/2))+'l'.repeat((grid.cols-1)%2)+'X':'l'.repeat(grid.cols-1)+'X';
  write('\\x1b[2J\\x1b[H'+text);
  await until(()=>Array.from(document.querySelectorAll('.xterm-rows>div')).some(e=>e.textContent.includes('X')));
  await frame();return measure();
};
window.runTerminalGeometry=async()=>{
  await document.fonts.ready;
  const results=[];
  // Negative control: deliberately restore the old inheritance to prove this
  // matrix detects actual text overflow, not merely screen <= host.
  document.body.style.letterSpacing='-0.14px';document.documentElement.dataset.legacyTracking='true';
  mount();const legacy=await paint();
  if(legacy.overflow<10)throw new Error('Negative control failed: '+JSON.stringify(legacy));
  delete document.documentElement.dataset.legacyTracking;mount();
  for(const tracking of ['-0.14px','1px'])for(const width of [1185,699,360]){
    document.body.style.letterSpacing=tracking;document.body.style.wordSpacing='2px';document.body.style.textTransform='uppercase';
    document.getElementById('root').style.width=width+'px';await frame();
    for(const wide of [false,true]){
      const result=await paint(wide);results.push({...result,tracking,width,wide});
      if(result.overflow>result.roundingBudget||result.screen>result.host+1||result.cursorOverflow===null||result.cursorOverflow>result.roundingBudget)
        throw new Error('Terminal grid overflow: '+JSON.stringify(results.at(-1)));
    }
  }
  const element=document.querySelector('.xterm');
  document.getElementById('root').style.display='none';await frame();
  document.getElementById('root').style.width='900px';document.getElementById('root').style.display='block';await frame();
  if(document.querySelector('.xterm')!==element)throw new Error('Visibility recreated terminal');
  results.push({...await paint(),case:'reshown'});
  document.documentElement.style.setProperty('--font-family-mono','Courier New, monospace');await document.fonts.ready;await frame();
  results.push({...await paint(),case:'font-change'});
  for(const result of results)if(result.overflow>result.roundingBudget||result.cursorOverflow>result.roundingBudget)throw new Error('Post-invalidation overflow: '+JSON.stringify(result));
  return {dpr:devicePixelRatio,legacy,results,resizeCount:sizes.length};
};
`;
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "terminal-geometry-probe",
    resolveId: id => id === "/terminal-probe.tsx" ? id : null,
    load: id => id === "/terminal-probe.tsx" ? entry : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<style>#root{width:1185px;height:360px}html[data-legacy-tracking=true] .terminal-panel__host{letter-spacing:inherit}</style><div id="root"></div><script type="module" src="/terminal-probe.tsx"></script>');
    }); },
  }] });
try {
  await server.listen();
  const port = (server.httpServer!.address() as { port: number }).port;
  for (const dpr of [1, 2]) {
    await browser("set", "viewport", "1440", "960", String(dpr));
    await browser("open", `http://127.0.0.1:${port}`);
    await browser("wait", "--fn", "typeof window.runTerminalGeometry === 'function'");
    const { result } = await browser("eval", "window.runTerminalGeometry()");
    assert.equal(result.dpr, dpr);
    assert.equal(result.results.length, 14);
    console.log(JSON.stringify(result));
  }
  console.log("PASS: real TerminalPanel character/cursor grid, tracking isolation, resize, wide cells, font change and visibility");
} finally {
  await browser("close").catch(() => undefined);
  await server.close();
}
