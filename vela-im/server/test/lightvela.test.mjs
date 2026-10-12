import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {buildApp} from '../dist/app.js';
import {LocalHermesHost,profileName} from '../dist/agent-host.js';

const config=dir=>({appId:1600166071,imSecret:'test-only-im-key',admin:'administrator',restHost:'console.tim.qq.com',host:'127.0.0.1',port:0,dataDir:dir,ssoSecret:'',ssoIssuer:'test-login',ssoAudience:'vela-im',allowedOrigins:['http://localhost'],demoMode:false,webDir:'/nonexistent',
 lightvelaApiBases:{cn:'https://lightvela.test',intl:'https://lightvela-intl.test'}});
const users={'token-alice':{id:'u-alice',name:'Alice'},'token-alice-phone':{id:'u-alice',name:'Alice Chen'},'token-bob':{id:'u-bob',name:'Bob'}};
const lightvelaFetch=async(url,init)=>{
 assert.match(String(url),/^https:\/\/lightvela(-intl)?\.test\/auth\/profile$/);
 const user=users[init.headers.Authorization.replace('Bearer ','')];
 return user?new Response(JSON.stringify({user}),{status:200}):new Response('{}',{status:401});
};
const harness=async(dir,options={})=>{
 const calls=[];
 const {app,store}=await buildApp(config(dir),{provision:async()=>{},lightvelaFetch,adminCall:async(_c,command,body)=>{calls.push({command,body});return {}},...options});
 const request=(method,url,token,payload)=>app.inject({method,url,payload,headers:token?{authorization:`Bearer ${token}`}:{}});
 return {app,store,calls,request};
};

test('a LightVela user gets the same human IM identity from every client and region stays separate',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-lv-'));const {app,calls,request}=await harness(dir);
 try {
  assert.equal((await request('POST','/api/auth/lightvela','',{})).statusCode,401);
  assert.equal((await request('POST','/api/auth/lightvela','forged',{})).statusCode,401);
  assert.equal((await request('POST','/api/auth/lightvela','token-alice',{region:'mars'})).statusCode,400);
  const web=(await request('POST','/api/auth/lightvela','token-alice',{region:'cn'})).json();
  const phone=(await request('POST','/api/auth/lightvela','token-alice-phone',{region:'cn'})).json();
  assert.equal(phone.ownerId,web.ownerId);
  assert.deepEqual(phone.identities.map(i=>i.id),web.identities.map(i=>i.id));
  assert.equal(phone.identities[0].kind,'human');
  assert.equal(phone.identities[0].name,'Alice Chen');
  assert.equal(phone.user.id,'u-alice');
  assert.ok(calls.some(c=>c.command==='profile/portrait_set'&&c.body.From_Account===web.identities[0].id&&c.body.ProfileItem[0].Value==='Alice Chen'));
  const intl=(await request('POST','/api/auth/lightvela','token-alice',{region:'intl'})).json();
  assert.notEqual(intl.ownerId,web.ownerId);
  assert.notEqual(web.token,phone.token);
  assert.equal((await request('GET','/api/me',web.token)).json().ownerId,web.ownerId);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});

