export type IdentityKind = 'human' | 'bot';
export interface Credentials { SDKAppID:number; userID:string; userSig:string; expiresAt:number }
export type MessageKind = 'text'|'textAt'|'image'|'audio'|'video'|'file'|'location'|'face'|'custom'|'merger'|'forward';
/** Attachments: browsers may put a File in payload.file; HTTP callers send base64; local Agent workers may send a path. */
export type Attachment = {name:string; mimeType:string; base64:string} | {path:string; name?:string; mimeType?:string};
export interface MessageInput {
  to:string; conversationType:'C2C'|'GROUP'; type:MessageKind;
  payload:Record<string,unknown>; cloudCustomData?:string; needReadReceipt?:boolean;
  attachment?:Attachment; thumbnail?:Attachment;
  messageIDs?:string[]; options?:Record<string,unknown>;
  /** Worker only: derive the Agent-to-Agent hop chain from this received message when cloudCustomData is absent. */
  replyToMessageID?:string;
}
export interface InboxEvent { seq:number; event:string; data:any; createdAt:number }
export const GroupReplyModes = {MENTION:'mention',MENTION_CONTEXT:'mention_context',ALL:'all'} as const;
export type GroupReplyMode = typeof GroupReplyModes[keyof typeof GroupReplyModes];
/** Who may issue runtime commands (e.g. Hermes /new, /model) to a Bot: its owner's identities only, or anyone. */
export type CommandPolicy = 'owner'|'anyone';

/** A LightVela Bot's own IM identity, owned by the LightVela account that provisioned it. */
export interface BotAgent {
  id:string; instanceId:string; botId:string; displayName:string; userId:string;
  state:'provisioning'|'ready'|'error'|'deleted'; lastErrorCode?:string|null; commandPolicy:CommandPolicy; revision:number;
}
export interface ImGroupMember { userId:string; kind:IdentityKind; role:'owner'|'admin'|'member' }
/** A platform group: membership and reply rules live in the LightVela backend, messages in Tencent IM. */
export interface ImGroupInvite {groupId:string;token:string;expiresAt:string}
export interface ImGroup {
  id:string; tencentGroupId:string; name:string; replyMode:GroupReplyMode; effectiveReplyMode:GroupReplyMode;
  contextMessages:number; state:'provisioning'|'active'|'dismissed'; revision:number;
  members:ImGroupMember[]; viewerRole:'owner'|'admin'|'member';
}
export interface CreateGroupInput { name:string; memberUserIds:string[]; replyMode?:GroupReplyMode; groupId?:string }
export interface UpdateGroupInput { name?:string; replyMode?:GroupReplyMode }
/** What a Bot knows about itself and who controls it. Humans and Bots are peers in IM, yet a Bot still answers to its owner. */
export interface BotIdentity { id:string; userId:string; displayName:string; commandPolicy:CommandPolicy; ownerUserIds:string[] }
export interface BotSession {
  accessToken:string; expiresAt:string; bot:BotIdentity;
  im:{sdkAppId:number; userId:string; userSig:string; expiresAt:string};
}

/** The reply rules an Agent applies to one group; non-platform groups fall back to mention-only. */
export interface GroupReplyPolicy {
  groupID:string; platformGroupId:string|null; mode:GroupReplyMode; effectiveMode:GroupReplyMode;
  contextMessages:number; members:ImGroupMember[]; canManage:boolean;
}
export type IMMessage = {ID:string;from?:string;type?:string;conversationID?:string;conversationType?:string;payload?:Record<string,any>;[key:string]:any};
export type GroupReplyReason = 'accepted'|'self'|'revoked'|'system'|'hop_limit'|'not_mentioned';
export interface Lineage {chainId:string;hops:number}
export interface GroupReplyInput {
 message:IMMessage;policy:GroupReplyPolicy;shouldReply:boolean;reason:GroupReplyReason;
 context:IMMessage[];contextStatus:'not_requested'|'complete'|'partial'|'anchor_missing';
 lineage:Lineage;
}
export type GroupType = 'Public'|'Private'|'ChatRoom'|'AVChatRoom'|'Community';
export interface CreateGroupOptions {name:string;memberIDs?:string[];type?:GroupType;inviteOption?:'FreeAccess'|'NeedPermission'|'DisableInvite';[native:string]:unknown}
export interface FriendApplication {userID:string;direction:'incoming'|'outgoing';nick?:string;word?:string;[key:string]:any}

