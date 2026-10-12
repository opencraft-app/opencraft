export type IdentityKind = 'human' | 'agent';
export interface Identity { id:string; ownerId:string; kind:IdentityKind; name:string; createdAt:number }
export interface Credentials { SDKAppID:number; userID:string; userSig:string; expiresAt:number }
export interface Session { token:string; ownerId:string; identities:Identity[]; expiresAt:number }
export type LightVelaRegion = 'cn' | 'intl';
export interface LightVelaUser { id:string; name:string; avatarUrl:string|null; region:LightVelaRegion }
/** `host` is where the Agent runs (`none` = identity only); `state` tracks runtime provisioning. */
export interface AgentRecord { host:string; profile:string|null; state:'registered'|'provisioning'|'ready'|'error'; error:string|null;
  /** What this Agent represents outside Vela IM, e.g. `lightvela-bot:<botId>`. */
  externalRef:string|null }
export interface DirectoryEntry { id:string; name:string; kind:IdentityKind; ownerName:string }
export type MessageKind = 'text'|'textAt'|'image'|'audio'|'video'|'file'|'location'|'face'|'custom'|'merger'|'forward';
/** Attachments: browsers may put a File in payload.file; HTTP callers send base64; local Agent workers may send a path. */
export type Attachment = {name:string; mimeType:string; base64:string} | {path:string; name?:string; mimeType?:string};
export interface MessageInput {
  to:string; conversationType:'C2C'|'GROUP'; type:MessageKind;
  payload:Record<string,unknown>; cloudCustomData?:string; needReadReceipt?:boolean;
  attachment?:Attachment; thumbnail?:Attachment;
  messageIDs?:string[]; options?:Record<string,unknown>;
}
export interface InboxEvent { seq:number; event:string; data:any; createdAt:number }
export const GroupReplyModes = {MENTION:'mention',MENTION_CONTEXT:'mention_context',ALL:'all'} as const;
export type GroupReplyMode = typeof GroupReplyModes[keyof typeof GroupReplyModes];
export interface GroupReplyPolicy {groupID:string;groupKind:'bot'|'mixed';mode:GroupReplyMode;effectiveMode:GroupReplyMode;contextMessages:number;canManage:boolean;memberCount:number;updatedAt:number}
export interface IMMessage {ID:string;from?:string;type?:string;conversationID?:string;conversationType?:string;payload?:Record<string,any>;[key:string]:any}
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
/** Who may issue runtime commands (e.g. Hermes /new, /model) to an identity: its owner's identities only, or anyone. */
export type CommandPolicy = 'owner'|'anyone';
export interface IdentitySettings {identityID:string;commandPolicy:CommandPolicy;updatedAt:number}
/** What an identity knows about who controls it. Humans and Agents are peers in IM, yet an Agent still answers to its owner. */
export interface IdentityControl {identity:{id:string;kind:IdentityKind;name:string};commandPolicy:CommandPolicy;updatedAt:number;owner:{identities:Array<Pick<Identity,'id'|'name'|'kind'>>}}

/** High-level IM operations shared by every Vela client (browser, Node worker, Python, Hermes). */
export const IM_METHODS = [
 'getConversations','getMessages','markRead','revokeMessage','downloadMergerMessage','pinConversation','deleteConversation',
 'getFriends','getFriendApplications','addFriend','acceptFriend','refuseFriend','deleteFriend',
 'getGroups','createGroup','getGroupProfile','updateGroupProfile','joinGroup','quitGroup','dismissGroup',
 'getGroupMembers','addGroupMembers','removeGroupMembers','setGroupMemberRole','muteGroupMember','transferGroupOwner',
 'getMyProfile','getUserProfiles','updateMyProfile',
 'groupReplyPolicy','setGroupReplyPolicy','control',
] as const;
export type IMMethod = typeof IM_METHODS[number];