test('creating an Agent registers its identity, befriends the owner and provisions its runtime',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-agent-'));
 const provisioned=[];let release;const gate=new Promise(r=>{release=r});
 const agentHost={name:'local',provision:async input=>{provisioned.push(input);await gate;return {profile:profileName(input.identityId)}}};
 const {app,calls,request}=await harness(dir,{agentHost});
 try {
  const alice=(await request('POST','/api/auth/lightvela','token-alice',{})).json();
  const bob=(await request('POST','/api/auth/lightvela','token-bob',{})).json();
  assert.equal((await request('POST','/api/agents',alice.token,{name:''})).statusCode,400);
  const created=await request('POST','/api/agents',alice.token,{name:'研究助手'});
  assert.equal(created.statusCode,201);
  const {identity,agent}=created.json();
  assert.equal(identity.kind,'agent');assert.equal(agent.state,'provisioning');
  assert.ok(calls.some(c=>c.command==='profile/portrait_set'&&c.body.From_Account===identity.id&&c.body.ProfileItem[0].Value==='AllowType_Type_AllowAny'));
  const friend=calls.find(c=>c.command==='sns/friend_add');
  assert.equal(friend.body.From_Account,identity.id);
  assert.deepEqual(friend.body.AddFriendItem.map(i=>i.To_Account),[alice.identities[0].id]);
  for(const item of friend.body.AddFriendItem)assert.match(item.AddSource,/^AddSource_Type_[A-Za-z]{1,8}$/);
  assert.equal(provisioned[0].identityId,identity.id);assert.equal(provisioned[0].ownerName,'Alice');assert.equal(provisioned[0].ownerHumanId,alice.identities[0].id);
  // The provisioned token authenticates as the Agent, never as its owner.
  const control=(await request('GET','/api/control',provisioned[0].token)).json();
  assert.equal(control.identity.id,identity.id);
  release();await new Promise(r=>setTimeout(r,10));
  const listed=(await request('GET','/api/agents',alice.token)).json();
  assert.equal(listed.host,'local');assert.equal(listed.agents[0].state,'ready');assert.equal(listed.agents[0].profile,profileName(identity.id));
  assert.deepEqual((await request('GET','/api/agents',bob.token)).json().agents,[]);
  assert.equal((await request('POST','/api/agents',provisioned[0].token,{name:'x'})).statusCode,403);
  const second=(await request('POST','/api/agents',alice.token,{name:'写作助手'})).json();
  const friend2=calls.filter(c=>c.command==='sns/friend_add')[1];
  assert.deepEqual(friend2.body.AddFriendItem.map(i=>i.To_Account).sort(),[alice.identities[0].id,identity.id].sort());
  // Directory search: exact ID first, then name fragments; LIKE wildcards are literal.
  const byId=(await request('GET',`/api/directory?q=${second.identity.id}`,bob.token)).json().results;
  assert.equal(byId[0].id,second.identity.id);assert.equal(byId[0].ownerName,'Alice');
  assert.deepEqual((await request('GET',`/api/directory?q=${encodeURIComponent('助手')}`,bob.token)).json().results.map(r=>r.name).sort(),['写作助手','研究助手']);
  assert.deepEqual((await request('GET','/api/directory?q=%25',bob.token)).json().results,[]);
  assert.equal((await request('GET','/api/directory?q=Alice')).statusCode,401);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});

test('a friendship rejected inside a successful Tencent response fails Agent creation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-agent-friend-'));
 const adminCall=async(_c,command)=>command==='sns/friend_add'?{ActionStatus:'OK',ErrorCode:0,ResultItem:[{To_Account:'h_x',ResultCode:30001,ResultInfo:'Err_SNS_FriendAdd_Add_Source_Illegal'}]}:{};
 const {app,request}=await harness(dir,{adminCall,agentHost:{name:'local',provision:async()=>{throw new Error('must not provision')}}});
 try {
  const alice=(await request('POST','/api/auth/lightvela','token-alice',{})).json();
  const r=await request('POST','/api/agents',alice.token,{name:'助手'});
  assert.equal(r.statusCode,502);assert.match(r.json().error,/Add_Source_Illegal/);
  assert.deepEqual((await request('GET','/api/agents',alice.token)).json().agents,[]);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});

test('an external reference maps to exactly one Agent per owner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-agent-ref-'));const provisioned=[];
 const {app,request}=await harness(dir,{agentHost:{name:'local',provision:async input=>{provisioned.push(input);return {profile:'p'}}}});
 try {
  const alice=(await request('POST','/api/auth/lightvela','token-alice',{})).json();
  const bob=(await request('POST','/api/auth/lightvela','token-bob',{})).json();
  assert.equal((await request('POST','/api/agents',alice.token,{name:'A',externalRef:''})).statusCode,400);
  const first=(await request('POST','/api/agents',alice.token,{name:'小助手',externalRef:'lightvela-bot:b1'})).json();
  const again=await request('POST','/api/agents',alice.token,{name:'改名也一样',externalRef:'lightvela-bot:b1'});
  assert.equal(again.statusCode,200);assert.equal(again.json().identity.id,first.identity.id);
  const other=(await request('POST','/api/agents',bob.token,{name:'小助手',externalRef:'lightvela-bot:b1'})).json();
  assert.notEqual(other.identity.id,first.identity.id);
  assert.equal(provisioned.length,2);
  const [listed]=(await request('GET','/api/agents',alice.token)).json().agents;
  assert.equal(listed.externalRef,'lightvela-bot:b1');
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});

test('agent provisioning failures are recorded instead of crashing the request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-agent-fail-'));
 const {app,request}=await harness(dir,{agentHost:{name:'local',provision:async()=>{throw new Error('hermes missing\nstack')}}});
 try {
  const alice=(await request('POST','/api/auth/lightvela','token-alice',{})).json();
  assert.equal((await request('POST','/api/agents',alice.token,{name:'助手'})).statusCode,201);
  await new Promise(r=>setTimeout(r,10));
  const [agent]=(await request('GET','/api/agents',alice.token)).json().agents;
  assert.equal(agent.state,'error');assert.equal(agent.error,'hermes missing');
 }finally{await app.close();rmSync(dir,{recursive:true,force:true})}
});