/** High-level IM operations served by the Agent worker over its local socket. */
export const IM_METHODS = [
 'getConversations','getMessages','markRead','revokeMessage','downloadMergerMessage','pinConversation','deleteConversation',
 'getFriends','getFriendApplications','addFriend','acceptFriend','refuseFriend','deleteFriend',
 'getGroups','getGroupProfile','getGroupMembers',
 'getMyProfile','getUserProfiles','updateMyProfile',
] as const;
export type IMMethod = typeof IM_METHODS[number];

/** Platform group and Bot operations the worker forwards to the LightVela backend with the Bot's own session. */
export const PLATFORM_METHODS = ['me','createGroup','group','updateGroup','dismissGroup','addGroupMember','removeGroupMember'] as const;
export type PlatformMethod = typeof PLATFORM_METHODS[number];

export const VELA_CAPABILITIES = {
 humanAPI:['imSession','bots','provisionBot','updateBot','deleteBot','rotateBotCredential','createGroup','group','updateGroup','dismissGroup','addGroupMember','removeGroupMember','createGroupInvite','acceptGroupInvite'],
 botAPI:['session','me',...PLATFORM_METHODS.filter(m=>m!=='me')],
 imMethods:IM_METHODS,
 groupReplies:{modes:Object.values(GroupReplyModes),contextMessages:10,botGroupMode:'all',manageRoles:['owner','admin'],defaultMaxAgentHops:6},
} as const;
export interface VelaCapabilities {identity:{id:string;kind?:IdentityKind;name?:string};messageTypes:MessageKind[];methods:string[];documentedMethods:readonly string[];extensions:typeof VELA_CAPABILITIES}
export class VelaError extends Error {
  constructor(message:string, public readonly code:string|number, public readonly status:number=0) {super(message);this.name='VelaError'}
}

type HeaderSource = ()=>Record<string,string>|Promise<Record<string,string>>;

/** JSON over HTTP with the platform error envelope `{error:{code,message}}`. */
class HttpAPI {
  constructor(readonly baseURL:string, private readonly fetchImpl:typeof fetch=globalThis.fetch.bind(globalThis), private readonly credentials?:RequestCredentials) {}
  async request<T>(method:string, path:string, body:unknown, headers:Record<string,string>):Promise<T> {
    const response=await this.fetchImpl(`${this.baseURL.replace(/\/$/,'')}${path}`,{
      method, credentials:this.credentials,
      headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
      body:body===undefined?undefined:JSON.stringify(body),
    });
    const text=await response.text();
    let data:any=undefined;
    if(text){try{data=JSON.parse(text)}catch{data=undefined}}
    if(!response.ok) {
      const error=data?.error;
      const message=typeof error==='object'?error?.message:typeof error==='string'?error:undefined;
      throw new VelaError(message??`请求失败（HTTP ${response.status}）`,(typeof error==='object'&&error?.code)||data?.code||response.status,response.status);
    }
    return data as T;
  }
}

const path=(value:string)=>encodeURIComponent(value);

/**
 * The signed-in LightVela user against the LightVela backend. The gateway verifies the existing LightVela login;
 * this client never handles a second session.
 */
