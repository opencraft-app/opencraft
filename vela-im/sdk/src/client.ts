import {
 VelaError,FACTORIES,SDK_METHODS,VELA_CAPABILITIES,PLATFORM_NOTICE_BUSINESS_IDS,assertMethod,normalizeGroupID,groupReplyReason,readLineage,isSystemMessage,DEFAULT_MAX_AGENT_HOPS,
 type Attachment,type MessageInput,type MessageKind,type Credentials,type GroupReplyInput,type GroupReplyPolicy,type IMMessage,
 type FriendApplication,type VelaCapabilities,
} from './index.ts';

/** Platform differences: how attachments become SDK File objects and how audio duration is measured. */
export interface PlatformHooks {
 toFile(attachment:Attachment):Promise<Blob>;
 audioSeconds(file:Blob):Promise<number|undefined>;
}
/** Returns a fresh short-lived UserSig; called again before each one expires and when Tencent reports it expired. */
export type CredentialSource = ()=>Promise<Credentials>;

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

function customBusinessID(payload:any):string {
 try {const data=JSON.parse(String(payload?.data??'{}'));return typeof data?.businessID==='string'?data.businessID:''}catch{return ''}
}

/** With one-hour UserSigs this renews at the 45th minute. */
const RENEW_BEFORE_MS=15*60000;
/** After the platform signs this identity out (e.g. an admin restricted it), ask for a new session at these intervals. */
const RELOGIN_DELAYS_MS=[15000,30000,60000];

/** A normal Tencent IM user. Humans and Agents use this same class and the same Tencent permission rules. */
export class VelaIMClient {
 public native:any;
 public credentials:Credentials|undefined;
 private messages=new Map<string,any>();
 private subscriptions:Array<[string,(event:any)=>void]>=[];
 private renewTimer:ReturnType<typeof setTimeout>|undefined;
 private credentialSource:CredentialSource|undefined;
 private renewing:Promise<void>|undefined;
 private reloginTimer:ReturnType<typeof setTimeout>|undefined;
 private disconnecting:Promise<void>|undefined;
 constructor(public readonly TencentCloudChat:any,private readonly hooks:PlatformHooks) {}
 get userID() {return this.credentials?.userID??''}
 get TYPES() {return this.TencentCloudChat.TYPES}

