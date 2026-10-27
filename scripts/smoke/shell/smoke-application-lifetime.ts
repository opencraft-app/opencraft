import assert from "node:assert/strict";
import { createServer } from "vite";
import { WebSocketServer } from "ws";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
// Only the Host wire and optional product composition are synthetic. The
// Application, extensions, storage, browser services and their cleanup are real.
const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => host.once("listening", resolve));
host.on("connection", socket => socket.on("message", data => {
  const request = JSON.parse(String(data));
  if (request.id !== undefined) socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id,
    error: { code: -32601, message: "Fixture Host is deliberately unavailable" } }));
}));
const managedModule = `export default {
 manifest:{manifestVersion:1,id:'lifetime.probe',name:'Lifetime probe',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},
 async activate(api){const control=window.managedLifetimeControl;control.document=await api.storage.open('marker');
 const before=await control.document.read();if(control.save)await control.document.compareAndSet(before.revision,{saved:true});
 return async()=>{control.entered=true;if(control.wait)await control.wait;if(control.fails)throw Error('fixture cleanup failure')};}
};`;
const source = `
import {createWebWorkbenchApplication} from '/apps/workbench-web/src/runtime/web-workbench-application.ts';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct,OPTIONAL_EXTENSION_ID} from '/tests/fixtures/client-product.ts';
initializeAppearanceTheme();
const query=new URLSearchParams(location.search),configured=query.has('host'),managed=query.has('managed'),product=query.has('product');
const productTrace=[];
const options={hostProfileMode:'configured',navigationMode:'memory',...(product?{clientProduct:createSmokeClientProduct(productTrace)}:{}),
 ephemeralHostProfiles:configured?[{hostId:'fixture',displayName:'Unavailable fixture',providerId:'opencraft.websocket',providerConfig:{url:'ws://127.0.0.1:${(host.address() as { port: number }).port}'},providerConfigVersion:1,hostKind:'local',enabled:true,autoConnect:false,includeInSidebar:true,credentialRef:null,transportEndpoint:null,executionLocation:null,workspaceBrowseRoots:[],revision:1}]:[]};
const manifest={manifestVersion:1,id:'lifetime.probe',name:'Lifetime probe',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']};
let application,oldDocument,release,cleanupEntered=false;
const pending=[],finished=[];
const track=promise=>{const index=pending.length;pending.push(promise);finished.push(false);promise.then(()=>{finished[index]=true},()=>{finished[index]=true});};
const messages=error=>[String(error?.message??error),...(error instanceof AggregateError?error.errors.flatMap(messages):[]),...(error instanceof Error&&error.cause?messages(error.cause):[])];
try {
 application=await createWebWorkbenchApplication(options);
 window.applicationProof={mode:application.supervisor.mode,
  productTrace,
  optionalDefault(){const row=application.supervisor.extensionManager.getSnapshot().extensions.find(row=>row.installation.extensionId===OPTIONAL_EXTENSION_ID);return row?{enabled:row.installation.enabled,status:row.status}:null;},
  async hold(fails){const gate=new Promise(resolve=>{release=resolve});
   if(managed){window.managedLifetimeControl={wait:gate,fails,save:true,entered:false};await application.supervisor.extensionManager.installModuleUrl(location.origin+'/managed-lifetime.mjs');oldDocument=window.managedLifetimeControl.document;return;}
   await application.supervisor.extensions.activate({manifest,async activate(api){
   oldDocument=await api.storage.open('marker');const before=await oldDocument.read();await oldDocument.compareAndSet(before.revision,{saved:true});
   return async()=>{cleanupEntered=true;await gate;if(fails)throw Error('fixture cleanup failure')};}});},
  first(){track(application.dispose());},
  async again(){track(application.dispose());track(application.supervisor.dispose());await Promise.resolve();await Promise.resolve();return finished;},
  entered:()=>managed?window.managedLifetimeControl.entered:cleanupEntered,
  async finish(){release();const outcomes=await Promise.allSettled(pending);return outcomes.map(row=>({status:row.status,errors:row.status==='rejected'?messages(row.reason):[]}));},
  async reopen(){let stale=false;try{await oldDocument.read()}catch{stale=true}
   if(managed)window.managedLifetimeControl={fails:false,save:false,entered:false};
   const replacement=await createWebWorkbenchApplication(options);let saved;
   if(managed)saved=(await window.managedLifetimeControl.document.read()).value;
   else await replacement.supervisor.extensions.activate({manifest,async activate(api){saved=(await(await api.storage.open('marker')).read()).value;}});
   await replacement.dispose();return{stale,saved};},
  async late(){try{await application.dispose();return 'fulfilled'}catch{return 'rejected'}},
 };
}catch(error){window.applicationProof={mode:'startup-failed',errors:messages(error),productTrace};}
document.body.dataset.ready='true';`;
const server = await createServer({ configFile: false, cacheDir: ".local/application-lifetime/vite-cache", root: process.cwd(), logLevel: "error",
  define: { "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"',
    "import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST": '"false"' },
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "application-lifetime-proof", resolveId: id => id === "/application-proof.ts" ? id : null,
    load: id => id === "/application-proof.ts" ? source : null,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] === "/") { res.setHeader("Content-Type", "text/html"); res.end('<html><body><script type="module" src="/application-proof.ts"></script></body></html>'); }
      else if (req.url?.startsWith("/managed-lifetime.mjs")) { res.setHeader("Content-Type", "text/javascript"); res.end(managedModule); }
      else next();
    }); },
  }],
});
let browser: any;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const results: unknown[] = [];
  const scenarios = [false, true].flatMap(product => [false, true].flatMap(managed => [false, true].flatMap(configured =>
    [false, true].map(fails => ({ product, managed, configured, fails, startup: false })))));
  for (const product of [false, true]) scenarios.push({ product, managed: false, configured: false, fails: false, startup: true });
  for (const scenario of scenarios) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage(), errors: string[] = [], externalOrigins: string[] = [];
      const requests = new Set<string>();
      page.on("request", request => requests.add(request.url()));
      page.on("requestfinished", request => requests.delete(request.url()));
      page.on("requestfailed", request => requests.delete(request.url()));
      const origin = new URL(server.resolvedUrls!.local[0]).origin;
      await page.route("**/*", (route: any) => {
        const requested = new URL(route.request().url());
        if (requested.origin === origin) return route.continue();
        externalOrigins.push(requested.origin); return route.abort();
      });
      page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("APPLICATION_PAGE_ERROR", error.stack); });
      await page.addInitScript(({ startup }: { startup: boolean }) => {
        const databases: Array<{ name: string; closes: number }> = [], channels: Array<{ name: string; closes: number }> = [];
        const entries = new WeakMap<IDBDatabase, { name: string; closes: number }>();
        const open = IDBFactory.prototype.open, close = IDBDatabase.prototype.close;
        IDBFactory.prototype.open = function (...args: Parameters<IDBFactory["open"]>) {
          if (startup && String(args[0]).includes("host-connections")) throw Error("fixture startup storage failure");
          const request = open.apply(this, args);
          request.addEventListener("success", () => { const row = { name: request.result.name, closes: 0 }; databases.push(row); entries.set(request.result, row); });
          return request;
        };
        IDBDatabase.prototype.close = function () { const row = entries.get(this); if (row) row.closes++; return close.call(this); };
        const Channel = BroadcastChannel;
        window.BroadcastChannel = class extends Channel {
          private readonly row: { name: string; closes: number };
          constructor(name: string) { super(name); this.row = { name, closes: 0 }; channels.push(this.row); }
          close() { this.row.closes++; super.close(); }
        };
        Object.assign(window, { applicationResources: { databases, channels } });
      }, scenario);
      const query = new URLSearchParams();
      if (scenario.configured) query.set("host", "1");
      if (scenario.managed) query.set("managed", "1");
      if (scenario.product) query.set("product", "1");
      await page.goto(server.resolvedUrls!.local[0] + "?" + query);
      await page.waitForSelector('body[data-ready="true"]', { state: "attached", timeout: 60000 }).catch(async error => { console.error("APPLICATION_STARTUP", scenario, errors, [...requests], await page.evaluate(() => ({ ready: document.body.dataset.ready, body: document.body.innerText, html: document.documentElement.outerHTML.slice(0, 1000) }))); throw error; });
      const mode = await page.evaluate(() => (window as any).applicationProof.mode);
      assert.equal(mode, scenario.startup ? "startup-failed" : scenario.configured ? "active" : "hostless",
        await page.evaluate(() => (window as any).applicationProof.errors?.join("\n") ?? "Application should start"));
      if (!scenario.startup) assert.deepEqual(
        await page.evaluate(() => (window as any).applicationProof.optionalDefault()),
        scenario.product ? { enabled: false, status: "disabled" } : null,
        "only an explicitly supplied product contributes its optional builtin");
      const resources = () => page.evaluate(() => {
        const { databases, channels } = (window as any).applicationResources;
        return { databases: databases.filter((row: { name: string }) => row.name.includes("extension-data")), channels: channels.filter((row: { name: string }) => row.name.includes("extension-data")) };
      });
      if (scenario.startup) {
        assert.match(await page.evaluate(() => (window as any).applicationProof.errors.join("\n")), /fixture startup storage failure/);
      } else {
        await page.evaluate((fails: boolean) => (window as any).applicationProof.hold(fails), scenario.fails);
        await page.evaluate(() => (window as any).applicationProof.first());
        await page.waitForFunction(() => (window as any).applicationProof.entered());
        const finished = await page.evaluate(() => (window as any).applicationProof.again());
        assert.deepEqual(finished, [false, false, false], "all Application/Supervisor callers must wait for owned cleanup");
        const held = await resources();
        assert.equal(held.databases[0].closes, 0); assert.equal(held.channels[0].closes, 0);
        const outcomes = await page.evaluate(() => (window as any).applicationProof.finish());
        for (const outcome of outcomes) {
          assert.equal(outcome.status, scenario.fails ? "rejected" : "fulfilled");
          if (scenario.fails) assert.ok(outcome.errors.includes("fixture cleanup failure"));
        }
        assert.equal(await page.evaluate(() => (window as any).applicationProof.late()), scenario.fails ? "rejected" : "fulfilled");
      }
      const retired = await resources();
      assert.equal(retired.databases.length, 1); assert.equal(retired.channels.length, 1);
      assert.equal(retired.databases[0].closes, 1, "Application retirement closes its extension database once");
      assert.equal(retired.channels[0].closes, 1, "Application retirement closes its extension channel once");
      if (!scenario.startup) {
        assert.deepEqual(await page.evaluate(() => (window as any).applicationProof.reopen()), { stale: true, saved: { saved: true } });
        const reopened = await resources();
        assert.equal(reopened.databases.length, 2); assert.equal(reopened.channels.length, 2);
        assert.ok(reopened.databases.every((row: { closes: number }) => row.closes === 1));
        assert.ok(reopened.channels.every((row: { closes: number }) => row.closes === 1));
      }
      const trace = await page.evaluate(() => (window as any).applicationProof.productTrace) as string[];
      if (scenario.product) {
        const lifetimes = trace.join(',').split('product.bootstrap,').filter(Boolean);
        assert.equal(lifetimes.length, scenario.startup ? 1 : 2);
        for (const lifetime of lifetimes) {
          const events = lifetime.split(',');
          assert.equal(events.filter(event => event === 'product.dispose').length, 1, 'product owner is retired exactly once');
          assert.ok(events.includes('scope.unsubscribe') && events.indexOf('scope.unsubscribe') < events.indexOf('product.dispose'), 'cache consumer releases before product owner');
          if (!scenario.startup) {
            assert.ok(events.includes('owner.activate') && events.indexOf('owner.activate') < events.indexOf('product.preflight'));
            assert.ok(events.includes('owner.dispose') && events.indexOf('owner.dispose') < events.indexOf('product.dispose'), 'extensions release before product owner');
          }
        }
      } else assert.deepEqual(trace, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(externalOrigins, [], "the lifetime probe must stay inside its local boundaries");
      results.push({ ...scenario, mode, databaseAndChannelClosedOnce: true, externalHostAvailable: false });
    } catch (error) { console.error("Application lifetime scenario failed", scenario); throw error; }
    finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await browser?.close(); await server.close();
  for (const client of host.clients) client.terminate();
  await new Promise<void>(resolve => host.close(() => resolve()));
}
