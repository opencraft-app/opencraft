import test from 'node:test';
import assert from 'node:assert/strict';
import {VelaAPI,groupReplyReason,readLineage,replyCustomData,IM_METHODS} from '../dist/index.js';
import {VelaIMClient} from '../dist/client.js';
import {fakeChat,hooks,credentials} from './fake-chat.mjs';

async function connected(answers,api=new VelaAPI('http://unused')) {
 const fake=fakeChat(answers);const client=new VelaIMClient(api,fake.TencentCloudChat,hooks);
 await client.connect(credentials());return {client,...fake};
}
const last=(calls,name)=>calls.filter(c=>c[0]===name).at(-1);

test('every high-level IM method is implemented by the shared client',()=>{
 for(const method of IM_METHODS)assert.equal(typeof VelaIMClient.prototype[method],'function',method);
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
 await client.refuseFriend('h_x');assert.deepEqual(last(calls,'refuseFriendApplication')[1],{userID:'h_x'});
 await client.deleteFriend('h_friend');assert.deepEqual(last(calls,'deleteFriend')[1],{userIDList:['h_friend'],type:'Delete_Type_Both'});
 assert.deepEqual(await client.getFriends(),[{userID:'h_friend'}]);
});

test('group lifecycle: create with members, add, kick, roles, quit and dismiss normalise conversation prefixes',async()=>{
 let page=0;
 const {client,calls}=await connected({
  createGroup:opts=>({data:{group:{groupID:'@TGS#new',...opts}}}),
  getGroupMemberList:()=>({data:page++===0?{memberList:[{userID:'a_self',role:'Owner'}],offset:1}:{memberList:[{userID:'h_peer',role:'Member'}],offset:0}}),
 });
 const group=await client.createGroup({name:'共同空间',memberIDs:['h_peer','a_peer']});
 assert.equal(group.groupID,'@TGS#new');
 assert.deepEqual(last(calls,'createGroup')[1],{type:'Public',name:'共同空间',memberList:[{userID:'h_peer'},{userID:'a_peer'}],inviteOption:'FreeAccess'});
 await client.createGroup({name:'work',type:'Private'});assert.equal('inviteOption' in last(calls,'createGroup')[1],false);
 await client.addGroupMembers('GROUP@TGS#new',['a_more']);assert.deepEqual(last(calls,'addGroupMember')[1],{groupID:'@TGS#new',userIDList:['a_more']});
 await client.removeGroupMembers('@TGS#new',['h_peer']);assert.deepEqual(last(calls,'deleteGroupMember')[1],{groupID:'@TGS#new',userIDList:['h_peer']});
 await client.setGroupMemberRole('@TGS#new','h_peer','Admin');assert.deepEqual(last(calls,'setGroupMemberRole')[1],{groupID:'@TGS#new',userID:'h_peer',role:'Admin'});
 await client.muteGroupMember('@TGS#new','h_peer',60);assert.deepEqual(last(calls,'setGroupMemberMuteTime')[1],{groupID:'@TGS#new',userID:'h_peer',muteTime:60});
 await client.transferGroupOwner('@TGS#new','h_peer');assert.deepEqual(last(calls,'changeGroupOwner')[1],{groupID:'@TGS#new',newOwnerID:'h_peer'});
 assert.deepEqual((await client.getGroupMembers('@TGS#new')).map(m=>m.userID),['a_self','h_peer']);
 await client.quitGroup('GROUP@TGS#new');assert.deepEqual(last(calls,'quitGroup').slice(1),['@TGS#new']);
 await client.dismissGroup('@TGS#new');assert.deepEqual(last(calls,'dismissGroup').slice(1),['@TGS#new']);
});

