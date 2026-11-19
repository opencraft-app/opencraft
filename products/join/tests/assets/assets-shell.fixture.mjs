import { groupDetailsShellSource } from "../wecom/group-details-shell.fixture.mjs";
const setup = `
const {identityWorkbenchExtension}=await import('/products/join/identity-web.ts');
const {ExtensionSupervisor}=await import('@opencraft/extension-runtime');
const {AUTHENTICATION_PROVIDER_CHANNEL}=await import('@opencraft/workbench-runtime');
const {PlatformViewRendererRegistry,THREAD_LIST_GROUPING_CHANNEL,THREAD_BADGE_CHANNEL,THREAD_PARTICIPATION_CHANNEL,IDENTITY_AVATAR_CHANNEL}=await import('@opencraft/extension-react');
const {createPlatformViewRendererContributionAdapter}=await import('/apps/workbench-web/src/runtime/platform-view-renderers.ts');
const {PlatformAccountContributionRegistry}=await import('/apps/workbench-web/src/runtime/platform-account-contributions.ts');
const {useExtensionWorkbenchProjection}=await import('/apps/workbench-web/src/runtime/extension-workbench-projection.tsx');
const {Sidebar}=await import('/apps/workbench-web/src/components/sidebar.tsx');
const {SidebarLayoutStore}=await import('@opencraft/sidebar-layout');
const {withProductCatalogs}=await import('/apps/workbench-web/src/i18n/product-catalogs.ts');
const {localeCatalogs:baseCatalogs}=await import('/apps/workbench-web/src/i18n/catalogs.ts');
const {ioaLocaleCatalogs}=await import('/products/join/plugins/tencentoa/src/locales.ts');
let account='100',expiredIdentity=false,readFailure=false,gitReadFailure=false,gitReads=0,sshReads=0,gitPosts=0,gitDelay=0,catalogDelay=0,failMcp=false;
const gitActions=[];
const gitStatus=()=>({revision:0,configured:false,identity:null,sshAuth:null,tokenConfigured:false,signing:null});
let gitCatalog={scope:'tencentoa:100',gongfengMcp:{revision:0,configured:false},hosts:Object.fromEntries(['git.woa.com','github.com'].map(host=>[host,gitStatus()]))};
const identity=()=>({loginName:'fixture',staffId:account,expiresAt:new Date(Date.now()+3600000).toISOString()});
let platformAdmin=false,platformEnabled=false,publicCatalog={revision:0,credentials:[],environments:[]};
let catalog={scope:'tencentoa:100',revision:0,allowCustomEndpoints:true,credentials:[],environments:[]},failNext=false,lostNext=false,posts=0;
const projection=()=>({...catalog,...(platformEnabled?{canManagePlatform:platformAdmin,platformRevision:publicCatalog.revision,
 credentials:[...catalog.credentials,...(platformAdmin?publicCatalog.credentials.map(c=>({...c,source:'platform'})):[])],
 environments:[...catalog.environments,...publicCatalog.environments.map(({credentialId,...e})=>({...e,...(platformAdmin?{credentialId}:{}),source:'platform'}))]}:{})});
window.assetsFixture={get gitActions(){return gitActions},gitReadFailure(value){gitReadFailure=value},delayGit(ms){gitDelay=ms},delayCatalog(ms){catalogDelay=ms},failMcp(){failMcp=true},get gitPosts(){return gitPosts},enablePlatform(){platformEnabled=true;platformAdmin=true},member(){platformAdmin=false},admin(){platformAdmin=true},get publicSnapshot(){return publicCatalog},get sshReads(){return sshReads},get gitReads(){return gitReads},fail(){failNext=true},denyCustom(){failNext='custom_endpoint_admin'},lose(){lostNext=true},get posts(){return posts},get snapshot(){return catalog},get gitSnapshot(){return gitCatalog},failRead(){readFailure=true},restoreRead(){readFailure=false},expire(){expiredIdentity=true;window.dispatchEvent(new Event('online'));},advanceGit(){gitCatalog={...gitCatalog,hosts:{...gitCatalog.hosts,'git.woa.com':{...gitCatalog.hosts['git.woa.com'],revision:gitCatalog.hosts['git.woa.com'].revision+1,configured:true,identity:{username:'remote',name:'Remote',email:'remote@example.com'}}}};},switchAccount(){account='200';window.dispatchEvent(new Event('online'));}};
let envPosts=0,envReads=0,envDelay=0,envFailure=null;
const envDocuments=new Map();
const envDocument=projectId=>({projectId,revision:0,variables:[],inherited:projectId?[{name:'INHERITED_KEY',secret:true,value:null}]:[],projects:[{id:'project-a',name:'项目 A'}]});
Object.defineProperties(window.assetsFixture,{envPosts:{get:()=>envPosts},envReads:{get:()=>envReads}});
Object.assign(window.assetsFixture,{delayEnv(ms){envDelay=ms},failEnv(code){envFailure=code}});
const fetcher=async(url,options={})=>{
 if(String(url).includes('/environment-variables')){
  envReads++;
  const requestAccount=account;
  const body=options.method==='POST'?JSON.parse(options.body):null;
  const projectId=body?body.projectId:new URL(String(url),'http://fixture').searchParams.get('projectId');
  const key=requestAccount+':'+projectId;
  let doc=envDocuments.get(key)??envDocument(projectId);
  if(body){envPosts++;if(envDelay)await new Promise(resolve=>setTimeout(resolve,envDelay));if(envFailure){const error=envFailure;envFailure=null;return Response.json({error},{status:409});}
    if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
    doc={...doc,revision:doc.revision+1,variables:body.variables.map(v=>({...v,value:v.secret?null:v.value}))};envDocuments.set(key,doc);}
  return Response.json(doc);
 }

 if(String(url).endsWith('/session'))return new Response(JSON.stringify({available:true,identity:expiredIdentity?null:identity()}));
 if(String(url).endsWith('/ssh-credentials')){sshReads++;return new Response(JSON.stringify({scope:'tencentoa:'+account,credential:{username:'fixture',privateKey:'-----BEGIN OPENSSH PRIVATE KEY-----\\nfixture-private-material\\n-----END OPENSSH PRIVATE KEY-----',publicKey:'ssh-ed25519 Zml4dHVyZQ==',fingerprint:'SHA256:'+'A'.repeat(43)}}));}
 if(String(url).includes('git-credentials')){
  if(options.method!=='POST'){gitReads++;if(gitReadFailure)return new Response(JSON.stringify({error:'unavailable'}),{status:503});}else {gitPosts++;gitActions.push(JSON.parse(options.body).action);if(gitDelay)await new Promise(resolve=>setTimeout(resolve,gitDelay));}
  if(account!=='100')return new Response(JSON.stringify({...gitCatalog,scope:'tencentoa:'+account,hosts:Object.fromEntries(['git.woa.com','github.com'].map(host=>[host,gitStatus()]))}));
  if(options.method==='POST'){const p=JSON.parse(options.body),host=gitCatalog.hosts[p.host];
   if(p.action==='save-mcp'||p.action==='clear-mcp'){
    if(failMcp){failMcp=false;return new Response(JSON.stringify({error:'unavailable'}),{status:503});}
    if(p.revision!==gitCatalog.gongfengMcp.revision)return new Response(JSON.stringify({error:'conflict'}),{status:409});
    gitCatalog={...gitCatalog,gongfengMcp:{revision:p.revision+1,configured:p.action==='save-mcp'}};
    return new Response(JSON.stringify(gitCatalog));
   }
   if(p.revision!==host.revision)return new Response(JSON.stringify({error:'conflict'}),{status:409});
   if(p.action==='clear')gitCatalog={...gitCatalog,hosts:{...gitCatalog.hosts,[p.host]:{...gitStatus(),revision:host.revision+1}}};
   if(p.action==='save')gitCatalog={...gitCatalog,hosts:{...gitCatalog.hosts,[p.host]:{...host,revision:host.revision+1,configured:true,tokenConfigured:host.tokenConfigured||!!p.token,identity:{username:p.username,name:p.name,email:p.email}}}};
  }
  return new Response(JSON.stringify(gitCatalog));
 }
 if(account!=='100')return new Response(JSON.stringify({scope:'tencentoa:200',revision:0,allowCustomEndpoints:false,credentials:[],environments:[]}));
 if(catalogDelay)await new Promise(resolve=>setTimeout(resolve,catalogDelay));
 if(options.method!=='POST'&&readFailure)return new Response(JSON.stringify({error:'unavailable'}),{status:503});
 if(options.method==='POST'){
  posts++;if(failNext){const reason=failNext;failNext=false;return new Response(JSON.stringify({error:reason===true?'unavailable':reason}),{status:reason==='custom_endpoint_admin'?403:503});}
  const p=JSON.parse(options.body);if(p.source==='platform'&&!platformAdmin)return new Response(JSON.stringify({error:'administrator_required'}),{status:403});
  const personalCatalog=catalog;if(p.source==='platform')catalog=publicCatalog;
  if(p.revision!==catalog.revision){catalog=personalCatalog;return new Response(JSON.stringify({error:'conflict'}),{status:409});}
  if(p.action==='save-credential'){const c={id:p.id??crypto.randomUUID(),name:p.name,apiUrl:p.apiUrl,sandboxUrl:p.sandboxUrl,generation:'public-generation'};catalog.credentials=catalog.credentials.filter(c=>c.id!==p.id).concat(c);}
  if(p.action==='save-environment'){catalog.environments=catalog.environments.filter(e=>e.id!==p.id).concat({id:p.id??crypto.randomUUID(),name:p.name,credentialId:p.credentialId,templateId:p.templateId});}
  if(p.action==='delete-environment')catalog.environments=catalog.environments.filter(e=>e.id!==p.id);
  if(p.action==='delete-credential'){if(catalog.environments.some(e=>e.credentialId===p.id)){catalog=personalCatalog;return new Response(JSON.stringify({error:'credential_in_use'}),{status:409});}catalog.credentials=catalog.credentials.filter(c=>c.id!==p.id);}
  catalog={...catalog,revision:catalog.revision+1};if(p.source==='platform'){publicCatalog=catalog;catalog=personalCatalog;}
  if(lostNext){lostNext=false;throw Error('response lost');}
 }
 return new Response(JSON.stringify(projection()));
};
// Exercise the product factory, atomic contribution validation, real renderer
// and account adapters, and the production sidebar projection. Unused Host
// integrations accept the same prepare/commit/dispose lifecycle without I/O.
const platformViewRenderers=new PlatformViewRendererRegistry();
const platformAccounts=new PlatformAccountContributionRegistry();
const sidebarLayout=await SidebarLayoutStore.open({load:async()=>null,save:async(_scope,document)=>document});
const internalContributions=Object.fromEntries([AUTHENTICATION_PROVIDER_CHANNEL,THREAD_LIST_GROUPING_CHANNEL,THREAD_BADGE_CHANNEL,THREAD_PARTICIPATION_CHANNEL,IDENTITY_AVATAR_CHANNEL].map(channel=>[channel,{prepare(){return{commit(){return()=>{}}}}}]));
internalContributions.platformViewRenderer=createPlatformViewRendererContributionAdapter(platformViewRenderers);
internalContributions.platformAccount=platformAccounts.createAdapter();
const supervisor=new ExtensionSupervisor({platform:'web',internalContributions});
await supervisor.activate(await identityWorkbenchExtension.load({fetcher,getClient:()=>undefined}));
const committedViewIds=new Set();
const syncViews=()=>{for(const id of committedViewIds)views.delete(id);committedViewIds.clear();for(const {contribution} of supervisor.contributions.getSnapshot().views){views.set(contribution.id,contribution);committedViewIds.add(contribution.id);}};
supervisor.contributions.subscribe(syncViews);syncViews();
window.assetsFixture.registration=()=>({
 extension:supervisor.getSnapshot().extensions.find(row=>row.id==='tencentoa.identity'),
 views:supervisor.contributions.getSnapshot().views.map(({owner,contribution})=>({owner:owner.extensionId,id:contribution.id,viewType:contribution.viewType,keepConversationSidebar:contribution.keepConversationSidebar,hasRenderer:platformViewRenderers.resolve(contribution.viewType)!==null})),
 settingsPages:supervisor.contributions.getSnapshot().settingsPages.map(({contribution})=>contribution),
 settings:supervisor.contributions.getSnapshot().settingsPages.map(({contribution})=>contribution.id),
 catalogs:supervisor.contributions.getSnapshot().sidebarCatalogs.map(({owner,contribution})=>({owner:owner.extensionId,...contribution})),
});
window.assetsFixture.deactivate=()=>supervisor.deactivate('tencentoa.identity');
`;
export const assetsShellSource = groupDetailsShellSource
  .replace(
    "openView:navigation.openExtensionView,",
    "openView:(...args)=>{window.lastOpenedAssetsView=args[0];return navigation.openExtensionView(...args)},openSettings:section=>{window.openedSettings=section},",
  )
  .replace(
    "<App/></WorkbenchPresentationRootProvider>",
    "<React.StrictMode><App/></React.StrictMode></WorkbenchPresentationRootProvider>",
  )
  .replace(
    "createIntlTestRoot(target,undefined,'zh-CN')",
    "createIntlTestRoot(target,undefined,'zh-CN',withProductCatalogs(baseCatalogs,ioaLocaleCatalogs))",
  )
  .replace(
    "const navigation=createApplicationNavigation",
    setup + "\nconst navigation=createApplicationNavigation",
  )
  .replace(
    "const routeHeader=useAppShellRouteHeader",
    "host.registerNavigationGuard=navigation.registerNavigationGuard;const assetsProjection=useExtensionWorkbenchProjection({contributions:supervisor.contributions,renderers:platformViewRenderers,accounts:platformAccounts,host,applicationRoute:route,internalDeveloperMode:false,openSettings:host.openSettings,openView:host.openView});\nconst routeHeader=useAppShellRouteHeader",
  )
  .replace(
    "Component=active?renderers.get(active.viewType):undefined",
    "Component=active?(platformViewRenderers.resolve(active.viewType)??renderers.get(active.viewType)):undefined",
  )
  .replace(
    "leftPanel={<button onClick={()=>{setOpen(false);navigation.openExtensionView('opencraft.im.people')}}>Inbox destination</button>}",
    "leftPanel={<Sidebar threads={[]} activeHostId='fixture' activeThreadId='' sidebarLayout={sidebarLayout} catalogs={assetsProjection.catalogs} onSelectThread={()=>false} onNewTask={noop} onOpenSettings={noop} showStart={false} showNewChat={false} showFooter={false}/>}",
  )
  .replace(
    "<button onClick={()=>navigation.openExtensionView('opencraft.im.people')}>Open Inbox</button>",
    "<p>Choose an item from the sidebar.</p>",
  );
