import {
 VelaAPI,VelaError,FACTORIES,SDK_METHODS,VELA_CAPABILITIES,assertMethod,normalizeGroupID,groupReplyReason,readLineage,isSystemMessage,
 type Attachment,type MessageInput,type MessageKind,type Credentials,type GroupReplyMode,type GroupReplyInput,type IMMessage,
 type CreateGroupOptions,type FriendApplication,type VelaCapabilities,
} from './index.ts';

/** Platform differences: how attachments become SDK File objects and how audio duration is measured. */
export interface PlatformHooks {
 toFile(attachment:Attachment):Promise<Blob>;
 audioSeconds(file:Blob):Promise<number|undefined>;
}
export interface ConnectOptions {
 /** Called again before the 2-hour UserSig expires; defaults to api.credentials(). */
 credentials?:()=>Promise<Credentials>;
}

export const safeJSON=(value:any):any=>{
 const seen=new WeakSet<object>();
 const plain=(v:any):any=>{
  if(typeof v==='function'||v===undefined)return undefined;
  if(v===null||typeof v!=='object')return v;
  if(seen.has(v))return undefined;
  seen.add(v);
  if(v instanceof Date){seen.delete(v);return v.toISOString()}
  if(Array.isArray(v)){const r=v.map(plain);seen.delete(v);return r}
  const keys=Object.keys(v);
  // V4 Message.toJSON() 和 prototype getter 都会隐藏 payload；序列化前先转普通对象。
  if(v.ID&&String(v.type??'').startsWith('TIM')&&!keys.includes('payload'))keys.push('payload');
  const r=Object.fromEntries(keys.map(k=>[k,plain(v[k])]).filter(([,x])=>x!==undefined));
  seen.delete(v);return r;
 };
 return plain(value);
};

const RENEW_BEFORE_MS=20*60000;

/** A normal Tencent IM user. Humans and Agents use this same class and the same Tencent permission rules. */
export class VelaIMClient {
 public native:any;
 public credentials:Credentials|undefined;
 private messages=new Map<string,any>();
 private subscriptions:Array<[string,(event:any)=>void]>=[];
 private renewTimer:ReturnType<typeof setTimeout>|undefined;
 private credentialSource:(()=>Promise<Credentials>)|undefined;
 private renewing:Promise<void>|undefined;
 private disconnecting:Promise<void>|undefined;
 constructor(public readonly api:VelaAPI,public readonly TencentCloudChat:any,private readonly hooks:PlatformHooks) {}
 get userID() {return this.credentials?.userID??''}
 get TYPES() {return this.TencentCloudChat.TYPES}

