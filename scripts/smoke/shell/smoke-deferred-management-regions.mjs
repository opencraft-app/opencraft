import assert from "node:assert/strict";
import { createServer } from "vite";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "deferred-management-"));
const source = `
import React,{useState} from 'react';
import {flushSync} from 'react-dom';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {appShellPlatformViewRegions as regions} from '/apps/workbench-web/src/components/app-shell-route-regions.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
const noop=()=>()=>{};
const contributions={commands:[],views:[],settingsPages:[],themes:[],navigation:[],bots:[]};
const runtime={extensions:[{id:'fixture.extension',name:'测试扩展',version:'1.0.0',status:'active'}]};
const installations={extensions:[],installationLoadErrors:[],discoveryErrors:[]};
const configuration={configuration:{connectors:[]}};
const connectorSnapshot={phase:'ready',data:{instances:[],supportedDefinitions:[]},error:null};
window.loadCalls=[];
window.__managementHosts={
 connectorManager:{subscribe:noop,getSnapshot:()=>configuration,managed:{subscribe:noop,snapshot:()=>connectorSnapshot,load:async host=>{window.loadCalls.push(host)}}},
 extensionRuntime:{subscribe:noop,getSnapshot:()=>runtime,contributions:{subscribe:noop,getSnapshot:()=>contributions}},
 extensionManager:{subscribe:noop,getSnapshot:()=>installations},
};
initializeAppearanceTheme();setThemePreference(new URLSearchParams(location.search).get('theme')||'light');
function App(){const[route,setRoute]=useState('home'),[host,setHost]=useState('initial');
 window.navigate=(next,nextHost)=>flushSync(()=>{setRoute(next);if(nextHost)setHost(nextHost)});
 const Connectors=regions.ConnectorLibrary,Extensions=regions.ExtensionLibrary;
 return <main style={{padding:24,height:'100dvh',overflow:'auto',background:'var(--color-background-surface)'}}>
 <input aria-label='Retained draft' defaultValue='unsent draft'/>
 <nav><button onClick={()=>setRoute('home')}>Home</button><button onClick={()=>setRoute('connectors')}>Connectors</button><button onClick={()=>setRoute('extensions')}>Extensions</button></nav>
 <section id='destination'>{route==='connectors'?<Connectors hostId={host}/>:route==='extensions'?<Extensions/>:<p>Home content</p>}</section></main>;
}
createIntlTestRoot(document.getElementById('root'),undefined,'zh-CN').render(<App/>);`;
const contextPath = root + "apps/workbench-web/src/runtime/appserver-runtime-context.tsx";
const server = await createServer({ configFile: false, root, cacheDir: output + "/vite", logLevel: "error",
 resolve: { dedupe: ["react", "react-dom", "react-intl"] }, esbuild: { jsx: "automatic" },
 optimizeDeps: { include: ["react", "react-dom/client", "react-dom", "react/jsx-runtime", "react-intl", "@radix-ui/react-dialog", "@radix-ui/react-alert-dialog", "@radix-ui/react-dropdown-menu"] },
 server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "management-regions-fixture", enforce: "pre",
 resolveId: id => id === "/fixture.tsx" ? id : null,
 async load(id) {
  if (id === "/fixture.tsx") return source;
  if (id.split("?")[0] === contextPath) {
   const original = await readFile(contextPath, "utf8");
   const marker = "export function useAppServerHosts(): AppServerHostCatalog {";
   assert.ok(original.includes(marker));
   // Only service authority is synthetic; real region and management components run.
   return original.replace(marker, marker + "\n  return (globalThis as any).__managementHosts;");
  }
 },
 configureServer(vite) { vite.middlewares.use((req,res,next) => {
  if (req.url?.split("?")[0] !== "/") return next();
  res.setHeader("content-type", "text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script>');
 }); }
 }] });
