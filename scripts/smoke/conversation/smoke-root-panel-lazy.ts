import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createWorkbenchWebConfig } from '../../../apps/workbench-web/vite.config';
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/root-panel-lazy-smoke';
await mkdir(output, { recursive: true });
const hosts = JSON.stringify([{ hostId: 'opencraft-server', label: 'Recovery fixture', kind: 'local', url: '/appserver' }]);
const common = createWorkbenchWebConfig({ mode: 'development', command: 'serve' }, { hyperNode: false, builtinAgents: false });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', cacheDir: 'node_modules/.vite-root-panel-lazy',
  optimizeDeps: { ...common.optimizeDeps, include: [...common.optimizeDeps?.include ?? [],
    '@opencraft/browser-core/presentation', '@opencraft/browser-core/metadata-sync', '@opencraft/browser-core/metadata-merge'] },
  define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES': '""',
    'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN': '"false"',
    'import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST': '"true"', 'import.meta.env.VITE_APPSERVER_HOSTS_JSON': JSON.stringify(hosts),
  }, esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] }, server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'auth-expiry-workbench', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split('?')[0] === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/root-panel-lazy-workbench.tsx"></script></body></html>'); }
    else next();
  }); } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  const rows: unknown[] = [];
  for (const width of [390,1280]) {
    const context = await browser.newContext({viewport:{width,height:844},hasTouch:width===390,isMobile:width===390});
    let authenticated = true, allocations = 0;
    const wires = new Set<any>();
    await context.route('**/__opencraft*/**', async (route: any) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/__opencraft_access/admission') await route.fulfill({ status: authenticated ? 204 : 401, body: authenticated ? '' : '{"error":"authentication_required"}', contentType: 'application/json' });
      else await route.fulfill({ status: 404, body: '{}' });
    });
    await context.routeWebSocket('**/apphost?*', (wire: any) => {
      allocations++; wires.add(wire);
      wire.onMessage((raw: string) => {
        const frame = JSON.parse(raw);
        if (frame.type === 'hello') wire.send(JSON.stringify({ type: 'ready', protocolVersion: 2, services: ['appserver'], capabilities: { connectionProbe: true } }));
        else if (frame.requestId) {
          wire.send(JSON.stringify({ type: 'response', requestId: frame.requestId, ok: true, result: frame.type === 'host/connect' ? { hostId: frame.hostId, generation: 1 } : null }));
          if (frame.type !== 'host/send') return;
          const request = JSON.parse(frame.frame); if (request.id === undefined) return;
          const result = request.method === 'initialize' ? { codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux', userAgent: 'auth-smoke' }
            : request.method.endsWith('/list') ? { data: [], nextCursor: null } : undefined;
          const reply = result === undefined ? { id: request.id, error: { code: -32601, message: 'Unsupported synthetic engine method' } } : { id: request.id, result };
          wire.send(JSON.stringify({ type: 'host/frame', hostId: frame.hostId, generation: frame.generation, frame: JSON.stringify(reply) }));
        }
      });
    });
    let requests=0; let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    await context.route('**/apps/workbench-web/src/components/right-panel.tsx*',async route=>{requests++;await held;await route.continue();});
    const page=await context.newPage(),errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript('window.__name=value=>value');
    try {
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/`,{timeout:90000});
      await page.waitForFunction(()=>(window as any).authRecovery?.snapshot().phase==='ready',undefined,{timeout:60000});
      const editor=page.locator('[contenteditable="true"]').first();await editor.fill('Keep root panel draft');
      await editor.evaluate(node=>{(window as any).rootPanelEditor=node;});
      assert.equal(requests,0,'never-opened empty root does not request the panel renderer');
      await page.evaluate(()=>(window as any).rootPanelProof.open());
      await page.locator('.right-panel-empty[role="status"]').waitFor();
      assert.equal(requests,1);assert.equal(await page.getByTitle('Resident root panel').count(),0);
      await page.evaluate(()=>(window as any).rootPanelProof.hide());
      const arrived=page.waitForResponse(response=>response.url().includes('/components/right-panel.tsx'));
      release();await arrived;
      await page.evaluate("import('/apps/workbench-web/src/components/right-panel.tsx').then(()=>true)");
      await page.waitForFunction(()=>(window as any).rootPanelProof.state().loads===1);
      await page.evaluate(()=>{const frame=document.querySelector<HTMLIFrameElement>('iframe[title="Resident root panel"]')!;
        (window as any).residentRootFrame=frame;(window as any).residentRootWindow=frame.contentWindow;
        (window as any).residentRootToken=(frame.contentWindow as any).residencyToken;});
      for(let i=0;i<3;i++) {
        await page.evaluate(()=>(window as any).rootPanelProof.show());
        await page.getByTitle('Resident root panel').waitFor();
        await page.evaluate(()=>(window as any).rootPanelProof.hide());
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(()=>{const frame=document.querySelector<HTMLIFrameElement>('iframe[title="Resident root panel"]');return frame===(window as any).residentRootFrame&&frame?.contentWindow===(window as any).residentRootWindow&&(frame?.contentWindow as any)?.residencyToken===(window as any).residentRootToken;}),true);
      }
      assert.deepEqual(await page.evaluate(()=>(window as any).rootPanelProof.state()),{mounts:1,unmounts:0,loads:1,tabs:1});
      assert.equal(await editor.evaluate(node=>node===(window as any).rootPanelEditor),true);assert.equal(await editor.innerText(),'Keep root panel draft');
      await page.evaluate(()=>(window as any).rootPanelProof.close());
      await page.waitForFunction(()=>(window as any).rootPanelProof.state().unmounts===1);
      await page.evaluate(()=>(window as any).rootPanelProof.open('resident-two'));
      await page.waitForFunction(()=>(window as any).rootPanelProof.state().loads===2);
      assert.equal(requests,1,'empty after a visit never resets the lazy module owner');
      assert.deepEqual(errors,[]);rows.push({width,rendererRequests:requests,retainedFrameAndWindow:true,draftRetained:true,resourceReleasedOnTabClose:true,pageErrors:errors});
      await page.screenshot({path:`${output}/${width}.png`});
    } catch(error) {console.error('root panel lazy failure',{width,requests,errors},await page.locator('body').innerText());await page.screenshot({path:`${output}/failure-${width}.png`});throw error;}
    finally{release();await context.close();}
  }
  await writeFile(`${output}/results.json`,JSON.stringify({scope:'Actual WorkbenchRoot/App/PanelService with synthetic resident iframe and AppHost. Proves DOM/frame custody, not real remote Native execution.',rows},null,2));
  console.log('PASS root lazy panel retention',JSON.stringify(rows));
}finally{await browser?.close();await vite.close();}
