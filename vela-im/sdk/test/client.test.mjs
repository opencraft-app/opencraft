import test from 'node:test';
import assert from 'node:assert/strict';
import {
 VelaHumanAPI,VelaBotAPI,groupReplyReason,readLineage,replyCustomData,IM_METHODS,uuidv7,tencentGroupId,platformGroupId,
 policyFromGroup,defaultGroupPolicy,isPolicyNotice,assertMethod,VelaError,
} from '../dist/index.js';
import {VelaIMClient} from '../dist/client.js';
import {fakeChat,hooks,credentials} from './fake-chat.mjs';

async function connected(answers) {
 const fake=fakeChat(answers);const client=new VelaIMClient(fake.TencentCloudChat,hooks);
 await client.connect(async()=>credentials());return {client,...fake};
}
const last=(calls,name)=>calls.filter(c=>c[0]===name).at(-1);
const policy=(mode,members=[])=>({groupID:'vg_x',platformGroupId:'x',mode,effectiveMode:mode,contextMessages:mode==='mention_context'?10:0,members,canManage:false});

test('clients cannot imitate the platform\'s system notices',async()=>{
 const {client}=await connected({});
 for(const businessID of ['vela_group_policy','group_create'])
  await assert.rejects(client.send({to:'vg_x',conversationType:'GROUP',type:'custom',payload:{data:JSON.stringify({businessID})}}),e=>e.code==='RESERVED_NOTICE',businessID);
});

test('every high-level IM method is implemented by the shared client',()=>{
 for(const method of IM_METHODS)assert.equal(typeof VelaIMClient.prototype[method],'function',method);
});

test('group membership changes are not available through the raw SDK passthrough',()=>{
 for(const method of ['createGroup','addGroupMember','deleteGroupMember','quitGroup','dismissGroup','changeGroupOwner','setGroupMemberRole','joinGroup',
  'updateGroupProfile','setGroupMemberMuteTime','setGroupAttributes','handleGroupApplication','addToBlacklist','clearHistoryMessage','invite',
  'updateMyProfile','addFriend','searchCloudUsers','modifyMessage'])
  assert.throws(()=>assertMethod(method),e=>e.code==='METHOD_NOT_ALLOWED',method);
 for(const method of ['createGroup','addGroupMembers','removeGroupMembers','quitGroup','dismissGroup'])
  assert.equal(typeof VelaIMClient.prototype[method],'undefined',method);
});

test('friend operations use ordinary confirmation rules with Tencent constants, not page-built parameters',async()=>{
 const {client,calls}=await connected({
  getFriendApplicationList:{data:{friendApplicationList:[{userID:'h_in',type:'Pendency_Type_ComeIn'},{userID:'a_out',type:'Pendency_Type_SendOut'}]}},
  getFriendList:{data:[{userID:'h_friend'}]},
 });
 await client.addFriend('h_peer',{wording:'hi'});
 assert.deepEqual(last(calls,'addFriend')[1],{to:'h_peer',source:'AddSource_Type_Vela',wording:'hi',remark:'',type:'Add_Type_Both'});
 assert.deepEqual((await client.getFriendApplications()).map(a=>[a.userID,a.direction]),[['h_in','incoming'],['a_out','outgoing']]);
 await client.acceptFriend('h_in');assert.deepEqual(last(calls,'acceptFriendApplication')[1],{userID:'h_in',type:'Response_Action_AgreeAndAdd'});
 await client.deleteFriend('h_friend');assert.deepEqual(last(calls,'deleteFriend')[1],{userIDList:['h_friend'],type:'Delete_Type_Both'});
});

