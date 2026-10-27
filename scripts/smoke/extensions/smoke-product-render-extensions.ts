import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

// Real Application/runtime/document; the local extension is synthetic. No Host or account.
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createWebChatRenderRuntime,WebChatRenderRuntimeProvider,WebUserMessageDocument} from '/packages/chat-render-web/src/index.ts';
import {createWebWorkbenchApplication} from '/apps/workbench-web/src/runtime/web-workbench-application.ts';
import {initializeAppearanceTheme} from '/apps/workbench-web/src/appearance-theme.ts';
initializeAppearanceTheme();
const trace=[];
function renderer(ctx){ctx.effect(()=>{trace.push('installed');const remove=ctx.chatNodeRenderers.register({
 name:'example-user-badge',priority:20,kinds:['text'],matches:(node,context)=>context.dialect==='user-message'&&node.text==='[badge]',
 component:()=> <mark>Local badge</mark>});return()=>{remove();trace.push('disposed')}})}
renderer.inject=['chatNodeRenderers'];
const options={hostProfileMode:'configured',navigationMode:'memory',ephemeralHostProfiles:[],chatRenderExtensions:[renderer]};
const application=await createWebWorkbenchApplication(options);
const plain=await createWebChatRenderRuntime();
function Document({runtime,id}){return <WebChatRenderRuntimeProvider runtime={runtime}><section id={id}><WebUserMessageDocument documentId={id} source='[badge]'/></section></WebChatRenderRuntimeProvider>}
createRoot(document.getElementById('root')).render(<><Document runtime={application.chatRenderRuntime} id='product'/><Document runtime={plain} id='plain'/></>);
window.proof={trace,async dispose(){await application.dispose();await application.dispose();return {trace,names:application.chatRenderRuntime.renderers.getSnapshot().map(row=>row.name),plainNames:plain.renderers.getSnapshot().map(row=>row.name)}},async rollback(){
 const events=[];
 function first(ctx){ctx.effect(()=>{events.push('first');return()=>events.push('undo-first')})}
 function failing(){throw Error('expected extension failure')}
 try{await createWebWorkbenchApplication({...options,chatRenderExtensions:[first,failing]});return {accepted:true,events}}catch(error){return {accepted:false,events}}
}};`;
const output = await mkdtemp(join(tmpdir(), "opencraft-render-extensions-"));
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  cacheDir: join(output, "vite"), esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl"] },
  define: { "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"', "import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST": '"false"' },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{name: "render-extensions-proof", resolveId: id => id === "/proof.tsx" ? id : null, load: id => id === "/proof.tsx" ? source : null,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/proof.tsx"></script>');
    }); },
  }],
});
const {chromium} = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE});
try {
  await server.listen();
  for (const width of [390, 1280]) {
    const context = await browser.newContext({viewport: {width, height: 844}});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]);
    await page.locator("#product mark").waitFor();
    assert.equal(await page.locator("#product").innerText(), "Local badge");
    assert.equal(await page.locator("#plain").innerText(), "[badge]");
    assert.equal(await page.locator("#plain mark").count(), 0);
    await page.screenshot({path: join(output, `${width}.png`)});
    const disposal = await page.evaluate(() => (window as any).proof.dispose());
    assert.deepEqual(disposal.trace, ["installed", "disposed"]);
    assert.deepEqual(disposal.names, []);
    assert.ok(disposal.plainNames.includes("web-prose"));
    const rollback = await page.evaluate(() => (window as any).proof.rollback());
    assert.deepEqual(rollback, {accepted: false, events: ["first", "undo-first"]});
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(`PASS real Application renderer extension: explicit composition, default isolation, idempotent disposal and failed-start rollback; desktop/mobile. Evidence: ${output}`);
} finally { await browser.close(); await server.close(); }