 async connect(source:CredentialSource) {
  this.credentialSource=source;
  const c=await source();
  this.native=this.TencentCloudChat.create({SDKAppID:c.SDKAppID});
  this.native.setLogLevel(4);
  this.subscribe('MESSAGE_RECEIVED',({data}:any)=>{for(const m of data)this.cache(m)});
  this.subscribe('MESSAGE_MODIFIED',({data}:any)=>{for(const m of data)this.cache(m)});
  this.subscribe('KICKED_OUT',({data}:any)=>{
   if(data?.type===this.TYPES.KICKED_OUT_USERSIG_EXPIRED)void this.renew().catch(e=>this.retryRenewal(e));
   else if(data?.type===this.TYPES.KICKED_OUT_REST_API)this.relogin();
  });
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
  this.renewTimer=setTimeout(()=>{void this.renew().catch(e=>this.retryRenewal(e))},delay);
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
 /**
  * A renewal the platform could not answer (a restart, a network blip) is retried like a sign-out; only a revoked
  * credential (401) ends the session for good.
  */
 private retryRenewal(error:unknown) {
  if(!(error instanceof VelaError&&error.status===401))this.relogin();
 }
 /**
  * A server-side kick is how the platform withdraws a session. Keep asking for a new one: while the identity stays
  * restricted the platform refuses, and once it is released the client is back without a restart. A revoked
  * credential (401) is final.
  */
 private relogin(attempt=0) {
  clearTimeout(this.reloginTimer);
  this.reloginTimer=setTimeout(()=>{
   void this.renew().catch((e:unknown)=>{if(!(e instanceof VelaError&&e.status===401))this.relogin(attempt+1)});
  },RELOGIN_DELAYS_MS[Math.min(attempt,RELOGIN_DELAYS_MS.length-1)]);
  (this.reloginTimer as any).unref?.();
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

 /** Raw access to the allowed user-level SDK methods (SDK_METHODS), with the official positional arguments. */
 async call(method:string,args:any[]=[]) {
  assertMethod(method);
  return this.raw(method,args);
 }
 /** The high-level methods below call the SDK directly; only `call` is limited to SDK_METHODS. */
 private async raw(method:string,args:any[]=[]) {
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
  if(input.type==='custom'&&(PLATFORM_NOTICE_BUSINESS_IDS as readonly string[]).includes(customBusinessID(payload)))
   throw new VelaError('不能发送平台系统通知','RESERVED_NOTICE',400);
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
 async getConversations() {return (await this.raw('getConversationList')).data.conversationList??[]}
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
  const data=(await this.raw('getMessageListHopping',[{conversationID,direction:0,count:Math.min(options.count??15,15),...anchor}])).data;
  const list:IMMessage[]=data.messageList??[];
  const next=String((group?data.nextMessageSeq||(list.length?Number(list[0]?.sequence)-1:''):data.nextMessageTime)||'');
  const isCompleted=!!data.isCompleted||!list.length||!next||next==='0'||next===options.nextReqMessageID;
  return {messageList:list,isCompleted,...(isCompleted?{}:{nextReqMessageID:next})};
 }
 markRead(conversationID:string) {return this.raw('setMessageRead',[{conversationID}])}
 revokeMessage(message:string|IMMessage) {return this.raw('revokeMessage',[this.ref(message)])}
 async downloadMergerMessage(message:string|IMMessage):Promise<IMMessage[]> {return (await this.raw('downloadMergerMessage',[this.ref(message)])).data?.messageList??[]}
 pinConversation(conversationID:string,isPinned=true) {return this.raw('pinConversation',[{conversationID,isPinned}])}
 deleteConversation(conversationID:string) {return this.raw('deleteConversation',[{conversationID}])}

 // ── Friends: ordinary confirmation rules apply to humans and Agents alike ──
 async getFriends() {return (await this.raw('getFriendList')).data??[]}
 async getFriendApplications():Promise<FriendApplication[]> {
  const list=(await this.raw('getFriendApplicationList')).data?.friendApplicationList??[];
  return list.map((a:any)=>({...a,direction:a.type===this.TYPES.SNS_APPLICATION_SENT_TO_ME?'incoming':'outgoing'}));
 }
 async addFriend(userID:string,options:{wording?:string;remark?:string;source?:string}={}) {
  return (await this.raw('addFriend',[{to:userID,source:options.source??'AddSource_Type_Vela',wording:options.wording??'',remark:options.remark??'',type:this.TYPES.SNS_ADD_TYPE_BOTH}])).data;
 }
 async acceptFriend(userID:string,options:{remark?:string}={}) {
  return (await this.raw('acceptFriendApplication',[{userID,type:this.TYPES.SNS_APPLICATION_AGREE_AND_ADD,...(options.remark?{remark:options.remark}:{})}])).data;
 }
 async refuseFriend(userID:string) {return (await this.raw('refuseFriendApplication',[{userID}])).data}
 async deleteFriend(userID:string) {return (await this.raw('deleteFriend',[{userIDList:[userID],type:this.TYPES.SNS_DELETE_TYPE_BOTH}])).data}

 // ── Groups: reads only. Creating, membership changes, quitting and dismissing go through the platform API ──
 async getGroups() {return (await this.raw('getGroupList')).data?.groupList??[]}
 async getGroupProfile(groupID:string) {return (await this.raw('getGroupProfile',[{groupID:normalizeGroupID(groupID)}])).data.group}
 async getGroupMembers(groupID:string) {
  const members:any[]=[];let offset:any=0;
  for(let page=0;page<100;page++){
   const r=await this.raw('getGroupMemberList',[{groupID:normalizeGroupID(groupID),count:100,offset}]);
   members.push(...(r.data.memberList??[]));offset=r.data.offset;
   if(!offset)break;
  }
  return members;
 }

 // ── Profiles ──
 async getMyProfile() {return (await this.raw('getMyProfile')).data}
 async getUserProfiles(userIDs:string[]) {return (await this.raw('getUserProfile',[{userIDList:userIDs}])).data??[]}
 async updateMyProfile(profile:Record<string,unknown>) {return (await this.raw('updateMyProfile',[profile])).data}

 /**
  * Decide whether this identity should answer a received group message under the group's platform rules, with up to
  * 10 preceding messages when the rules ask for them.
  */
 async prepareGroupReply(message:IMMessage,policy:GroupReplyPolicy,options:{maxAgentHops?:number}={}):Promise<GroupReplyInput> {
  const maxAgentHops=options.maxAgentHops??DEFAULT_MAX_AGENT_HOPS;
  if(!Number.isInteger(maxAgentHops)||maxAgentHops<1||maxAgentHops>32)throw new VelaError('maxAgentHops 必须在 1 到 32 之间','INVALID_HOPS',400);
  if(!message?.conversationID?.startsWith('GROUP'))throw new VelaError('需要群消息','NOT_GROUP_MESSAGE',400);
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
  clearTimeout(this.reloginTimer);
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
