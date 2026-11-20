import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteBrowserService } from '../../remote-browser-service.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Two independent clients with real metadata WebSocket, Workbench runtime,
// panel service, RightPanel and TerminalPanel. The synthetic process owner
// lives outside the page; its pruned-catalog path is intentional. Production
// Hosts may retain exited records/output, covered by the owner unit test.
// No production credentials, shells or user terminals are accessed.
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '/tmp/terminal-refresh';
await mkdir(output, { recursive: true });
const negative = process.env.OPENCRAFT_TERMINAL_REFRESH_NEGATIVE === '1';
const directory = await mkdtemp(join(tmpdir(), 'resource-directory-sync-'));
const metadata = new RemoteBrowserService({root:directory,dataDirectory:directory,ownerConnector:null});
const actor = (headers: any) => /(?:^|;\s*)fixtureActor=([^;]+)/.exec(headers.cookie ?? '')?.[1] ?? 'missing';
const processes = new Map<string, any>();
let spawns = 0, kills = 0;
const requests: { method: string; params: any }[] = [];
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  optimizeDeps: { include: ['@opencraft/browser-core/metadata-limits', '@opencraft/browser-core/metadata-merge'] },
  resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-terminal-refresh',
  esbuild: { jsx: 'automatic', target: 'esnext' }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'terminal-refresh-fixture', enforce: 'pre',
    transform(code, id) {
      if (negative && id.endsWith('/packages/workbench-runtime/src/appserver-runtime.ts')) {
        assert.ok(code.includes('terminalController.list(scope)'));
        return code.replace('terminalController.list(scope)', 'terminalController.list()');
      }
    }, configureServer(s) {
    s.httpServer!.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?')[0] !== '/__opencraft_browser/stream') return;
      const ownerId=actor(req.headers);metadata.upgrade(req,socket,head,{ownerId,authorize(){assert.notEqual(ownerId,'missing');},track(){}});
    });
    s.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-refresh.tsx"></script>');
        return;
      }
      if (req.url !== '/terminal-refresh/rpc') return next();
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const owner = actor(req.headers);
      const { request, mode, draft } = JSON.parse(Buffer.concat(chunks).toString());
      const { method, params = {} } = request;
      requests.push({ method, params });
      let result: any = method.endsWith('/list') ? { data: [], nextCursor: null } : {};
      const notifications: any[] = [];
      let error: any;
      if (method === 'initialize') result = { userAgent: 'refresh-fixture', capabilities: { extensions:
        mode === 'legacy' ? { 'opencraft/terminal-restore': { version: 1 } } : { 'opencraft/terminal': { version: 1, available: true, recovery: true } } } };
      if (method === 'process/spawn') {
        spawns++;
        const process = { owner, processHandle: params.processHandle, phase: 'running', exitCode: null,
          context: { resourceOwnerId: params.resourceOwnerId, threadId: params.threadId, projectId: params.projectId, cwd: params.cwd, shell: '/bin/bash' },
          output: [{ sequence: 1, stream: 'stdout', deltaBase64: Buffer.from('Original terminal before refresh\r\n$ ').toString('base64') }], nextSequence: 2, truncated: false };
        processes.set(params.processHandle, process);
        notifications.push({ method: 'process/outputDelta', params: { processHandle: params.processHandle, ...process.output[0] } });
      }
      if (method === 'process/list') {
        await new Promise(resolve => setTimeout(resolve, 100));
        result = { processes: [...processes.values()].filter(p => p.owner === owner).filter(p => draft ? (!params.threadId || p.context.threadId === params.threadId) && (!params.projectId || p.context.projectId === params.projectId) : p.context.threadId === params.threadId && p.context.projectId === params.projectId) };
      }
      if (method === 'process/attach') {
        const process = processes.get(params.processHandle);
        if (!process || process.owner !== owner || params.threadId !== process.context.threadId || params.projectId !== process.context.projectId) error = { code: -32602, message: 'Terminal scope missing' };
        else result = process;
      }
      if (method === 'process/kill') { kills++; processes.delete(params.processHandle); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: error ? { error } : { result }, notifications }));
    });
  } }],
});