export const VELA_CAPABILITIES = {
 identityService:['exchange','demoSession','me','participants','createIdentity','issueIdentityToken','revokeIdentityTokens','identitySettings','setIdentitySettings','control','credentials','groupReplyPolicy','setGroupReplyPolicy','logout'],
 imMethods:IM_METHODS,
 groupReplies:{modes:Object.values(GroupReplyModes),contextMessages:10,botGroupMode:'all',manageRoles:['Owner','Admin'],defaultMaxAgentHops:6},
} as const;
export interface VelaCapabilities {identity:{id:string;kind?:IdentityKind;name?:string};messageTypes:MessageKind[];methods:string[];documentedMethods:readonly string[];extensions:typeof VELA_CAPABILITIES}
export class VelaError extends Error {
  constructor(message:string, public readonly code:string|number, public readonly status:number=0) {super(message);this.name='VelaError'}
}

/** Vela identity service: outer-login exchange, identities, short-lived UserSig and group reply policy. It never relays IM traffic. */
export class VelaAPI {
  constructor(public readonly baseURL:string, public token:string='') {}
  async request<T=any>(path:string,body?:unknown,method?:string):Promise<T> {
    const r=await fetch(`${this.baseURL.replace(/\/$/,'')}/api${path}`,{
      method:method ?? (body===undefined?'GET':'POST'),
      headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(this.token?{Authorization:`Bearer ${this.token}`}:{})},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=await r.json();
    if(!r.ok) throw new VelaError(data.error ?? 'IM request failed',data.code ?? r.status,r.status);
    return data as T;
  }
  config() {return this.request<{SDKAppID:number;demoMode:boolean;sso:boolean}>('/config')}
  exchange(outerLoginJWT:string) {return this.request<Session>('/auth/exchange',{assertion:outerLoginJWT})}
  demoSession(name?:string) {return this.request<Session>('/auth/demo',{name})}
  /** Exchange a LightVela session token for this natural person's Vela session (same IM identity on every client). */
  async lightvelaSession(lightvelaToken:string,region:LightVelaRegion='cn') {
    const api=new VelaAPI(this.baseURL,lightvelaToken);
    return api.request<Session&{user:LightVelaUser}>('/auth/lightvela',{region});
  }
  /** Owner session: register a new Agent identity; the Agent host starts its runtime and IM worker. */
  createAgent(name:string,options:{externalRef?:string}={}) {return this.request<{identity:Identity;agent:AgentRecord}>('/agents',{name,...options})}
  agents() {return this.request<{host:string;agents:Array<Identity&AgentRecord>}>('/agents')}
  /** Find people and Agents by exact IM ID or name fragment. */
  directory(query:string) {return this.request<{results:DirectoryEntry[]}>(`/directory?q=${encodeURIComponent(query)}`)}
  participants() {return this.request<{participants:Array<Pick<Identity,'id'|'name'|'kind'>>}>('/demo/participants')}
  me() {return this.request<Omit<Session,'token'>>('/me')}
  createIdentity(name:string,kind:IdentityKind) {return this.request<Identity>('/identities',{name,kind})}
  issueIdentityToken(id:string) {return this.request<{token:string;identity:Identity;expiresAt:number}>(`/identities/${encodeURIComponent(id)}/tokens`,{})}
  revokeIdentityTokens(id:string) {return this.request(`/identities/${encodeURIComponent(id)}/tokens`,undefined,'DELETE')}
  /** Owner session: read / change who may command one of your identities. */
  identitySettings(id:string) {return this.request<IdentitySettings>(`/identities/${encodeURIComponent(id)}/settings`)}
  setIdentitySettings(id:string,settings:{commandPolicy:CommandPolicy}) {return this.request<IdentitySettings>(`/identities/${encodeURIComponent(id)}/settings`,settings,'PUT')}
  /** Identity session: this identity's command policy and its owner's identities. */
  control() {return this.request<IdentityControl>('/control')}
  credentials() {return this.request<Credentials>('/credentials')}
  groupReplyPolicy(groupID:string) {return this.request<GroupReplyPolicy>(`/groups/${encodeURIComponent(normalizeGroupID(groupID))}/reply-policy`)}
  setGroupReplyPolicy(groupID:string,mode:GroupReplyMode) {return this.request<GroupReplyPolicy>(`/groups/${encodeURIComponent(normalizeGroupID(groupID))}/reply-policy`,{mode},'PUT')}
  logout() {return this.request('/auth/logout',undefined,'DELETE')}
}

// 用户级公开 SDK 方法；不包含管理员 REST。
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
 "getMyFollowersList","getMyFollowingList","getMutualFollowersList","getUserFollowInfo","checkFollowType","getGroupList","getGroupProfile","createGroup",
 "dismissGroup","updateGroupProfile","joinGroup","quitGroup","pinGroupMessage","getPinnedGroupMessageList","searchGroupByID","getGroupOnlineMemberCount",
 "changeGroupOwner","getGroupApplicationList","handleGroupApplication","initGroupAttributes","setGroupAttributes","deleteGroupAttributes","getGroupAttributes",
 "setGroupCounters","increaseGroupCounter","decreaseGroupCounter","getGroupCounters","getGroupMemberList","getGroupMemberProfile","addGroupMember",
 "deleteGroupMember","setGroupMemberMuteTime","setGroupMemberRole","setGroupMemberNameCard","setGroupMemberCustomField","markGroupMemberList",
 "getJoinedCommunityList","createTopicInCommunity","deleteTopicFromCommunity","updateTopicProfile","getTopicList","invite","inviteSync","inviteInGroup",
 "inviteInGroupSync","cancel","accept","reject","getSignalingInfo","modifyInvitation"
] as const;
export const FACTORIES:Record<MessageKind,string>={
 text:'createTextMessage',textAt:'createTextAtMessage',image:'createImageMessage',audio:'createAudioMessage',video:'createVideoMessage',file:'createFileMessage',location:'createLocationMessage',face:'createFaceMessage',custom:'createCustomMessage',merger:'createMergerMessage',forward:'createForwardMessage'
};