let browser;
const results = [];
try {
 await server.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
 for (const touch of [false,true]) {
  const page = await browser.newPage({ viewport: {width:touch?390:1280,height:850}, hasTouch:touch,isMobile:touch });
  await page.addInitScript("window.__name=x=>x");
  const errors=[], requests=[];page.on("pageerror", e=>errors.push(e.message));
  page.on("request", req=>requests.push(req.url()));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?theme=${touch?'dark':'light'}`,{timeout:90000});
  await page.getByText("Home content",{exact:true}).waitFor({timeout:90000});
  const managementRequests=()=>requests.filter(url=>/components\/(?:connectors\/connector-(?:library|setup|native-services)|extensions\/extension-library)\./.test(url));
  assert.deepEqual(managementRequests(),[],"registering Shell regions must not fetch management presentation");
  await page.getByRole('textbox',{name:'Retained draft'}).focus();
  await page.getByRole('textbox',{name:'Retained draft'}).evaluate(input=>{window.retainedInput=input;input.setSelectionRange(2,7)});
  let release;const held=new Promise(resolve=>release=resolve);let requested=false;
  await page.route('**/connectors/connector-library.tsx*',async route=>{requested=true;await held;await route.continue()});
  await page.evaluate(()=>window.navigate('connectors','retired-host'));
  await page.waitForFunction(()=>document.querySelector('.deferred-view')!==null);
  for(let n=0;!requested&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(requested,true);
  await page.evaluate(()=>window.navigate('home'));
  const downloaded=page.waitForResponse(response=>response.url().includes('/connectors/connector-library.tsx'),{timeout:90000});
  release();await downloaded;await page.unroute('**/connectors/connector-library.tsx*');
  assert.equal(await page.getByRole('textbox',{name:'Retained draft'}).evaluate(input=>document.activeElement===input),true);
  assert.deepEqual(await page.evaluate(()=>window.loadCalls),[],"retired View must not start management work");
  await page.evaluate(()=>window.navigate('connectors','current-host'));
  await page.getByRole('textbox',{name:'搜索连接器'}).waitFor({timeout:90000});
  const initialCards=await page.locator('.connector-service-card').count();
  await page.getByRole('textbox',{name:'搜索连接器'}).fill('IMA');
  const filteredCards=await page.locator('.connector-service-card').count();
  assert.ok(filteredCards>0&&filteredCards<initialCards,'search narrows the real catalog');
  assert.deepEqual(await page.evaluate(()=>window.loadCalls),['current-host']);
  const connectorRequests=managementRequests().filter(url=>url.includes('/connector-library.tsx')).length;
  await page.evaluate(()=>window.navigate('connectors','replacement-host'));
  await page.waitForFunction(()=>window.loadCalls.includes('replacement-host'));
  assert.equal(await page.getByRole('textbox',{name:'搜索连接器'}).inputValue(),'');
  await page.evaluate(()=>window.navigate('extensions'));
  await page.getByRole('textbox',{name:'搜索扩展'}).waitFor({timeout:90000});
  await page.getByRole('button',{name:'查看 测试扩展 详情'}).click();
  await page.getByRole('button',{name:'返回扩展列表',exact:true}).waitFor();
  await page.evaluate(()=>window.navigate('connectors','current-host'));
  await page.getByRole('textbox',{name:'搜索连接器'}).waitFor();
  assert.equal(managementRequests().filter(url=>url.includes('/connector-library.tsx')).length,connectorRequests,"successful module reused on reentry");
  assert.equal(await page.getByRole('textbox',{name:'Retained draft'}).evaluate(input=>input===window.retainedInput&&input.value==='unsent draft'&&input.selectionStart===2&&input.selectionEnd===7),true);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:join(output,`management-${touch}.png`)});
  results.push({touch,initialManagementRequests:0,managementRequests:managementRequests().length,retiredViewIgnored:true,currentHostOnly:true,hostSwitch:true,reentry:true,draftNodeAndSelection:true,errors});
  await page.close();
 }
 await writeFile(join(output,'report.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({output,results}));
} finally { await browser?.close();await server.close(); }