test('all eleven message types reach the native factory; @all aliases map to the SDK token; group IDs lose the GROUP prefix',async()=>{
 const {client,calls}=await connected();
 for(const type of ['text','location','face','custom'])await client.send({to:'a_peer',conversationType:'C2C',type,payload:{native:'untouched'}});
 await client.send({to:'GROUP@TGS#g',conversationType:'GROUP',type:'textAt',payload:{text:'hello',atUserList:['@all','all','a_peer']}});
 assert.deepEqual(last(calls,'createTextAtMessage')[1].payload.atUserList,['__kImSDK_MesssageAtALL__','__kImSDK_MesssageAtALL__','a_peer']);
 assert.equal(last(calls,'createTextAtMessage')[1].to,'@TGS#g');
 await client.send({to:'a_peer',conversationType:'C2C',type:'image',payload:{},attachment:{name:'a.png',mimeType:'image/png',base64:Buffer.from('png').toString('base64')}});
 assert(last(calls,'createImageMessage')[1].payload.file instanceof File);
 await assert.rejects(client.send({to:'a_peer',conversationType:'C2C',type:'audio',payload:{},attachment:{name:'a.bin',mimeType:'audio/x',base64:'AA=='}}),e=>e.code==='AUDIO_DURATION_REQUIRED');
 await client.send({to:'a_peer',conversationType:'C2C',type:'audio',payload:{second:3},attachment:{name:'a.bin',mimeType:'audio/x',base64:'AA=='}});
 assert.equal(last(calls,'createAudioMessage')[1].payload.file.duration,3000);
 const sent=(await client.send({to:'a_peer',conversationType:'C2C',type:'text',payload:{text:'x'}})).data.message;
 await client.send({to:'h_peer',conversationType:'C2C',type:'forward',payload:{},messageIDs:[sent.ID]});
 assert.equal(last(calls,'createForwardMessage')[1].payload.ID,sent.ID);
 await client.send({to:'h_peer',conversationType:'C2C',type:'merger',payload:{title:'记录'},messageIDs:[sent.ID]});
 assert.equal(last(calls,'createMergerMessage')[1].payload.messageList[0].ID,sent.ID);
 await assert.rejects(client.send({to:'h',conversationType:'C2C',type:'forward',payload:{},messageIDs:['unknown']}),e=>e.code==='MESSAGE_NOT_CACHED');
});

test('history reads cloud roaming: groups page by sequence, C2C by time, never the local-cache getMessageList',async()=>{
 const {client,calls}=await connected({
  getMessageListHopping:opts=>({data:opts.conversationID.startsWith('GROUP')
   ?(opts.sequence?{messageList:[{ID:'1',sequence:1}],isCompleted:true,nextMessageSeq:''}:{messageList:[{ID:'2',sequence:2},{ID:'3',sequence:3}],isCompleted:false,nextMessageSeq:'1'})
   :(opts.time?{messageList:[{ID:'old',time:90}],isCompleted:true}:{messageList:[{ID:'new',time:100}],isCompleted:false,nextMessageTime:90})}),
 });
 const first=await client.getMessages('GROUP@TGS#g');assert.deepEqual(first,{messageList:[{ID:'2',sequence:2},{ID:'3',sequence:3}],isCompleted:false,nextReqMessageID:'1'});
 const second=await client.getMessages('GROUP@TGS#g',{nextReqMessageID:first.nextReqMessageID});assert.equal(second.isCompleted,true);
 assert.deepEqual(last(calls,'getMessageListHopping')[1],{conversationID:'GROUP@TGS#g',direction:0,count:15,sequence:1});
 const c2c=await client.getMessages('C2Ca_peer');assert.deepEqual(c2c,{messageList:[{ID:'new',time:100}],isCompleted:false,nextReqMessageID:'90'});
 assert.equal((await client.getMessages('C2Ca_peer',{nextReqMessageID:'90'})).messageList[0].ID,'old');
 assert.deepEqual(last(calls,'getMessageListHopping')[1],{conversationID:'C2Ca_peer',direction:0,count:15,time:90});
 assert.equal(calls.some(c=>c[0]==='getMessageList'),false);
 assert.deepEqual(await client.getMessages('@TIM#SYSTEM'),{messageList:[],isCompleted:true});
});

