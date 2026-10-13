// A stand-in for Tencent's SDK module: records every native call and answers with the documented shapes.
export function fakeChat(answers={}) {
 const handlers=new Map();const calls=[];
 const native={
  calls,user:null,
  setLogLevel(){},
  on(event,handler){if(!handlers.has(event))handlers.set(event,[]);handlers.get(event).push(handler)},
  off(event,handler){handlers.set(event,(handlers.get(event)??[]).filter(h=>h!==handler))},
  emit(event,data){for(const h of handlers.get(event)??[])h({data})},
  listeners(event){return (handlers.get(event)??[]).length},
  async login({userID}){calls.push(['login',userID]);this.user=userID;setTimeout(()=>native.emit('sdkStateReady'),0);return {data:{}}},
  getLoginUser(){return this.user},isReady(){return false},
  async logout(){calls.push(['logout']);this.user=null},async destroy(){calls.push(['destroy'])},
  async sendMessage(message,options){calls.push(['sendMessage',message,options]);return {data:{message}}},
 };
 for(const factory of ['createTextMessage','createTextAtMessage','createImageMessage','createAudioMessage','createVideoMessage','createFileMessage','createLocationMessage','createFaceMessage','createCustomMessage','createMergerMessage','createForwardMessage'])
  native[factory]=input=>{calls.push([factory,input]);return {ID:`${factory}-${calls.length}`,type:'TIMTextElem',...input}};
 const methods=['getConversationList','getMessageList','getMessageListHopping','setMessageRead','revokeMessage','getFriendList','getFriendApplicationList','addFriend','acceptFriendApplication','refuseFriendApplication','deleteFriend',
  'getGroupList','createGroup','getGroupProfile','updateGroupProfile','joinGroup','quitGroup','dismissGroup','getGroupMemberList','addGroupMember','deleteGroupMember','setGroupMemberRole','setGroupMemberMuteTime','changeGroupOwner',
  'getMyProfile','getUserProfile','updateMyProfile','pinConversation','deleteConversation','downloadMergerMessage'];
 for(const method of methods)native[method]=async(...args)=>{calls.push([method,...args]);const a=answers[method];return typeof a==='function'?a(...args):(a??{data:{}})};
 const TencentCloudChat={
  create:()=>native,
  EVENT:{SDK_READY:'sdkStateReady',MESSAGE_RECEIVED:'onMessageReceived',MESSAGE_MODIFIED:'onMessageModified',KICKED_OUT:'onKickedOut',FRIEND_LIST_UPDATED:'onFriendListUpdated'},
  TYPES:{MSG_AT_ALL:'__kImSDK_MesssageAtALL__',SNS_ADD_TYPE_BOTH:'Add_Type_Both',SNS_APPLICATION_AGREE_AND_ADD:'Response_Action_AgreeAndAdd',SNS_DELETE_TYPE_BOTH:'Delete_Type_Both',SNS_APPLICATION_SENT_TO_ME:'Pendency_Type_ComeIn',KICKED_OUT_USERSIG_EXPIRED:'userSigExpired',KICKED_OUT_REST_API:'REST_API_Kick'},
 };
 return {TencentCloudChat,native,calls};
}
export const hooks={toFile:async a=>new File([Buffer.from(a.base64??'',a.base64?'base64':'utf8')],a.name??'file',{type:a.mimeType??''}),audioSeconds:async()=>undefined};
export const credentials=(userID='a_self',expiresAt=Date.now()+7200000)=>({SDKAppID:1,userID,userSig:'sig',expiresAt});