export class VelaHumanAPI {
  private readonly http:HttpAPI;
  constructor(baseURL:string, private readonly options:{headers?:HeaderSource;credentials?:RequestCredentials;fetch?:typeof fetch}={}) {
    this.http=new HttpAPI(baseURL,options.fetch,options.credentials);
  }
  private async request<T>(method:string,url:string,body?:unknown) {
    return this.http.request<T>(method,url,body,(await this.options.headers?.())??{});
  }
  /**
   * A fresh one-hour UserSig for this user's own IM identity. An account's first sighting queues its IM import, and
   * the backend answers `im_session_unavailable` until it finishes, so that case is retried for a while.
   */
  async imSession(retryDelayMs=1500,attempts=20):Promise<Credentials> {
    for(let attempt=1;;attempt++){
      try {
        const session=await this.request<{sdkAppId:number;userId:string;userSig:string;expiresAt:string}>('POST','/me/im/session');
        return {SDKAppID:session.sdkAppId,userID:session.userId,userSig:session.userSig,expiresAt:Date.parse(session.expiresAt)};
      } catch(error) {
        if(!(error instanceof VelaError)||error.code!=='im_session_unavailable'||attempt>=attempts)throw error;
        await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
      }
    }
  }
  async bots():Promise<BotAgent[]> {return (await this.request<{items:BotAgent[]}>('GET','/me/bots')).items}
  /** Idempotently give a LightVela Bot its own IM identity and deliver its credential to the instance. */
  provisionBot(input:{instanceId:string;botId:string;displayName:string}) {return this.request<BotAgent>('POST','/me/bots',input)}
  updateBot(botAgentId:string,input:{commandPolicy:CommandPolicy}) {return this.request<BotAgent>('PATCH',`/me/bots/${path(botAgentId)}`,input)}
  deleteBot(botAgentId:string) {return this.request<void>('DELETE',`/me/bots/${path(botAgentId)}`)}
  rotateBotCredential(botAgentId:string) {return this.request<BotAgent>('POST',`/me/bots/${path(botAgentId)}/credential`)}
  createGroup(input:CreateGroupInput) {return this.request<ImGroup>('POST','/me/groups',{...input,groupId:input.groupId??uuidv7()})}
  group(groupId:string) {return this.request<ImGroup>('GET',`/me/groups/${path(groupId)}`)}
  updateGroup(groupId:string,input:UpdateGroupInput) {return this.request<ImGroup>('PATCH',`/me/groups/${path(groupId)}`,input)}
  dismissGroup(groupId:string) {return this.request<void>('DELETE',`/me/groups/${path(groupId)}`)}
  addGroupMember(groupId:string,userId:string) {return this.request<ImGroup>('PUT',`/me/groups/${path(groupId)}/members/${path(userId)}`)}
  removeGroupMember(groupId:string,userId:string) {return this.request<ImGroup>('DELETE',`/me/groups/${path(groupId)}/members/${path(userId)}`)}
  /** A 7-day invite to this group; group owners and admins only. */
  createGroupInvite(groupId:string) {return this.request<ImGroupInvite>('POST',`/me/groups/${path(groupId)}/invite-link`)}
  /** Join a group with an invite someone shared; joining again is a no-op. */
  acceptGroupInvite(token:string) {return this.request<ImGroup>('POST','/me/group-invites/accept',{token})}
}

/**
 * A Bot runtime against the LightVela backend. The long-lived Bot credential is only ever sent to create a session;
 * every other call uses the one-hour Bot access token, renewed from the credential when it expires or is rejected.
 */
export class VelaBotAPI {
  private readonly http:HttpAPI;
  private current:BotSession|undefined;
  private refreshing:Promise<BotSession>|undefined;
  constructor(baseURL:string, private readonly credential:()=>string|Promise<string>, fetchImpl?:typeof fetch) {
    this.http=new HttpAPI(baseURL,fetchImpl);
  }
  get identity():BotIdentity|undefined {return this.current?.bot}
  /** Exchange the Bot credential for a fresh access token and UserSig. */
  session():Promise<BotSession> {
    this.refreshing??=(async()=>{
      const credential=(await this.credential()).trim();
      if(!credential)throw new VelaError('Bot 凭据为空','BOT_CREDENTIAL_MISSING',401);
      this.current=await this.http.request<BotSession>('POST','/runtime/bot/session',undefined,{Authorization:`BotCredential ${credential}`});
      return this.current;
    })().finally(()=>{this.refreshing=undefined});
    return this.refreshing;
  }
  async credentials():Promise<Credentials> {
    const {im}=await this.session();
    return {SDKAppID:im.sdkAppId,userID:im.userId,userSig:im.userSig,expiresAt:Date.parse(im.expiresAt)};
  }
  private async request<T>(method:string,url:string,body?:unknown):Promise<T> {
    const fresh=this.current&&Date.parse(this.current.expiresAt)-Date.now()>60000?this.current:await this.session();
    try {return await this.http.request<T>(method,url,body,{Authorization:`Bearer ${fresh.accessToken}`})}
    catch(error) {
      if(!(error instanceof VelaError)||error.status!==401)throw error;
      const renewed=await this.session();
      return this.http.request<T>(method,url,body,{Authorization:`Bearer ${renewed.accessToken}`});
    }
  }
  me() {return this.request<BotIdentity>('GET','/runtime/bot/me')}
  createGroup(input:CreateGroupInput) {return this.request<ImGroup>('POST','/runtime/bot/groups',{...input,groupId:input.groupId??uuidv7()})}
  group(groupId:string) {return this.request<ImGroup>('GET',`/runtime/bot/groups/${path(groupId)}`)}
  updateGroup(groupId:string,input:UpdateGroupInput) {return this.request<ImGroup>('PATCH',`/runtime/bot/groups/${path(groupId)}`,input)}
  dismissGroup(groupId:string) {return this.request<void>('DELETE',`/runtime/bot/groups/${path(groupId)}`)}
  addGroupMember(groupId:string,userId:string) {return this.request<ImGroup>('PUT',`/runtime/bot/groups/${path(groupId)}/members/${path(userId)}`)}
  removeGroupMember(groupId:string,userId:string) {return this.request<ImGroup>('DELETE',`/runtime/bot/groups/${path(groupId)}/members/${path(userId)}`)}
}