test('group reply: ten preceding ordinary messages, never later ones, and the shared admission rules',async()=>{
 const api=new VelaAPI('http://unused');let mode='mention_context';
 api.groupReplyPolicy=async groupID=>({groupID,groupKind:'mixed',mode,effectiveMode:mode,contextMessages:mode==='mention_context'?10:0,canManage:false,memberCount:3,updatedAt:0});
 const row=(ID,extra={})=>({ID,from:'h_human',type:'TIMTextElem',conversationID:'GROUP@TGS#g',sequence:Number(ID)||0,payload:{text:'m'+ID},...extra});
 const trigger=row('100',{atUserList:['a_self']});
 const pages=[
  {messageList:[...Array.from({length:6},(_,i)=>row(String(i+6))),row('tip',{type:'TIMGroupTipElem'}),row('gone',{isRevoked:true}),trigger,row('101')],isCompleted:false,nextMessageSeq:'6'},
  {messageList:Array.from({length:7},(_,i)=>row(String(i))),isCompleted:true,nextMessageSeq:''},
 ];
 const {client}=await connected({getMessageListHopping:()=>({data:pages.shift()})},api);
 const input=await client.prepareGroupReply(trigger);
 assert.equal(input.shouldReply,true);assert.equal(input.contextStatus,'complete');
 assert.deepEqual(input.context.map(m=>m.ID),['2','3','4','5','6','7','8','9','10','11']);
 const missing=await connected({getMessageListHopping:{data:{messageList:[row('later')],isCompleted:true}}},api);
 const none=await missing.client.prepareGroupReply(trigger);assert.equal(none.contextStatus,'anchor_missing');assert.deepEqual(none.context,[]);
 mode='mention';
 assert.equal((await client.prepareGroupReply(row('quiet'))).reason,'not_mentioned');
 await assert.rejects(client.prepareGroupReply({...trigger,conversationID:'C2Ch'}),e=>e.code==='NOT_GROUP_MESSAGE');
 await assert.rejects(client.prepareGroupReply(trigger,{maxAgentHops:0}),e=>e.code==='INVALID_HOPS');
});

test('admission and lineage are identical for humans and agents',()=>{
 const policy={effectiveMode:'mention'};
 const m=(extra)=>({ID:'m',from:'h_x',type:'TIMTextElem',payload:{text:'hi'},...extra});
 assert.equal(groupReplyReason(m({from:'a_self'}),'a_self',policy),'self');
 assert.equal(groupReplyReason(m({isRevoked:true}),'a_self',policy),'revoked');
 assert.equal(groupReplyReason(m({type:'TIMGroupSystemNoticeElem'}),'a_self',policy),'system');
 assert.equal(groupReplyReason(m({atUserList:['__kImSDK_MesssageAtALL__']}),'a_self',policy),'accepted');
 assert.equal(groupReplyReason(m({payload:{text:'@a_self hi'}}),'a_self',policy),'accepted');
 assert.equal(groupReplyReason(m({}),'a_self',{effectiveMode:'all'}),'accepted');
 const looped=m({cloudCustomData:replyCustomData({chainId:'root',hops:5})});
 assert.deepEqual(readLineage(looped),{chainId:'root',hops:6});
 assert.equal(groupReplyReason(looped,'a_self',{effectiveMode:'all'}),'hop_limit');
 for(const sender of ['h_person','a_agent'])assert.equal(groupReplyReason(m({from:sender}),'a_self',{effectiveMode:'all'}),'accepted');
});

test('UserSig renewal re-logs in with fresh credentials and keeps subscriptions; concurrent disconnects tear down once',async()=>{
 const fake=fakeChat();let issued=0;
 const client=new VelaIMClient(new VelaAPI('http://unused'),fake.TencentCloudChat,hooks);
 await client.connect(credentials('a_self'),{credentials:async()=>credentials('a_self',Date.now()+7200000+ ++issued)});
 let friendEvents=0;client.on('FRIEND_LIST_UPDATED',()=>friendEvents++);
 await client.renew();
 assert.deepEqual(fake.calls.filter(c=>c[0]==='login'||c[0]==='logout').map(c=>c[0]),['login','logout','login']);
 assert.equal(issued,1);fake.native.emit('onFriendListUpdated',[]);assert.equal(friendEvents,1);
 await Promise.all([client.disconnect(),client.disconnect()]);
 assert.equal(fake.calls.filter(c=>c[0]==='destroy').length,1);assert.equal(client.native,undefined);
});
