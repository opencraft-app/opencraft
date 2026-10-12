import Fastify,{type FastifyRequest} from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import {jwtVerify} from 'jose';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {Store} from './store.js';
import {userSig} from './signature.js';
import {provision,imAdminCall} from './provision.js';
import {DemoDirectory} from './demo.js';
import {GroupPolicies} from './groups.js';
import {createAgentHost,type AgentHost} from './agent-host.js';
import {verifyLightVelaToken,lightvelaSubject} from './lightvela.js';
import type {IdentityKind} from '@vela/im-client';
import type {Config,LightVelaRegion} from './config.js';

const fail=(statusCode:number,error:string,code:string|number=statusCode)=>Object.assign(new Error(error),{statusCode,code});
const name=(s:unknown)=>{
 if(typeof s!=='string'||!s.trim()||s.trim().length>40)throw fail(400,'名称长度必须在 1 到 40 个字符之间');return s.trim();
};
/**
 * Vela identity service. Maps outer logins to natural persons, owns their IM identities and signs short-lived
 * UserSigs. Every client (browser, iOS WebView, Android, Agent worker) then logs into Tencent IM itself;
 * this service never relays messages or holds an IM session.
 */
export async function buildApp(c:Config,options:{store?:Store;provision?:(c:Config,id:string,name:string)=>Promise<void>;demoEnroll?:(id:string)=>Promise<void>;groupPolicies?:GroupPolicies;
 agentHost?:AgentHost;adminCall?:typeof imAdminCall;lightvelaFetch?:typeof fetch}={}) {
 const store=options.store??new Store(join(c.dataDir,'vela.sqlite'));
 const importAccount=options.provision??provision;
 const agentHost=options.agentHost??createAgentHost(c.agentHost);
 const adminCall=options.adminCall??imAdminCall;
 const directory=new DemoDirectory(c,store);const enrollDemo=options.demoEnroll??((id:string)=>directory.enroll(id));
 const groups=options.groupPolicies??new GroupPolicies(c,store);
 const app=Fastify({logger:false,bodyLimit:1024*1024,requestTimeout:30000});
 await app.register(cors,{origin:c.allowedOrigins,methods:['GET','POST','PUT','DELETE','OPTIONS'],allowedHeaders:['Content-Type','Authorization']});
 await app.register(rateLimit,{max:300,timeWindow:'1 minute',keyGenerator:req=>{
  // cloudflared reaches the loopback API; preserve each public visitor's rate bucket.
  const forwarded=req.headers['cf-connecting-ip'];
  return ['127.0.0.1','::1'].includes(req.ip)&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:req.ip;
 }});
 app.addHook('onSend',async (_req,reply,payload)=>{
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
  if(_req.url.startsWith('/api/'))reply.header('Cache-Control','no-store');
  return payload;
 });
 app.setErrorHandler((e:any,_req,reply)=>{
  const status=e.statusCode??(e.status||500);
  const msg=String(e.message??'请求失败').split('\n')[0].replace(/(usersig|userSig|secret|assertion|token)[=:][^\s&]+/gi,'$1=[redacted]');
  reply.code(status).send({error:status===500?'IM 操作失败，请检查服务端连接与账号配置':msg,code:e.code??status});
 });
 const auth=(req:FastifyRequest,ownerOnly=false)=>{
  const token=(req.headers.authorization??'').replace(/^Bearer /,'');
  const session=store.authenticate(token);
  if(!session)throw fail(401,'登录态已失效，请从外层应用重新进入','SESSION_EXPIRED');
  if(ownerOnly&&session.identityId)throw fail(403,'此操作需要自然人的管理登录态','OWNER_REQUIRED');
  return session;
 };
 const peer=(req:FastifyRequest)=>{const s=auth(req);if(!s.identityId)throw fail(403,'请先选择一个 IM 身份','IDENTITY_REQUIRED');return s.identityId};
 const addIdentity=async (ownerId:string,displayName:string,kind:IdentityKind)=>{
  if(store.identities(ownerId).length>=50)throw fail(400,'单个自然人最多创建 50 个身份');
  const id=`${kind==='agent'?'a':'h'}_${randomUUID().replaceAll('-','')}`;
  await importAccount(c,id,displayName);return store.addIdentity(ownerId,displayName,kind,id);
 };
 const creating=new Map<string,Promise<any>>();
 const sessionFor=async(subject:string,displayName:string)=>{
  const owner=store.owner(subject,displayName);
  let work=creating.get(owner.id);
  if(!store.identities(owner.id).length) {
   if(!work){work=addIdentity(owner.id,displayName,'human').finally(()=>creating.delete(owner.id));creating.set(owner.id,work)}
   await work;
  }
  return {...store.token(owner.id,null),ownerId:owner.id,identities:store.identities(owner.id)};
 };
 app.get('/api/config',async()=>({SDKAppID:c.appId,demoMode:c.demoMode,sso:true}));
 app.get('/health',async()=>({ok:true,app:'vela-im',role:'identity-service',SDKAppID:c.appId,imConfigured:!!c.imSecret,ssoConfigured:!!c.ssoSecret}));
 app.post('/api/auth/exchange',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req)=>{
  if(!c.ssoSecret)throw fail(503,'外层登录网关尚未配置','SSO_NOT_CONFIGURED');
  const {assertion}=req.body as any??{};
  if(typeof assertion!=='string'||assertion.length>12000)throw fail(400,'需要外层登录凭证');
  let payload;
  try {({payload}=await jwtVerify(assertion,new TextEncoder().encode(c.ssoSecret),{algorithms:['HS256'],issuer:c.ssoIssuer,audience:c.ssoAudience,requiredClaims:['sub','exp','iat'],maxTokenAge:'10m'}))}
  catch {throw fail(401,'外层登录凭证无效或已过期','INVALID_ASSERTION')}
  if(!payload.sub)throw fail(401,'外层用户 ID 缺失');
  return sessionFor(`${c.ssoIssuer}:${payload.sub}`,name(payload.name??payload.sub));
 });
 app.post('/api/auth/demo',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req)=>{
  if(!c.demoMode)throw fail(404,'演示入口未启用');
  if(store.demoParticipants().length>=200)throw fail(503,'演示身份已达 200 个上限，请联系演示维护者');
  const nonce=randomUUID();const displayName=name((req.body as any)?.name??`访客 ${nonce.slice(0,6)}`);
  const session=await sessionFor(`demo-visitor:${nonce}`,displayName);
  await enrollDemo(session.identities[0].id);return session;
 });
 // A LightVela session (from any LightVela client) maps to one natural person and its stable human IM identity.
 app.post('/api/auth/lightvela',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req)=>{
  const token=(req.headers.authorization??'').replace(/^Bearer /,'');
  const region=((req.body as any)?.region??'cn') as LightVelaRegion;
  if(!c.lightvelaApiBases?.[region])throw fail(400,'region 必须是 cn 或 intl');
  if(!token||token.length>4096)throw fail(401,'需要 LightVela 登录态','LIGHTVELA_TOKEN_REQUIRED');
  const user=await verifyLightVelaToken(c.lightvelaApiBases[region],token,options.lightvelaFetch);
  if(!user)throw fail(401,'LightVela 登录态无效或已过期','LIGHTVELA_TOKEN_INVALID');
  const session=await sessionFor(lightvelaSubject(region,user.id),user.name);
  const human=session.identities.find(i=>i.kind==='human')!;
  if(store.ownerName(session.ownerId)!==user.name||human.name!==user.name) {
   store.renameOwner(session.ownerId,user.name);store.renameIdentity(human.id,user.name);
   const profile=[{Tag:'Tag_Profile_IM_Nick',Value:user.name},...(user.avatarUrl?[{Tag:'Tag_Profile_IM_Image',Value:user.avatarUrl}]:[])];
   await adminCall(c,'profile/portrait_set',{From_Account:human.id,ProfileItem:profile}).catch(()=>{});
  }
  return {...session,identities:store.identities(session.ownerId),user:{id:user.id,name:user.name,avatarUrl:user.avatarUrl??null,region}};
 });
 // Registering an Agent gives it its own IM identity, befriends it with every identity of its owner,
 // and (when this environment hosts Agents) provisions the runtime that starts its IM worker.
 app.post('/api/agents',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  const s=auth(req,true);const displayName=name((req.body as any)?.name);
  const externalRef=(req.body as any)?.externalRef;
  if(externalRef!==undefined&&(typeof externalRef!=='string'||!externalRef.trim()||externalRef.length>128))throw fail(400,'externalRef 必须是 1 到 128 个字符的字符串');
  // One Agent per external reference: asking again returns the existing Agent.
  if(externalRef){const existing=store.agentByRef(s.ownerId,externalRef);if(existing)return {identity:store.identity(existing.id),agent:store.agent(existing.id)}}
  if(store.agents(s.ownerId).length>=20)throw fail(400,'单个自然人最多创建 20 个 Agent');
  const identity=await addIdentity(s.ownerId,displayName,'agent');
  await adminCall(c,'profile/portrait_set',{From_Account:identity.id,ProfileItem:[{Tag:'Tag_Profile_IM_AllowType',Value:'AllowType_Type_AllowAny'}]});
  const mine=store.identities(s.ownerId).filter(i=>i.id!==identity.id).map(i=>i.id);
  if(mine.length) {
   // Tencent accepts at most 8 letters after AddSource_Type_ and reports per-item failures inside a successful response.
   const r=await adminCall(c,'sns/friend_add',{From_Account:identity.id,AddType:'Add_Type_Both',ForceAddFlags:1,AddFriendItem:mine.slice(0,20).map(To_Account=>({To_Account,AddSource:'AddSource_Type_Owner'}))});
   const failed=(r?.ResultItem??[]).filter((i:{ResultCode?:number})=>i.ResultCode);
   if(failed.length)throw fail(502,`Agent 已创建，但与主人建立好友关系失败：${failed[0].ResultInfo??failed[0].ResultCode}`);
  }
  store.addAgent(identity.id,agentHost.name,externalRef??null);
  if(agentHost.name!=='none') {
   store.updateAgent(identity.id,{state:'provisioning'});
   const {token}=store.token(s.ownerId,identity.id,365*86400000);
   const ownerHumanId=store.identities(s.ownerId).find(i=>i.kind==='human')?.id;
   agentHost.provision({identityId:identity.id,name:displayName,ownerName:store.ownerName(s.ownerId)??'',token,...(ownerHumanId?{ownerHumanId}:{})})
    .then(({profile})=>store.updateAgent(identity.id,{state:'ready',profile}))
    .catch((e:Error)=>store.updateAgent(identity.id,{state:'error',error:String(e.message).split('\n')[0].slice(0,300)}));
  }
  reply.code(201);return {identity,agent:store.agent(identity.id)};
 });
 app.get('/api/agents',async req=>{const s=auth(req,true);return {host:agentHost.name,agents:store.agents(s.ownerId)}});
 // Find people and Agents to befriend or invite. Works for both owner and identity sessions.
 app.get('/api/directory',{config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async req=>{
  auth(req);const q=String((req.query as any)?.q??'').slice(0,64);
  return {results:store.searchIdentities(q).map(({id,name,kind,ownerName})=>({id,name,kind,ownerName}))};
 });
 app.get('/api/demo/participants',async(req)=>{
  if(!c.demoMode)throw fail(404,'演示入口未启用');const s=auth(req);
  if(!store.identities(s.ownerId).some(i=>store.isDemoIdentity(i.id)))throw fail(403,'此登录态不属于演示空间');
  return {participants:store.demoParticipants().map(({id,name,kind})=>({id,name,kind}))};
 });
 app.delete('/api/auth/logout',async(req)=>{auth(req);store.revoke((req.headers.authorization??'').replace(/^Bearer /,''));return {ok:true}});
 app.get('/api/me',async(req)=>{
  const s=auth(req);return {...s,identities:s.identityId?[store.identity(s.identityId)]:store.identities(s.ownerId)};
 });
 app.post('/api/identities',async(req)=>{
  const s=auth(req,true);const b=req.body as any;
  if(!['human','agent'].includes(b?.kind))throw fail(400,'kind 必须是 human 或 agent');
  if(c.demoMode&&store.identities(s.ownerId).some(i=>store.isDemoIdentity(i.id))&&store.demoParticipants().length>=200)throw fail(503,'演示身份已达上限');
  const identity=await addIdentity(s.ownerId,name(b?.name),b.kind);
  if(c.demoMode&&store.identities(s.ownerId).some(i=>store.isDemoIdentity(i.id)))await enrollDemo(identity.id);
  return identity;
 });
 app.post<{Params:{id:string}}>('/api/identities/:id/tokens',async(req)=>{
  const s=auth(req,true),identity=store.identity(req.params.id);
  if(!identity||identity.ownerId!==s.ownerId)throw fail(404,'身份不存在');
  return {...store.token(s.ownerId,identity.id),identity};
 });
 app.delete<{Params:{id:string}}>('/api/identities/:id/tokens',async(req)=>{
  const s=auth(req,true),identity=store.identity(req.params.id);
  if(!identity||identity.ownerId!==s.ownerId)throw fail(404,'身份不存在');
  store.revokeIdentity(identity.id);return {ok:true};
 });
 const ownedIdentity=(req:FastifyRequest<{Params:{id:string}}>)=>{
  const s=auth(req,true),identity=store.identity(req.params.id);
  if(!identity||identity.ownerId!==s.ownerId)throw fail(404,'身份不存在');
  return identity;
 };
 app.get<{Params:{id:string}}>('/api/identities/:id/settings',async req=>{const i=ownedIdentity(req);return {identityID:i.id,...store.identitySettings(i.id)}});
 app.put<{Params:{id:string}}>('/api/identities/:id/settings',async req=>{
  const i=ownedIdentity(req);const policy=(req.body as any)?.commandPolicy;
  if(!['owner','anyone'].includes(policy))throw fail(400,'commandPolicy 必须是 owner 或 anyone');
  store.setIdentitySettings(i.id,policy);return {identityID:i.id,...store.identitySettings(i.id)};
 });
 // An identity learns its own control settings and which identities belong to its owner (the same natural person).
 app.get('/api/control',async req=>{
  const id=peer(req),identity=store.identity(id)!;
  return {identity:{id,kind:identity.kind,name:identity.name},...store.identitySettings(id),
   owner:{identities:store.identities(identity.ownerId).map(({id,name,kind})=>({id,name,kind}))}};
 });
 app.get('/api/credentials',async(req)=>{
  const id=peer(req);return {SDKAppID:c.appId,userID:id,userSig:userSig(c.appId,c.imSecret,id,7200),expiresAt:Date.now()+7200000};
 });
 app.get<{Params:{id:string}}>('/api/groups/:id/reply-policy',async req=>groups.read(req.params.id,peer(req)));
 app.put<{Params:{id:string}}>('/api/groups/:id/reply-policy',async req=>groups.update(req.params.id,peer(req),(req.body as any)?.mode));
 if(existsSync(c.webDir))await app.register(serveStatic,{root:c.webDir,prefix:'/',wildcard:false});
 app.setNotFoundHandler((_req,reply)=>reply.code(404).send({error:'路径不存在',code:404}));
 app.addHook('onClose',async()=>{store.close()});
 return {app,store};
}