test('all eleven message types reach the native factory; @all aliases map to the SDK token; group IDs lose the GROUP prefix',async()=>{
 const {client,calls}=await connected();
 for(const type of ['text','location','face','custom'])await client.send({to:'a_peer',conversationType:'C2C',type,payload:{native:'untouched'}});
 await client.send({to:'GROUPvg_0198f4c27a357f1486ab2e57552e473f',conversationType:'GROUP',type:'textAt',payload:{text:'hello',atUserList:['@all','all','a_peer']}});
 assert.deepEqual(last(calls,'createTextAtMessage')[1].payload.atUserList,['__kImSDK_MesssageAtALL__','__kImSDK_MesssageAtALL__','a_peer']);
 assert.equal(last(calls,'createTextAtMessage')[1].to,'vg_0198f4c27a357f1486ab2e57552e473f');
 await client.send({to:'a_peer',conversationType:'C2C',type:'image',payload:{},attachment:{name:'a.png',mimeType:'image/png',base64:Buffer.from('png').toString('base64')}});
 assert(last(calls,'createImageMessage')[1].payload.file instanceof File);
 await assert.rejects(client.send({to:'a_peer',conversationType:'C2C',type:'audio',payload:{},attachment:{name:'a.bin',mimeType:'audio/x',base64:'AA=='}}),e=>e.code==='AUDIO_DURATION_REQUIRED');
 const sent=(await client.send({to:'a_peer',conversationType:'C2C',type:'text',payload:{text:'x'}})).data.message;
 await client.send({to:'h_peer',conversationType:'C2C',type:'forward',payload:{},messageIDs:[sent.ID]});
 assert.equal(last(calls,'createForwardMessage')[1].payload.ID,sent.ID);
});

test('history reads cloud roaming: groups page by sequence, C2C by time, never the local-cache getMessageList',async()=>{
 const {client,calls}=await connected({
  getMessageListHopping:opts=>({data:opts.conversationID.startsWith('GROUP')
   ?(opts.sequence?{messageList:[{ID:'1',sequence:1}],isCompleted:true,nextMessageSeq:''}:{messageList:[{ID:'2',sequence:2},{ID:'3',sequence:3}],isCompleted:false,nextMessageSeq:'1'})
   :(opts.time?{messageList:[{ID:'old',time:90}],isCompleted:true}:{messageList:[{ID:'new',time:100}],isCompleted:false,nextMessageTime:90})}),
 });
 const first=await client.getMessages('GROUP@TGS#g');assert.deepEqual(first,{messageList:[{ID:'2',sequence:2},{ID:'3',sequence:3}],isCompleted:false,nextReqMessageID:'1'});
 const c2c=await client.getMessages('C2Ca_peer');assert.deepEqual(c2c,{messageList:[{ID:'new',time:100}],isCompleted:false,nextReqMessageID:'90'});
 assert.equal(calls.some(c=>c[0]==='getMessageList'),false);
});

test('group reply: ten preceding ordinary messages under the platform policy passed in by the caller',async()=>{
 const row=(ID,extra={})=>({ID,from:'h_human',type:'TIMTextElem',conversationID:'GROUPvg_x',sequence:Number(ID)||0,payload:{text:'m'+ID},...extra});
 const trigger=row('100',{atUserList:['a_self']});
 const pages=[
  {messageList:[...Array.from({length:6},(_,i)=>row(String(i+6))),row('tip',{type:'TIMGroupTipElem'}),row('gone',{isRevoked:true}),trigger,row('101')],isCompleted:false,nextMessageSeq:'6'},
  {messageList:Array.from({length:7},(_,i)=>row(String(i))),isCompleted:true,nextMessageSeq:''},
 ];
 const {client}=await connected({getMessageListHopping:()=>({data:pages.shift()})});
 const input=await client.prepareGroupReply(trigger,policy('mention_context'));
 assert.equal(input.shouldReply,true);assert.equal(input.contextStatus,'complete');
 assert.deepEqual(input.context.map(m=>m.ID),['2','3','4','5','6','7','8','9','10','11']);
 assert.equal((await client.prepareGroupReply(row('quiet'),policy('mention'))).reason,'not_mentioned');
 await assert.rejects(client.prepareGroupReply({...trigger,conversationID:'C2Ch'},policy('all')),e=>e.code==='NOT_GROUP_MESSAGE');
 await assert.rejects(client.prepareGroupReply(trigger,policy('all'),{maxAgentHops:0}),e=>e.code==='INVALID_HOPS');
});