export function assertMethod(method:string):void {
 if(!(SDK_METHODS as readonly string[]).includes(method)) throw new VelaError('不允许调用此 SDK 方法','METHOD_NOT_ALLOWED',400);
}
/** Tencent group IDs (@TGS#…) differ from conversation IDs (GROUP@TGS#…). */
export function normalizeGroupID(id:string):string {return id.startsWith('GROUP@TGS#')?id.slice(5):id}

const AT_ALL=['@all','all','__kImSDK_MesssageAtALL__'];
export const isSystemMessage=(m:IMMessage)=>['TIMGroupTipElem','TIMGroupSystemNoticeElem'].includes(m.type??'');
/** Agent conversation lineage travels in cloudCustomData.vela so automatic Agent ↔ Agent replies stay bounded. */
export function readLineage(message:IMMessage):Lineage {
 try {
  const data=JSON.parse(message.cloudCustomData||'{}').vela??{};
  const hops=Number(data.hops??0);
  if(!Number.isFinite(hops))throw Error('invalid hops');
  return {chainId:String(data.chainId||message.ID),hops:Math.max(0,Math.trunc(hops))};
 }catch{return {chainId:message.ID,hops:0}}
}
export function replyCustomData(parent:Lineage,senderKind:IdentityKind='agent'):string {
 return JSON.stringify({vela:{chainId:parent.chainId,hops:parent.hops+1,senderKind}});
}
export function mentions(message:IMMessage,userID:string):boolean {
 const at=message.atUserList??message.payload?.atUserList??[];
 return Array.isArray(at)&&(at.includes(userID)||at.some((id:string)=>AT_ALL.includes(id)))||String(message.payload?.text??'').includes('@'+userID);
}
/** Same decision for every Agent runtime: own/revoked/system messages, hop limit and the group's effective mode. */
export function groupReplyReason(message:IMMessage,userID:string,policy:Pick<GroupReplyPolicy,'effectiveMode'>,maxAgentHops=6):GroupReplyReason {
 if(message.from===userID)return 'self';
 if(message.isRevoked)return 'revoked';
 if(isSystemMessage(message))return 'system';
 if(readLineage(message).hops>=maxAgentHops)return 'hop_limit';
 if(policy.effectiveMode!=='all'&&!mentions(message,userID))return 'not_mentioned';
 return 'accepted';
}
