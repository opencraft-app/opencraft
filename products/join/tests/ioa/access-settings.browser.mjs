import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {EmployeeAdmissionPolicy} from '../../plugins/tencentoa/src/admission-policy.ts';
const root=process.cwd(),scratch=await mkdtemp(join(tmpdir(),'ioa-access-ui-'));
const out=process.env.OPENCRAFT_SMOKE_OUTPUT??join(scratch,'evidence');await mkdir(out,{recursive:true});
let administrator=true,failRead=false,origin='',posts=0;
const principal=(loginName='alice',subject='1')=>({provider:'tencentoa',subject,attributes:{loginName},expiresAt:Date.now()+60000});
const policy=new EmployeeAdmissionPolicy(join(scratch,'policy.sqlite'),{id:'fixture',name:'本机服务器'},()=>({authenticate:()=>principal(),role:()=>administrator?'admin':'member',trustedOrigin:()=>origin}));
await policy.initialize();await policy.prepare(principal());
const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {IntlProvider} from 'react-intl';
import messages from '/apps/workbench-web/src/i18n/locales/zh-CN.json';import ioa from '/products/join/plugins/tencentoa/src/locales/zh-CN.json';
import '/apps/workbench-web/src/styles/settings-page.scss';import '/apps/workbench-web/src/styles/app.scss';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {SettingsNavigation} from '/apps/workbench-web/src/components/settings-page.tsx';import {ExtensionLibrary} from '/apps/workbench-web/src/components/extensions/extension-library.tsx';
import {PlatformViewRendererRegistry} from '/packages/extension-react/src/index.ts';
import {EmployeeAdmissionController} from '/products/join/plugins/tencentoa/src/admission-controller.ts';import {createEmployeeAdmissionSettings} from '/products/join/plugins/tencentoa/src/admission-settings.tsx';
initializeAppearanceTheme();setThemePreference('light');window.setTheme=setThemePreference;
const owner={extensionId:'tencentoa.identity',activationId:'fixture',platform:'web'};
const owned=contribution=>({owner,contribution});const view={id:'tencentoa.identity.access.view',title:'Access policy',viewType:'tencentoa.identity.access',platforms:['web']};
const snapshot={revision:1,commands:[],settingsSchemas:[],views:[owned(view)],navigation:[],sidebarCatalogs:[],settingsPages:[owned({id:'tencentoa.identity.access',title:'员工访问',viewId:view.id,placement:'extension',platforms:['web']})],workbenchSurfaces:[],themes:[],bots:[]};
const contributions={getSnapshot:()=>snapshot,subscribe:()=>()=>{}};const runtime={extensions:[{id:'tencentoa.identity',name:'iOA',version:'0.1.0',status:'active',enabled:true}]};
const supervisor={getSnapshot:()=>runtime,subscribe:()=>()=>{},contributions};const installed={extensions:[],installationLoadErrors:[],discoveryErrors:[]};
const manager={getSnapshot:()=>installed,subscribe:()=>()=>{}};const host={platform:'web',activeHostId:'local-codex',profiles:[],openView(){},provisionHost:async()=>{},removeHost:async()=>false,pushViewResource(){},replaceViewResource(){}};
const renderers=new PlatformViewRendererRegistry();renderers.register(owner.extensionId,{viewType:view.viewType,Component:createEmployeeAdmissionSettings(new EmployeeAdmissionController(fetch.bind(globalThis)))});
function App(){const [error,setError]=useState('');return <IntlProvider locale="zh-CN" defaultLocale="en" messages={{...messages,...ioa}}><div className="access-smoke-shell"><nav className="access-smoke-nav"><SettingsNavigation section="plugins" onSectionChange={()=>{}} extensionContributions={contributions} profiles={[]} machines={[]} onBack={()=>{}}/></nav><main className="settings-page__content"><h1>插件</h1><ExtensionLibrary supervisor={supervisor} manager={manager} settingsHost={host} renderers={renderers} reportError={x=>setError(x.message)}/><p role="alert">{error}</p></main></div></IntlProvider>};createRoot(document.getElementById('root')).render(<App/>);`;
let vite,browser,mainPage;const errors=[];
try {
 vite=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'ioa-access-fixture',resolveId(id){if(id==='/access-fixture.tsx')return id;},load(id){if(id==='/access-fixture.tsx')return entry;},configureServer(server){server.middlewares.use((req,res,next)=>{
  if(req.url?.startsWith('/__opencraft_enterprise_identity/access-policy')){if(req.method==='POST')posts++;if(failRead&&req.method==='GET'){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}void policy.handle(req,res);return;}
  if(req.url?.split('?')[0]!=='/settings/plugins')return next();res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}.access-smoke-shell{height:100%;display:grid;grid-template-columns:210px minmax(0,1fr)}.access-smoke-nav{border-right:1px solid var(--color-border-subtle);overflow:auto}main{padding:24px;overflow:auto;min-width:0}@media(max-width:650px){.access-smoke-shell{grid-template-columns:minmax(0,1fr)}.access-smoke-nav{display:none}main{padding:16px}}</style><div id="root"></div><script type="module" src="/access-fixture.tsx"></script></html>');
 });}}]});await vite.listen();origin='http://127.0.0.1:'+vite.httpServer.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=mainPage=await browser.newPage({viewport:{width:1280,height:950}});page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/access-policy'))console.log('policy-http',r.status());});
 const open=async()=>{await page.goto(origin+'/settings/plugins');await page.getByRole('button',{name:'查看 iOA 详情',exact:true}).click();};
 await open();assert.equal(await page.locator('nav').getByText('员工访问',{exact:true}).count(),0);const advanced=page.locator('summary').filter({hasText:'高级设置'});await advanced.waitFor();assert.equal(posts,0);
 await advanced.click();await page.getByLabel('草稿策略',{exact:true}).selectOption('allowlist');await page.getByLabel('员工账号',{exact:true}).fill('alice\nbob');
 const editor=page.getByLabel('员工账号',{exact:true});await editor.evaluate(el=>window.draftNode=el);await advanced.click();await advanced.click();assert.equal(await editor.evaluate(el=>el===window.draftNode),true);assert.equal(await editor.inputValue(),'alice\nbob');
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.getByText('草稿已保存',{exact:true}).waitFor();assert.equal(policy.document(true).active.mode,'inherit');
 await page.getByRole('button',{name:'发布策略',exact:true}).click();await page.getByText('策略已发布',{exact:true}).waitFor();assert.equal(policy.document(true).active.mode,'allowlist');
 await policy.prepare(principal('bob','2'));await policy.prepare(principal('carol','3'));assert.equal(policy.allows(principal('bob','2')),true);assert.equal(policy.allows(principal('carol','3')),false);
 await page.getByLabel('样例员工账号',{exact:true}).fill('bob');await page.getByLabel('样例员工编号',{exact:true}).fill('2');
 const previewRevision=policy.document(true).revision;await page.getByRole('button',{name:'运行测试',exact:true}).click();await page.getByRole('status').filter({hasText:'允许'}).waitFor();assert.equal(policy.document(true).revision,previewRevision);
 const beforeRestore=posts;await editor.fill('alice\nbob\ncarol');await page.getByRole('button',{name:'载入为草稿',exact:true}).first().click();assert.equal(await page.getByLabel('草稿策略',{exact:true}).inputValue(),'inherit');assert.equal(policy.document(true).active.mode,'allowlist');assert.equal(posts,beforeRestore);await page.getByLabel('草稿策略',{exact:true}).selectOption('allowlist');await editor.fill('alice\nbob');
 await page.screenshot({path:join(out,'desktop-light.png'),fullPage:true});await page.evaluate(()=>window.setTheme('dark'));await page.waitForTimeout(350);await page.screenshot({path:join(out,'desktop-dark.png'),fullPage:true});
 // A second administrator write makes this editor stale; current input must survive CAS refusal.
 const revision=policy.document(true).revision;await page.request.post(origin+'/__opencraft_enterprise_identity/access-policy',{headers:{origin},data:{action:'draft',revision,config:{mode:'allowlist',loginNames:['alice','bob']}}});await editor.fill('alice\nbob\ncarol');await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.getByRole('alert').filter({hasText:'设置已在其他窗口更新'}).waitFor();assert.equal(await editor.inputValue(),'alice\nbob\ncarol');
 const before=JSON.stringify(policy.document(true).active);administrator=false;const denied=await page.request.post(origin+'/__opencraft_enterprise_identity/access-policy',{headers:{origin},data:{action:'publish',revision:policy.document(true).revision,config:{mode:'inherit'}}});assert.equal(denied.status(),403);assert.equal(JSON.stringify(policy.document(true).active),before);
 await open();await page.waitForTimeout(150);assert.equal(await advanced.count(),0);assert.equal(await page.getByLabel('员工账号',{exact:true}).count(),0);
 administrator=true;failRead=true;await open();await page.getByRole('button',{name:'重新载入',exact:true}).waitFor();failRead=false;await page.getByRole('button',{name:'重新载入',exact:true}).click();await advanced.waitFor();
 const mobile=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});const phone=await mobile.newPage();phone.on('pageerror',e=>errors.push(e.message));await phone.goto(origin+'/settings/plugins');await phone.getByRole('button',{name:'查看 iOA 详情',exact:true}).tap();await phone.locator('summary').filter({hasText:'高级设置'}).tap();await phone.getByLabel('员工账号',{exact:true}).waitFor();assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await phone.screenshot({path:join(out,'mobile.png'),fullPage:true});await mobile.close();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,evidence:out,scope:'actual Settings navigation and plugin detail components with real admission-policy HTTP/SQLite in an isolated browser fixture',checks:['navigation removed','admin only','draft DOM continuity','save versus publish','read-only preview','history restores draft only','policy effect','CAS draft retention','revocation','load retry','desktop themes','mobile touch']}));
}catch(e){if(mainPage){console.log(JSON.stringify({errors,body:(await mainPage.locator("body").innerText()).slice(0,6000)}));await mainPage.screenshot({path:join(out,"failure.png"),fullPage:true});}throw e;}finally{await browser?.close();await vite?.close();policy.close();}