/** RFC 9562 UUIDv7: platform IDs are time-ordered, and a client-generated group ID makes creation retry-safe. */
export function uuidv7():string {
  const bytes=new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const now=Date.now();
  for(let index=0;index<6;index++)bytes[index]=Math.floor(now/2**(8*(5-index)))&0xff;
  bytes[6]=(bytes[6]!&0x0f)|0x70;
  bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

const PLATFORM_GROUP_PREFIX='vg_';
/** Tencent GroupId of a platform group, derived from its UUID. */
export function tencentGroupId(platformGroupId:string):string {return PLATFORM_GROUP_PREFIX+platformGroupId.replaceAll('-','').toLowerCase()}
/** Platform group UUID for a Tencent GroupId or GROUP conversation ID; null for groups the platform did not create. */
export function platformGroupId(groupOrConversationID:string):string|null {
  const raw=normalizeGroupID(groupOrConversationID.replace(/^GROUP/,''));
  if(!raw.startsWith(PLATFORM_GROUP_PREFIX))return null;
  const hex=raw.slice(PLATFORM_GROUP_PREFIX.length);
  if(!/^[0-9a-f]{32}$/i.test(hex))return null;
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`.toLowerCase();
}
export function policyFromGroup(group:ImGroup):GroupReplyPolicy {
  return {
    groupID:group.tencentGroupId,platformGroupId:group.id,mode:group.replyMode,effectiveMode:group.effectiveReplyMode,
    contextMessages:group.contextMessages,members:group.members,canManage:group.viewerRole!=='member',
  };
}
/** Groups the platform does not manage keep the conservative default: answer only when mentioned. */
export function defaultGroupPolicy(groupID:string):GroupReplyPolicy {
  return {groupID:normalizeGroupID(groupID),platformGroupId:null,mode:'mention',effectiveMode:'mention',contextMessages:0,members:[],canManage:false};
}

// 用户级公开 SDK 方法；不包含管理员 REST。建群、拉人、踢人、退群、解散和转让群主只走平台接口，
// 这样成员关系与回复规则始终以平台数据库为准。
export const SDK_METHODS = [
 "getLoginUser","getServerTime","isReady","downloadMergerMessage","revokeMessage","resendMessage","deleteMessage","translateText","convertVoiceToText",
 "setMessageExtensions","getMessageExtensions","deleteMessageExtensions","modifyMessage","searchCloudMessages","searchCloudGroups","searchCloudUsers","searchCloudGroupMembers",
 "addMessageReaction","removeMessageReaction","getMessageReactions","getAllUserListOfMessageReaction","getMessageList","getMessageListHopping","setMessageRead",
 "sendMessageReadReceipt","getMessageReadReceiptList","getGroupMessageReadMemberList","findMessage","getConversationList","getConversationProfile","deleteConversation",
 "setConversationDraft","clearHistoryMessage","pinConversation","setAllMessageRead","setMessageRemindType","setAllReceiveMessageOpt","getAllReceiveMessageOpt",
 "getTotalUnreadMessageCount","setConversationCustomData","markConversation","getConversationGroupList","createConversationGroup","deleteConversationGroup",
 "renameConversationGroup","addConversationsToGroup","deleteConversationsFromGroup","getMyProfile","getUserProfile","updateMyProfile","getBlacklist","addToBlacklist",
 "removeFromBlacklist","setSelfStatus","getUserStatus","subscribeUserStatus","unsubscribeUserStatus","getFriendList","addFriend","deleteFriend","checkFriend",
 "getFriendProfile","updateFriend","getFriendApplicationList","acceptFriendApplication","refuseFriendApplication","deleteFriendApplication","setFriendApplicationRead",
 "getFriendGroupList","createFriendGroup","deleteFriendGroup","addToFriendGroup","removeFromFriendGroup","renameFriendGroup","followUser","unfollowUser",
 "getMyFollowersList","getMyFollowingList","getMutualFollowersList","getUserFollowInfo","checkFollowType","getGroupList","getGroupProfile",
 "updateGroupProfile","pinGroupMessage","getPinnedGroupMessageList","searchGroupByID","getGroupOnlineMemberCount",
 "getGroupApplicationList","handleGroupApplication","initGroupAttributes","setGroupAttributes","deleteGroupAttributes","getGroupAttributes",
 "setGroupCounters","increaseGroupCounter","decreaseGroupCounter","getGroupCounters","getGroupMemberList","getGroupMemberProfile",
 "setGroupMemberMuteTime","setGroupMemberNameCard","setGroupMemberCustomField","markGroupMemberList",
 "getJoinedCommunityList","createTopicInCommunity","deleteTopicFromCommunity","updateTopicProfile","getTopicList","invite","inviteSync","inviteInGroup",
 "inviteInGroupSync","cancel","accept","reject","getSignalingInfo","modifyInvitation"
] as const;
export const FACTORIES:Record<MessageKind,string>={
 text:'createTextMessage',textAt:'createTextAtMessage',image:'createImageMessage',audio:'createAudioMessage',video:'createVideoMessage',file:'createFileMessage',location:'createLocationMessage',face:'createFaceMessage',custom:'createCustomMessage',merger:'createMergerMessage',forward:'createForwardMessage'
};

export function assertMethod(method:string):void {
 if(!(SDK_METHODS as readonly string[]).includes(method)) throw new VelaError('不允许调用此 SDK 方法','METHOD_NOT_ALLOWED',400);
}
/** Tencent group IDs (@TGS#…, vg_…) differ from conversation IDs (GROUP@TGS#…, GROUPvg_…). */
export function normalizeGroupID(id:string):string {return id.startsWith('GROUP@TGS#')||id.startsWith('GROUPvg_')?id.slice(5):id}

/** businessID of the custom message the backend sends when a group's reply rules change. */
export const GROUP_POLICY_BUSINESS_ID='vela_group_policy';

const AT_ALL=['@all','all','__kImSDK_MesssageAtALL__'];
export const isSystemMessage=(m:IMMessage)=>['TIMGroupTipElem','TIMGroupSystemNoticeElem'].includes(m.type??'')||
 [GROUP_POLICY_BUSINESS_ID,GROUP_CREATE_BUSINESS_ID,AGENT_STATUS_BUSINESS_ID].includes(customBusinessID(m));
/** Online-only "an Agent is working on it" signal: never stored, never unread, never answered. */
export const AGENT_STATUS_BUSINESS_ID='vela_agent_status';
export const isAgentStatus=(m:IMMessage)=>customBusinessID(m)===AGENT_STATUS_BUSINESS_ID;
/** The backend's reply-rule notice: a system event, never something an Agent answers. */
export const isPolicyNotice=(m:IMMessage)=>customBusinessID(m)===GROUP_POLICY_BUSINESS_ID;
/** "Created the group" notice, sent by the backend in Tencent's own client format. */
export const GROUP_CREATE_BUSINESS_ID='group_create';
function customBusinessID(m:IMMessage):string {
 if(m.type!=='TIMCustomElem')return '';
 try {const id=JSON.parse(String(m.payload?.data??'{}'))?.businessID;return typeof id==='string'?id:''}catch{return ''}
}
/** Agent conversation lineage travels in cloudCustomData.vela so automatic Agent ↔ Agent replies stay bounded. */
export function readLineage(message:IMMessage):Lineage {
 try {
  const data=JSON.parse(message.cloudCustomData||'{}').vela??{};
  const hops=Number(data.hops??0);
  if(!Number.isFinite(hops))throw Error('invalid hops');
  return {chainId:String(data.chainId||message.ID),hops:Math.max(0,Math.trunc(hops))};
 }catch{return {chainId:message.ID,hops:0}}
}
export function replyCustomData(parent:Lineage,senderKind:IdentityKind='bot'):string {
 return JSON.stringify({vela:{chainId:parent.chainId,hops:parent.hops+1,senderKind}});
}
export function mentions(message:IMMessage,userID:string):boolean {
 const at=message.atUserList??message.payload?.atUserList??[];
 return Array.isArray(at)&&(at.includes(userID)||at.some((id:string)=>AT_ALL.includes(id)))||String(message.payload?.text??'').includes('@'+userID);
}
/** The single reply decision every Agent runtime uses: own/revoked/system messages, hop limit and the group's effective mode. */
export function groupReplyReason(message:IMMessage,userID:string,policy:Pick<GroupReplyPolicy,'effectiveMode'>,maxAgentHops=6):GroupReplyReason {
 if(message.from===userID)return 'self';
 if(message.isRevoked)return 'revoked';
 if(isSystemMessage(message))return 'system';
 if(readLineage(message).hops>=maxAgentHops)return 'hop_limit';
 if(policy.effectiveMode!=='all'&&!mentions(message,userID))return 'not_mentioned';
 return 'accepted';
}