let browser;
try {
 await server.listen();browser=await chromium.launch({headless:true});const origin=server.resolvedUrls!.local[0];
 for(const touch of [true,false]){
  processes.clear();spawns=0;kills=0;const errors:string[]=[];
  async function device(touch:boolean,actor='one'){
   const context=await browser!.newContext({viewport:{width:touch?390:1280,height:844},hasTouch:touch,isMobile:touch});
   await context.addCookies([{name:'fixtureActor',value:actor,url:origin}]);
   await context.addInitScript(({touch})=>{(window as any).__name=(x:any)=>x;document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.uiDensity=touch?'touch':'compact');},{touch});
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'?sync=1');await page.getByTestId('new-terminal').waitFor();return{context,page};
  }
  const a=await device(touch),b=await device(!touch),other=await device(false,'other');
  try{
   await a.page.getByTestId('new-terminal').click();await b.page.waitForFunction(()=>(window as any).fixture.inspect().ids.length===1);
   await b.page.getByTestId('show-tools').click();await b.page.locator('.xterm').waitFor();
   const original=await b.page.evaluate(()=>(window as any).fixture.inspect());assert.equal(original.ids.length,1);
   assert.equal((await other.page.evaluate(()=>(window as any).fixture.inspect())).ids.length,0);
   const selected = await b.page.evaluate(() => {const f=(window as any).fixture;return f.runtime.panels.getOwnerSnapshot(f.ownerId).right.activeTabId;});
   await b.context.setOffline(true);await b.page.evaluate(()=>(window as any).fixture.disconnectMetadata());
   await a.page.evaluate(() => {const f=(window as any).fixture;f.runtime.panels.dispatch(f.ownerId,{type:'set-region-open',region:'right',open:false});});
   await a.page.getByTestId('new-terminal').click();await a.page.waitForFunction(()=>(window as any).fixture.inspect().ids.length===2);
   await b.context.setOffline(false);await b.page.waitForFunction(()=>(window as any).fixture.inspect().ids.length===2);
   assert.equal(spawns,2);assert.equal(kills,0);
   assert.equal(await b.page.evaluate(() => {const f=(window as any).fixture;return f.runtime.panels.getOwnerSnapshot(f.ownerId).right.activeTabId;}), selected, 'remote discovery must not steal the selected tab');
   await a.page.evaluate(() => {const f=(window as any).fixture;f.registry.release(f.inspect().ids[0]);});
   await b.page.waitForFunction(()=>(window as any).fixture.inspect().ids.length===1);assert.equal(kills,1);
   // No signal emitted: the equal-root anti-entropy callback still re-reads Host truth.
   const existing=[...processes.values()][0];processes.set('external-no-hint',{...existing,processHandle:'external-no-hint'});
   await b.page.evaluate(()=>(window as any).fixture.reconcileMetadata());await b.page.waitForFunction(()=>(window as any).fixture.inspect().ids.length===2);
   await b.page.screenshot({path:output+'/'+(touch?'pointer':'touch')+'-resource-sync.png'});
   assert.equal(spawns,2);assert.equal(kills,1);assert.deepEqual(errors,[]);console.log('PASS shared terminal directory touchCreator='+touch+'; push, missed push, equal root, account isolation, no duplicate spawn/kill');
  }finally{await a.context.close();await b.context.close();await other.context.close();}
 }
 await writeFile(output+'/resource-directory-result.json',JSON.stringify({twoDirections:true,syntheticNativeOwner:true,realWebSocketMetadata:true,missedPush:true,equalRootAuthoritativeRefresh:true,accountIsolation:true}));
}finally{await browser?.close();await server.close();await metadata.close();await rm(directory,{recursive:true,force:true});}