 async connect(credentials?:Credentials,options:ConnectOptions={}) {
  this.credentialSource=options.credentials??(()=>this.api.credentials());
  const c=credentials??await this.credentialSource();
  this.native=this.TencentCloudChat.create({SDKAppID:c.SDKAppID});
  this.native.setLogLevel(4);
  this.subscribe('MESSAGE_RECEIVED',({data}:any)=>{for(const m of data)this.cache(m)});
  this.subscribe('MESSAGE_MODIFIED',({data}:any)=>{for(const m of data)this.cache(m)});
  this.subscribe('KICKED_OUT',({data}:any)=>{if(data?.type===this.TYPES.KICKED_OUT_USERSIG_EXPIRED)void this.renew().catch(()=>{})});
  await this.login(c);
 }
 private async login(c:Credentials) {
  const ready=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{this.native.off(this.TencentCloudChat.EVENT.SDK_READY,done);reject(new VelaError('IM 连接超时','SDK_TIMEOUT'))},45000);
   const done=()=>{clearTimeout(timer);this.native.off(this.TencentCloudChat.EVENT.SDK_READY,done);resolve()};
   this.native.on(this.TencentCloudChat.EVENT.SDK_READY,done);
  });
  // 如果 login 失败，仍要消费 ready 的拒绝，防止未处理 promise。
  ready.catch(()=>{});
  await this.native.login({userID:c.userID,userSig:c.userSig});
  if(this.native.getLoginUser()!==c.userID)throw new VelaError('SDK 登录身份不匹配，请重新连接','IDENTITY_MISMATCH');
  this.credentials=c;
  this.scheduleRenewal();
  if(!this.native.isReady())await ready;
 }
 private scheduleRenewal() {
  clearTimeout(this.renewTimer);
  if(!this.credentials)return;
  const delay=Math.max(60000,this.credentials.expiresAt-Date.now()-RENEW_BEFORE_MS);
  this.renewTimer=setTimeout(()=>{void this.renew().catch(()=>{})},delay);
  (this.renewTimer as any).unref?.();
 }
 /** Re-login with a fresh UserSig before the old one expires. The SDK instance and event subscriptions are kept. */
 renew() {
  if(this.renewing)return this.renewing;
  this.renewing=(async()=>{
   const c=await this.credentialSource!();
   if(this.native.getLoginUser())await this.native.logout();
   await this.login(c);
  })().finally(()=>{this.renewing=undefined});
  return this.renewing;
 }
 private subscribe(event:string,handler:(event:any)=>void) {
  const name=this.TencentCloudChat.EVENT[event];
  this.native.on(name,handler);this.subscriptions.push([name,handler]);
  return ()=>{this.native.off(name,handler);this.subscriptions=this.subscriptions.filter(([,h])=>h!==handler)};
 }
 on(name:string,handler:(event:any)=>void) {
  if(!this.TencentCloudChat.EVENT[name])throw new VelaError(`SDK 不支持事件 ${name}`,'UNSUPPORTED_EVENT');
  return this.subscribe(name,handler);
 }
 private cache(message:any) {
  if(!message?.ID)return;
  this.messages.set(message.ID,message);
  if(this.messages.size>5000)this.messages.delete(this.messages.keys().next().value!);
 }
 private hydrate(value:any):any {
  if(Array.isArray(value))return value.map(v=>this.hydrate(v));
  if(value&&typeof value==='object'&&!(value instanceof Blob)) {
   if(value.$messageID) {
    const m=this.messages.get(value.$messageID);
    if(!m)throw new VelaError('请先获取这条消息所在会话的历史记录，再用消息 ID 操作','MESSAGE_NOT_CACHED');
    return m;
   }
   if(value.ID&&this.messages.has(value.ID)&&String(value.type??'').startsWith('TIM'))return this.messages.get(value.ID);
   return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.hydrate(v)]));
  }
  return value;
 }
 private ref(message:string|IMMessage) {return this.hydrate(typeof message==='string'?{$messageID:message}:message)}

 /** Raw access to any user-level SDK method, with the official positional arguments. */
 async call(method:string,args:any[]=[]) {
  assertMethod(method);
  if(this.renewing)await this.renewing;
  if(typeof this.native?.[method]!=='function')throw new VelaError(`当前 SDK 不支持 ${method}`,'UNSUPPORTED_METHOD');
  const result=await this.native[method](...this.hydrate(args));
  for(const m of result?.data?.messageList??[])this.cache(m);
  return result;
 }
 /** Every SDK message type: text, textAt, image, audio, video, file, location, face, custom, merger, forward. */
 async send(input:MessageInput) {
  const factory=FACTORIES[input.type];
  if(!factory||typeof this.native[factory]!=='function')throw new VelaError('SDK 不支持这个消息类型','UNSUPPORTED_MESSAGE');
  if(this.renewing)await this.renewing;
  const to=input.conversationType==='GROUP'?normalizeGroupID(input.to):input.to;
  const payload:any={...input.payload};
  if(input.type==='textAt'&&Array.isArray(payload.atUserList))payload.atUserList=payload.atUserList.map((id:string)=>id==='@all'||id==='all'?this.TYPES.MSG_AT_ALL:id);
  if(input.attachment)payload.file=await this.hooks.toFile(input.attachment);
  if(input.thumbnail)payload.snapshotFile=await this.hooks.toFile(input.thumbnail);
  if(input.type==='audio'&&payload.file instanceof Blob) {
   // V4 从 File.duration（毫秒）读取时长；对调用方保留 second（秒）便利参数。
   const nativeDuration=(payload.file as any).duration;
   const second=typeof payload.second==='number'&&Number.isFinite(payload.second)&&payload.second>0?payload.second:
    typeof nativeDuration==='number'&&Number.isFinite(nativeDuration)&&nativeDuration>0?nativeDuration/1000:await this.hooks.audioSeconds(payload.file);
   if(!second)throw new VelaError('无法读取语音时长，请在 payload 中填写 second','AUDIO_DURATION_REQUIRED');
   (payload.file as any).duration=second*1000;
  }
  if(input.type==='merger')payload.messageList=(input.messageIDs??[]).map(id=>this.ref(id));
  const common={to,conversationType:input.conversationType,...(input.cloudCustomData?{cloudCustomData:input.cloudCustomData}:{})};
  const message=input.type==='forward'
   ?this.native[factory]({...common,payload:this.ref(input.messageIDs?.[0]??'')})
   :this.native[factory]({...common,payload,needReadReceipt:input.needReadReceipt??false});
  this.cache(message);
  return this.native.sendMessage(message,input.options);
 }
 sendText(to:string,text:string,conversationType:'C2C'|'GROUP'='C2C',cloudCustomData?:string) {
  return this.send({to,conversationType,type:'text',payload:{text},...(cloudCustomData?{cloudCustomData}:{})});
 }

 // ── Conversations and messages ──
 async getConversations() {return (await this.call('getConversationList')).data.conversationList??[]}
 /**
  * One page of cloud history, oldest first. nextReqMessageID is the next anchor: a sequence for groups, a timestamp for C2C.
  * Pages may overlap on the anchor; callers merge by message ID.
  */
 async getMessages(conversationID:string,options:{nextReqMessageID?:string;count?:number}={}):Promise<{messageList:IMMessage[];nextReqMessageID?:string;isCompleted:boolean}> {
  if(!conversationID.startsWith('GROUP')&&!conversationID.startsWith('C2C'))return {messageList:[],isCompleted:true};
  // getMessageList answers from the local cache and can report a fresh login as complete with no messages;
  // roaming by anchor always reads Tencent's cloud history.
  const group=conversationID.startsWith('GROUP');
  const anchor=options.nextReqMessageID?{[group?'sequence':'time']:Number(options.nextReqMessageID)}:{};
  const data=(await this.call('getMessageListHopping',[{conversationID,direction:0,count:Math.min(options.count??15,15),...anchor}])).data;
  const list:IMMessage[]=data.messageList??[];
  const next=String((group?data.nextMessageSeq||(list.length?Number(list[0]?.sequence)-1:''):data.nextMessageTime)||'');
  const isCompleted=!!data.isCompleted||!list.length||!next||next==='0'||next===options.nextReqMessageID;
  return {messageList:list,isCompleted,...(isCompleted?{}:{nextReqMessageID:next})};
 }
 markRead(conversationID:string) {return this.call('setMessageRead',[{conversationID}])}
 revokeMessage(message:string|IMMessage) {return this.call('revokeMessage',[this.ref(message)])}
 async downloadMergerMessage(message:string|IMMessage):Promise<IMMessage[]> {return (await this.call('downloadMergerMessage',[this.ref(message)])).data?.messageList??[]}
 pinConversation(conversationID:string,isPinned=true) {return this.call('pinConversation',[{conversationID,isPinned}])}
 deleteConversation(conversationID:string) {return this.call('deleteConversation',[{conversationID}])}

 // ── Friends: ordinary confirmation rules apply to humans and Agents alike ──
 async getFriends() {return (await this.call('getFriendList')).data??[]}
 async getFriendApplications():Promise<FriendApplication[]> {
  const list=(await this.call('getFriendApplicationList')).data?.friendApplicationList??[];
  return list.map((a:any)=>({...a,direction:a.type===this.TYPES.SNS_APPLICATION_SENT_TO_ME?'incoming':'outgoing'}));
 }
 async addFriend(userID:string,options:{wording?:string;remark?:string;source?:string}={}) {
  return (await this.call('addFriend',[{to:userID,source:options.source??'AddSource_Type_Vela',wording:options.wording??'',remark:options.remark??'',type:this.TYPES.SNS_ADD_TYPE_BOTH}])).data;
 }
 async acceptFriend(userID:string,options:{remark?:string}={}) {
  return (await this.call('acceptFriendApplication',[{userID,type:this.TYPES.SNS_APPLICATION_AGREE_AND_ADD,...(options.remark?{remark:options.remark}:{})}])).data;
 }
 async refuseFriend(userID:string) {return (await this.call('refuseFriendApplication',[{userID}])).data}
 async deleteFriend(userID:string) {return (await this.call('deleteFriend',[{userIDList:[userID],type:this.TYPES.SNS_DELETE_TYPE_BOTH}])).data}

 // ── Groups: Tencent enforces owner/admin permissions for every identity ──
 async getGroups() {return (await this.call('getGroupList')).data?.groupList??[]}
 async createGroup({name,memberIDs=[],type='Public',inviteOption='FreeAccess',...native}:CreateGroupOptions) {
  const options:any={type,name,memberList:memberIDs.map(userID=>({userID})),...native};
  // 工作群（Private）不支持 inviteOption；其余类型默认允许群主直接拉人。
  if(type!=='Private'&&type!=='AVChatRoom')options.inviteOption=inviteOption;
  const group=(await this.call('createGroup',[options])).data.group;
  this.createdGroups.set(group.groupID,Date.now());
  return group;
 }
 private createdGroups=new Map<string,number>();
 async getGroupProfile(groupID:string) {return (await this.call('getGroupProfile',[{groupID:normalizeGroupID(groupID)}])).data.group}
 async updateGroupProfile(groupID:string,profile:Record<string,unknown>) {return (await this.call('updateGroupProfile',[{...profile,groupID:normalizeGroupID(groupID)}])).data.group}
 async joinGroup(groupID:string,applyMessage?:string) {return (await this.call('joinGroup',[{groupID:normalizeGroupID(groupID),...(applyMessage?{applyMessage}:{})}])).data}
 async quitGroup(groupID:string) {return (await this.call('quitGroup',[normalizeGroupID(groupID)])).data}
 async dismissGroup(groupID:string) {return (await this.call('dismissGroup',[normalizeGroupID(groupID)])).data}
 async getGroupMembers(groupID:string) {
  const members:any[]=[];let offset:any=0;
  for(let page=0;page<100;page++){
   const r=await this.call('getGroupMemberList',[{groupID:normalizeGroupID(groupID),count:100,offset}]);
   members.push(...(r.data.memberList??[]));offset=r.data.offset;
   if(!offset)break;
  }
  return members;
 }
 async addGroupMembers(groupID:string,userIDs:string[]) {
  const id=normalizeGroupID(groupID);
  for(let attempt=0;;attempt++) {
   try {return (await this.call('addGroupMember',[{groupID:id,userIDList:userIDs}])).data}
   catch(e:any) {
    // Tencent occasionally answers 10010 (no such group) for a few seconds after creating it.
    if(e?.code!==10010||attempt>=4||Date.now()-(this.createdGroups.get(id)??0)>15000)throw e;
    await new Promise(r=>setTimeout(r,800*(attempt+1)));
   }
  }
 }
 async removeGroupMembers(groupID:string,userIDs:string[],reason?:string) {return (await this.call('deleteGroupMember',[{groupID:normalizeGroupID(groupID),userIDList:userIDs,...(reason?{reason}:{})}])).data}
 async setGroupMemberRole(groupID:string,userID:string,role:'Admin'|'Member') {return (await this.call('setGroupMemberRole',[{groupID:normalizeGroupID(groupID),userID,role}])).data}
 async muteGroupMember(groupID:string,userID:string,seconds:number) {return (await this.call('setGroupMemberMuteTime',[{groupID:normalizeGroupID(groupID),userID,muteTime:seconds}])).data}
 async transferGroupOwner(groupID:string,userID:string) {return (await this.call('changeGroupOwner',[{groupID:normalizeGroupID(groupID),newOwnerID:userID}])).data}

 // ── Profiles ──
 async getMyProfile() {return (await this.call('getMyProfile')).data}
 async getUserProfiles(userIDs:string[]) {return (await this.call('getUserProfile',[{userIDList:userIDs}])).data??[]}
 async updateMyProfile(profile:Record<string,unknown>) {return (await this.call('updateMyProfile',[profile])).data}

 // ── Vela group reply policy (an extension stored by the identity service) ──
 /** Who controls this identity: its command policy and its owner's identities. */
 control() {return this.api.control()}
 groupReplyPolicy(groupID:string) {return this.api.groupReplyPolicy(groupID)}
 setGroupReplyPolicy(groupID:string,mode:GroupReplyMode) {return this.api.setGroupReplyPolicy(groupID,mode)}
 /** Decide whether this identity should answer a received group message, with up to 10 preceding messages when the policy asks for them. */
 async prepareGroupReply(message:IMMessage,options:{maxAgentHops?:number}={}):Promise<GroupReplyInput> {
  const maxAgentHops=options.maxAgentHops??6;
  if(!Number.isInteger(maxAgentHops)||maxAgentHops<1||maxAgentHops>32)throw new VelaError('maxAgentHops 必须在 1 到 32 之间','INVALID_HOPS',400);
  if(!message?.conversationID?.startsWith('GROUP'))throw new VelaError('需要群消息','NOT_GROUP_MESSAGE',400);
  const policy=await this.groupReplyPolicy(message.conversationID.slice(5));
  const reason=groupReplyReason(message,this.userID,policy,maxAgentHops);
  const result:GroupReplyInput={message,policy,shouldReply:reason==='accepted',reason,context:[],contextStatus:'not_requested',lineage:readLineage(message)};
  if(result.shouldReply&&policy.contextMessages>0)Object.assign(result,await this.precedingMessages(message,policy.contextMessages));
  return result;
 }
 private async precedingMessages(message:IMMessage,limit:number):Promise<Pick<GroupReplyInput,'context'|'contextStatus'>> {
  let history:IMMessage[]=[],cursor:string|undefined;
  for(let page=0;page<20;page++){
   const data=await this.getMessages(message.conversationID!,{count:15,...(cursor?{nextReqMessageID:cursor}:{})});
   history=[...(data.messageList??[]),...history];
   const anchor=history.findIndex(m=>m.ID===message.ID);
   const previous=anchor<0?[]:history.slice(0,anchor).filter(m=>(!m.conversationID||m.conversationID===message.conversationID)&&!m.isRevoked&&!isSystemMessage(m));
   // Native pages can overlap; keep one copy of each ordinary preceding message.
   const unique=[...new Map(previous.map(m=>[m.ID,m])).values()];
   if(anchor>=0&&(unique.length>=limit||data.isCompleted))return {context:safeJSON(unique.slice(-limit)),contextStatus:'complete'};
   const next=data.nextReqMessageID;
   if(!next||next===cursor||data.isCompleted||page===19)return {context:safeJSON(unique.slice(-limit)),contextStatus:anchor<0?'anchor_missing':'partial'};
   cursor=next;
  }
  return {context:[],contextStatus:'anchor_missing'};
 }

 capabilities():VelaCapabilities {
  return {identity:{id:this.userID},messageTypes:Object.keys(FACTORIES) as MessageKind[],methods:SDK_METHODS.filter(m=>typeof this.native?.[m]==='function'),documentedMethods:SDK_METHODS,extensions:VELA_CAPABILITIES};
 }
 async disconnect() {
  if(this.disconnecting)return this.disconnecting;
  if(!this.native)return;
  clearTimeout(this.renewTimer);
  const native=this.native;
  for(const [event,handler] of this.subscriptions)native.off(event,handler);
  this.subscriptions=[];this.messages.clear();
  this.disconnecting=Promise.resolve().then(async()=>{
   // Explicit logout clears the user caches before the V4 runtime is destroyed.
   try{if(native.getLoginUser())await native.logout()}finally{await native.destroy()}
  });
  try{await this.disconnecting}finally{if(this.native===native)this.native=undefined;this.disconnecting=undefined}
 }
}