test('admission and lineage are identical for humans and bots; the platform policy notice is a system event',()=>{
 const rules={effectiveMode:'mention'};
 const m=(extra)=>({ID:'m',from:'h_x',type:'TIMTextElem',payload:{text:'hi'},...extra});
 assert.equal(groupReplyReason(m({from:'a_self'}),'a_self',rules),'self');
 assert.equal(groupReplyReason(m({isRevoked:true}),'a_self',rules),'revoked');
 assert.equal(groupReplyReason(m({type:'TIMGroupSystemNoticeElem'}),'a_self',rules),'system');
 const notice=m({type:'TIMCustomElem',payload:{data:JSON.stringify({businessID:'vela_group_policy',replyMode:'all'})}});
 assert.equal(isPolicyNotice(notice),true);assert.equal(groupReplyReason(notice,'a_self',{effectiveMode:'all'}),'system');
 const created=m({type:'TIMCustomElem',payload:{data:JSON.stringify({businessID:'group_create',opUser:'u_owner',cmd:0,version:4})}});
 assert.equal(isPolicyNotice(created),false);assert.equal(groupReplyReason(created,'a_self',{effectiveMode:'all'}),'system');
 assert.equal(groupReplyReason(m({atUserList:['__kImSDK_MesssageAtALL__']}),'a_self',rules),'accepted');
 const looped=m({cloudCustomData:replyCustomData({chainId:'root',hops:5})});
 assert.deepEqual(readLineage(looped),{chainId:'root',hops:6});
 assert.equal(groupReplyReason(looped,'a_self',{effectiveMode:'all'}),'hop_limit');
 const third=m({cloudCustomData:replyCustomData({chainId:'root',hops:2})});
 assert.equal(groupReplyReason(third,'a_self',{effectiveMode:'all'}),'hop_limit','three Agent hops by default');
});

test('"no @ needed" wakes every Agent for people, but Agents hand off to each other only by @ when people are present',()=>{
 const members=[{userId:'u_owner',kind:'human',role:'owner'},{userId:'a_peer',kind:'bot',role:'member'},{userId:'a_self',kind:'bot',role:'member'}];
 const withPeople={effectiveMode:'all',members};
 const said=(from,extra={})=>({ID:'m',from,type:'TIMTextElem',payload:{text:'hi'},...extra});
 assert.equal(groupReplyReason(said('u_owner'),'a_self',withPeople),'accepted');
 const answer=said('a_peer',{cloudCustomData:replyCustomData({chainId:'root',hops:0})});
 assert.equal(groupReplyReason(answer,'a_self',withPeople),'agent_not_mentioned');
 assert.equal(groupReplyReason({...answer,atUserList:['a_self']},'a_self',withPeople),'accepted');
 assert.equal(groupReplyReason(said('a_peer'),'a_self',withPeople),'agent_not_mentioned','an Agent posting without lineage is still an Agent');
 const agentsOnly={effectiveMode:'all',members:members.filter(m=>m.kind==='bot')};
 assert.equal(groupReplyReason(answer,'a_self',agentsOnly),'accepted');
});

test('platform group IDs round-trip between UUID and Tencent GroupId; foreign groups default to mention-only',()=>{
 const id=uuidv7();
 assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.equal(platformGroupId(tencentGroupId(id)),id);
 assert.equal(platformGroupId('GROUP'+tencentGroupId(id)),id);
 assert.equal(platformGroupId('@TGS#abc'),null);
 assert.deepEqual(defaultGroupPolicy('GROUP@TGS#abc'),{groupID:'@TGS#abc',platformGroupId:null,mode:'mention',effectiveMode:'mention',contextMessages:0,members:[],canManage:false});
 const view=policyFromGroup({id,tencentGroupId:tencentGroupId(id),name:'g',replyMode:'mention',effectiveReplyMode:'all',contextMessages:0,state:'active',revision:1,members:[],viewerRole:'admin'});
 assert.equal(view.effectiveMode,'all');assert.equal(view.canManage,true);
});