test('local Hermes host creates one profile per Agent wired to the vela-im plugin',async()=>{
 const root=mkdtempSync(join(tmpdir(),'vela-hermes-'));
 const home=join(root,'home'),plugin=join(root,'plugin');
 mkdirSync(join(plugin,'vela_im'),{recursive:true});mkdirSync(join(plugin,'tests'),{recursive:true});
 writeFileSync(join(plugin,'plugin.yaml'),'name: vela-im\n');writeFileSync(join(plugin,'vela_im','__init__.py'),'');writeFileSync(join(plugin,'tests','test_plugin.py'),'');
 mkdirSync(home,{recursive:true});writeFileSync(join(home,'config.yaml'),'model:\n  default: test-model\n');
 const execs=[];
 const exec=async(file,args,options)=>{
  execs.push({file,args,home:options.env?.HERMES_HOME});
  if(args[0]==='profile'){const dir=join(home,'profiles',args[2]);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'config.yaml'),'model:\n  default: test-model\nplugins:\n  enabled: [other]\n');writeFileSync(join(dir,'.env'),'OPENAI_API_KEY=keep\nVELA_IDENTITY_TOKEN=old\n')}
  return {stdout:'',stderr:''};
 };
 try {
  const host=new LocalHermesHost({mode:'local',hermesBin:'/opt/hermes',hermesHome:home,pluginDir:plugin,apiUrl:'http://127.0.0.1:8787',nodeBin:'/opt/node',restartCommand:'restart-gateway'},exec,10);
  const [a,b]=await Promise.all([host.provision({identityId:'a_0123456789abcdef0123456789abcdef',name:'助手',ownerName:'Alice',token:'secret-a',ownerHumanId:'h_alice'}),host.provision({identityId:'a_ffff',name:'B',ownerName:'Alice',token:'secret-b'})]);
  assert.equal(a.profile,'vela-0123456789abcdef01234567');assert.equal(b.profile,'vela-ffff');
  // Agents created together share a single gateway restart.
  assert.deepEqual(execs.map(e=>e.args[0]==='profile'?`create:${e.args[2]}`:'restart'),['create:vela-0123456789abcdef01234567','create:vela-ffff','restart']);
  assert.equal(execs[0].home,home);assert.deepEqual(execs[0].args,['profile','create','vela-0123456789abcdef01234567','--clone','--clone-from','default','--no-alias']);
  const dir=join(home,'profiles',a.profile);
  assert.ok(existsSync(join(dir,'plugins','vela-im','vela_im','__init__.py')));
  assert.ok(!existsSync(join(dir,'plugins','vela-im','tests')));
  const env=readFileSync(join(dir,'.env'),'utf8');
  assert.match(env,/^OPENAI_API_KEY=keep$/m);assert.match(env,/^VELA_IDENTITY_TOKEN=secret-a$/m);assert.doesNotMatch(env,/=old$/m);
  assert.match(env,/^VELA_API_URL=http:\/\/127\.0\.0\.1:8787$/m);assert.match(env,/^VELA_HOME_CHANNEL=C2Ch_alice$/m);assert.match(env,/^VELA_NODE_BIN=\/opt\/node$/m);
  const profile=parse(readFileSync(join(dir,'config.yaml'),'utf8'));
  assert.equal(profile.model.default,'test-model');
  assert.deepEqual(profile.plugins.enabled,['vela-im']);assert.equal(profile.platforms.vela_im.enabled,true);
  assert.deepEqual(profile.platform_toolsets,{vela_im:['vela_im']});
  assert.match(readFileSync(join(dir,'SOUL.md'),'utf8'),/助手.*Alice/);
  assert.equal(parse(readFileSync(join(home,'config.yaml'),'utf8')).gateway.multiplex_profiles,true);
  // Re-provisioning reuses the profile and rotates the credential.
  execs.length=0;await host.provision({identityId:'a_ffff',name:'B',ownerName:'Alice',token:'secret-c'});
  assert.deepEqual(execs.map(e=>e.args[0]),['-c']);
  assert.match(readFileSync(join(home,'profiles','vela-ffff','.env'),'utf8'),/^VELA_IDENTITY_TOKEN=secret-c$/m);
 }finally{rmSync(root,{recursive:true,force:true})}
});
