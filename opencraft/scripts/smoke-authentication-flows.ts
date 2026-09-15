import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_AUTH_REPORT ?? "/tmp/opencraft-authentication-flows";
// Real Cordis services, account adapter, login/account/environment Views and shared modal projection.
// Only native OAuth completion and HTTP responses are test doubles. No external requests or cloud writes.
const source = `
import React,{useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {Context} from '@deepseek-ai/cordis';
import {AuthenticationService,AuthenticationFlowService} from '/packages/workbench-runtime/src/index.ts';
import {LightVelaAccountService} from '/plugins/lightvela-hermes/src/account/lightvela-account-service.ts';
import {createLightVelaSignInView} from '/plugins/lightvela-hermes/src/account/lightvela-sign-in-view.tsx';
import {createLightVelaAccountView} from '/plugins/lightvela-hermes/src/account/lightvela-account-view.tsx';
import {LightVelaEnvironmentService} from '/plugins/lightvela-hermes/src/environments/lightvela-environment-service.ts';
import {createLightVelaEnvironmentView} from '/plugins/lightvela-hermes/src/environments/lightvela-environment-view.tsx';
import {useAuthenticationPresentation} from '/apps/workbench-web/src/runtime/use-authentication-presentation.tsx';
import {ModalHost} from '/apps/workbench-web/src/components/modal/modal-host.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const ctx=new Context();await ctx.plugin(AuthenticationService);await ctx.plugin(AuthenticationFlowService);
const attempts=[];let restored=null;let resourcesFail=false;let postCount=0;
const memory=new Map();const account=new LightVelaAccountService({storage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},
desktopAccount:{signIn:region=>new Promise(resolve=>attempts.push({region,resolve})),cancel:async()=>{},readSession:async()=>restored,clearSession:async()=>{},signOut:async()=>{}},
fetchImpl:async(url,init)=>{if(init?.method==='POST')postCount++;if(resourcesFail)return Response.json({message:'resource unavailable'},{status:503});
if(url.endsWith('/auth/profile'))return Response.json({user:{id:'fixture-user',name:'Preview user'}});
if(url.endsWith('/subscriptions/current'))return Response.json({hasSubscription:false});
if(url.endsWith('/v1/passes'))return Response.json({data:{passes:[{pass_id:'test-pass',status:'active',expired_time:'2099-01-01',agent_quota_available:1}]}});
return Response.json({data:{items:[]}});}});
ctx.authentication.register('fixture',{id:'lightvela.hermes.account',getSession:()=>account.getSnapshot().session,subscribe:account.subscribe,signIn:()=>account.signIn(),cancelSignIn:()=>account.cancelSignIn()});
const Login=createLightVelaSignInView(account),Account=createLightVelaAccountView(account);
const creation=new LightVelaEnvironmentService(account,{storage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});
const Environment=createLightVelaEnvironmentView(account,creation);
const host={platform:'electron',authentication:ctx.authenticationFlows,profiles:[],activeHostId:null,provisionHost:async()=>{throw Error('must not provision')},openView:()=>{},replaceViewResource:()=>{},removeHost:async()=>false};
function App(){const [accountOpen,setAccountOpen]=useState(false),[environmentOpen,setEnvironmentOpen]=useState(false),[route,setRoute]=useState('chat');
const snapshot=useSyncExternalStore(account.subscribe,account.getSnapshot,account.getSnapshot);
const projection={provider:{authenticationProviderId:'lightvela.hermes.account',signInViewId:'login'},snapshot:{phase:snapshot.session.status},renderSignIn:id=><Login host={host} authenticationFlowId={id}/>,content:<Account host={host}/>};
const presentation=useAuthenticationPresentation(ctx.authenticationFlows,projection,route);
const requests=[];
if(accountOpen)requests.push({id:'account',label:'Account Settings',appearance:'utility',size:'wide',content:projection.content,onDismiss:()=>setAccountOpen(false)});
if(environmentOpen)requests.push({id:'environment',label:'添加环境',appearance:'utility',size:'compact',content:<Environment host={host} onDismiss={()=>setEnvironmentOpen(false)}/>,onDismiss:()=>setEnvironmentOpen(false)});
if(presentation.modal)requests.push(presentation.modal);
window.fixture={setThemePreference,setRoute,flow:()=>ctx.authenticationFlows.getSnapshot(),postCount:()=>postCount,attempts:()=>attempts.length,session:()=>account.getSnapshot().session,
complete:index=>{const a=attempts[index??attempts.length-1];a.resolve({region:a.region,token:'fixture-only-token'})},cancel:()=>attempts.at(-1).resolve(null),signOut:()=>account.signOut(),
restore:async()=>{restored={region:'intl',token:'fixture-restored-token'};await account.restoreDesktopSession()},resourcesFail:value=>resourcesFail=value,refresh:()=>account.refreshAccountDetails().catch(()=>{}),reauth:presentation.open};
return <main style={{padding:32,minHeight:'100dvh',background:'var(--color-background-surface)'}}>
<nav><button className='shell-navigation__entrance' data-surface='account' onClick={()=>snapshot.session.status==='anonymous'?presentation.open():setAccountOpen(true)}>{snapshot.session.status==='anonymous'?'Sign in':'Preview user'}</button>
<button onClick={()=>setEnvironmentOpen(true)}>添加环境</button></nav>
<h1>{route==='chat'?'What should we work on?':'Settings'}</h1><input aria-label='Draft' defaultValue='Keep my local draft'/>
<ModalHost requests={requests}/></main>}
createRoot(document.getElementById('root')).render(<App/>);
`;

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "@deepseek-ai/cordis"] }, cacheDir: "node_modules/.vite-authentication-flows",
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-popover"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "authentication-flow-fixture", resolveId: id => id === "/auth-probe.tsx" ? id : null,
    load: id => id === "/auth-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script type="module" src="/auth-probe.tsx"></script>');
    }); },
  }],
});
let browser: any;
const evidence: string[] = [], errors: string[] = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value;");
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await page.getByRole("button", { name: "等待浏览器登录…" }).waitFor();
  assert.equal(await page.locator('.lightvela-login-options').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll('button')].every(button => {
      const box = button.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right;
    });
  }), true, "pending controls fit the compact card, independent of window width");
  await page.screenshot({ path: `${output}/sign-in-pending.png` });
  await page.evaluate(() => (window as any).fixture.complete());
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-surface") === "account");
  assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "Keep my local draft");
  evidence.push("anonymous startup; matching login closes only sign-in; focus and draft preserved");

  await page.getByRole("button", { name: "Preview user", exact: true }).click();
  const accountDialog = page.getByRole("dialog", { name: "Account Settings", exact: true });
  await accountDialog.waitFor();
  await page.evaluate(() => (window as any).fixture.refresh());
  assert.equal(await accountDialog.count(), 1);
  await page.evaluate(() => (window as any).fixture.reauth());
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await page.evaluate(() => (window as any).fixture.complete());
  await page.getByRole("dialog", { name: "Sign in", exact: true }).waitFor({ state: "detached" });
  assert.equal(await accountDialog.count(), 1);
  await page.keyboard.press("Escape"); await accountDialog.waitFor({ state: "detached" });
  evidence.push("explicit Account survives refresh and same-account reauthentication");

  await page.evaluate(() => (window as any).fixture.signOut());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  const cancelledAttempt = await page.evaluate(() => (window as any).fixture.attempts() - 1);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.evaluate(index => (window as any).fixture.complete(index), cancelledAttempt);
  assert.equal(await page.getByRole("dialog", { name: "Sign in", exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => (window as any).fixture.session().status), "anonymous");
  await page.keyboard.press("Escape");
  evidence.push("Escape cancellation and a late callback cannot replace a newer prompt");

  await page.evaluate(() => (window as any).fixture.restore());
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.evaluate(() => (window as any).fixture.signOut());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await page.evaluate(() => (window as any).fixture.setRoute("settings"));
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.evaluate(() => (window as any).fixture.complete());
  await page.getByRole("button", { name: "Preview user", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Settings", exact: true }).count(), 1);
  assert.equal(await page.getByRole("dialog").count(), 0);
  evidence.push("restoration never opens UI; navigation abandons continuation without discarding valid session");

  await page.evaluate(() => (window as any).fixture.signOut());
  await page.getByRole("button", { name: "添加环境", exact: true }).click();
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await page.evaluate(() => (window as any).fixture.complete());
  await page.getByRole("textbox", { name: "环境名称", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).fixture.postCount()), 0);
  await page.evaluate(() => (window as any).fixture.setThemePreference("dark"));
  await page.screenshot({ path: `${output}/environment-resumed-dark.png` });
  await page.keyboard.press("Escape");
  evidence.push("environment login resumes preflight/form only; no POST or automatic provision");

  await page.evaluate(() => { (window as any).fixture.resourcesFail(true); return (window as any).fixture.signOut(); });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "继续登录", exact: true }).click();
  await page.evaluate(() => (window as any).fixture.complete());
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => (window as any).fixture.session().status), "authenticated");
  evidence.push("profile/catalog 503 does not turn successful login into failure");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ evidence, errors }, null, 2));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify({ evidence, errors }, null, 2));
  await browser?.close(); await vite.close();
}