test('Human API calls the backend with the host-provided login header and unwraps the error envelope',async()=>{
 const requests=[];
 const fetch=async(url,init)=>{
  requests.push([url,init]);
  if(url.endsWith('/me/im/session'))return new Response(JSON.stringify({sdkAppId:7,userId:'u_me',userSig:'sig',expiresAt:'2030-01-01T00:00:00Z'}),{status:200});
  if(url.endsWith('/me/groups'))return new Response(JSON.stringify({error:{code:'im_identity_unknown',message:'成员尚未开通'}}),{status:422});
  return new Response('',{status:204});
 };
 const api=new VelaHumanAPI('https://api.example.com/v1/collaboration',{headers:()=>({Authorization:'Bearer lightvela'}),fetch});
 const session=await api.imSession();
 assert.deepEqual(session,{SDKAppID:7,userID:'u_me',userSig:'sig',expiresAt:Date.parse('2030-01-01T00:00:00Z')});
 assert.equal(requests[0][0],'https://api.example.com/v1/collaboration/me/im/session');
 assert.equal(requests[0][1].headers.Authorization,'Bearer lightvela');
 await assert.rejects(api.createGroup({name:'x',memberUserIds:['a_unknown']}),e=>e.code==='im_identity_unknown'&&e.status===422);
 const created=JSON.parse(requests[1][1].body);
 assert.match(created.groupId,/^[0-9a-f-]{36}$/,'creation carries a client-generated UUIDv7 so retries are idempotent');
});

test('Human UserSig exchange waits out the first-sighting IM import, but not other failures',async()=>{
 let calls=0;
 const pending=()=>new Response(JSON.stringify({error:{code:'im_session_unavailable',message:'IM 身份尚未就绪'}}),{status:503});
 const ready=new VelaHumanAPI('https://x/v1/collaboration',{fetch:async()=>++calls<3?pending():
  new Response(JSON.stringify({sdkAppId:7,userId:'u_me',userSig:'sig',expiresAt:'2030-01-01T00:00:00Z'}),{status:200})});
 assert.equal((await ready.imSession(1)).userID,'u_me');
 assert.equal(calls,3);
 const never=new VelaHumanAPI('https://x/v1/collaboration',{fetch:async()=>pending()});
 await assert.rejects(never.imSession(1,4),e=>e.code==='im_session_unavailable');
 let restricted=0;
 const banned=new VelaHumanAPI('https://x/v1/collaboration',{fetch:async()=>{restricted++;
  return new Response(JSON.stringify({error:{code:'im_identity_restricted',message:'已封禁'}}),{status:403})}});
 await assert.rejects(banned.imSession(1),e=>e.code==='im_identity_restricted');
 assert.equal(restricted,1);
});

test('Bot API exchanges the credential once, then uses the short-lived token and renews it on 401',async()=>{
 const requests=[];let sessions=0;let rejectNext=false;
 const session=()=>({accessToken:`token-${++sessions}`,expiresAt:new Date(Date.now()+3600000).toISOString(),
  bot:{id:'b',userId:'a_self',displayName:'助手',commandPolicy:'owner',ownerUserIds:['u_owner']},
  im:{sdkAppId:7,userId:'a_self',userSig:'sig',expiresAt:new Date(Date.now()+3600000).toISOString()}});
 const fetch=async(url,init)=>{
  requests.push([url,init.headers.Authorization]);
  if(url.endsWith('/runtime/bot/session'))return new Response(JSON.stringify(session()),{status:200});
  if(rejectNext){rejectNext=false;return new Response(JSON.stringify({error:{code:'runtime_credential_revoked',message:'x'}}),{status:401})}
  return new Response(JSON.stringify({id:'b',userId:'a_self',displayName:'助手',commandPolicy:'anyone',ownerUserIds:[]}),{status:200});
 };
 const api=new VelaBotAPI('http://127.0.0.1:18080/v1',()=>'vbc_secret\n',fetch);
 const creds=await api.credentials();assert.equal(creds.userID,'a_self');
 assert.equal(requests[0][1],'BotCredential vbc_secret');
 assert.equal((await api.me()).commandPolicy,'anyone');
 assert.equal(requests[1][1],'Bearer token-1');
 rejectNext=true;await api.me();
 assert.deepEqual(requests.slice(2).map(r=>r[1]),['Bearer token-1','BotCredential vbc_secret','Bearer token-2']);
});

test('after the platform signs the identity out, the client keeps asking and is back once the restriction is lifted',async(t)=>{
 const fake=fakeChat();let restricted=false;let asked=0;
 const client=new VelaIMClient(fake.TencentCloudChat,hooks);
 await client.connect(async()=>{asked++;if(restricted)throw new VelaError('该 Bot 已被限制','im_identity_restricted',403);return credentials()});
 t.mock.timers.enable({apis:['setTimeout']});
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 restricted=true;fake.native.user=null;fake.native.emit('onKickedOut',{type:'REST_API_Kick'});
 t.mock.timers.tick(15000);await settle();
 assert.equal(asked,2,'asks again while restricted');
 restricted=false;
 t.mock.timers.tick(30000);await settle();t.mock.timers.tick(0);await settle();
 assert.equal(asked,3);
 assert.deepEqual(fake.calls.filter(c=>c[0]==='login').map(c=>c[1]),['a_self','a_self'],'logged in again after release');
 await client.disconnect();
});

test('a failed UserSig renewal keeps retrying until the platform answers again',async(t)=>{
 const fake=fakeChat();let down=false;let asked=0;
 const client=new VelaIMClient(fake.TencentCloudChat,hooks);
 await client.connect(async()=>{asked++;if(down)throw new VelaError('暂时无法签发 IM 会话','im_session_unavailable',503);return credentials()});
 t.mock.timers.enable({apis:['setTimeout']});
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 down=true;fake.native.user=null;fake.native.emit('onKickedOut',{type:'userSigExpired'});await settle();
 assert.equal(asked,2,'renews right after the UserSig expired');
 t.mock.timers.tick(15000);await settle();
 assert.equal(asked,3,'a failed renewal is retried');
 down=false;
 t.mock.timers.tick(30000);await settle();t.mock.timers.tick(0);await settle();
 assert.equal(asked,4);
 assert.deepEqual(fake.calls.filter(c=>c[0]==='login').map(c=>c[1]),['a_self','a_self'],'back online without a restart');
 await client.disconnect();
});

test('UserSig renewal re-logs in with fresh credentials and keeps subscriptions; concurrent disconnects tear down once',async()=>{
 const fake=fakeChat();let issued=0;
 const client=new VelaIMClient(fake.TencentCloudChat,hooks);
 await client.connect(async()=>credentials('a_self',Date.now()+3600000+issued++));
 let friendEvents=0;client.on('FRIEND_LIST_UPDATED',()=>friendEvents++);
 await client.renew();
 assert.deepEqual(fake.calls.filter(c=>c[0]==='login'||c[0]==='logout').map(c=>c[0]),['login','logout','login']);
 assert.equal(issued,2);fake.native.emit('onFriendListUpdated',[]);assert.equal(friendEvents,1);
 await Promise.all([client.disconnect(),client.disconnect()]);
 assert.equal(fake.calls.filter(c=>c[0]==='destroy').length,1);assert.equal(client.native,undefined);
});
