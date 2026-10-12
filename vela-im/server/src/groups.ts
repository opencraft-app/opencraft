import type {Config} from './config.js';
import {Store} from './store.js';
import {imAdminCall} from './provision.js';
import type {GroupReplyMode,GroupReplyPolicy} from '@vela/im-client';

const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});
export class GroupPolicies {
 constructor(private c:Config,private store:Store,private call=imAdminCall){}
 private request(command:string,body:any) {return this.call(this.c,command,body).catch(error=>{if(error.code===10010)throw fail(404,'群聊已解散');throw error})}
 async read(groupID:string,identityID:string):Promise<GroupReplyPolicy> {
  if(!groupID||groupID.length>256||groupID.startsWith('GROUP@TGS#'))throw fail(400,'请使用群 ID，不要添加 GROUP 会话前缀');
  // Server-side membership reads avoid logging in a second Web SDK as the browser user.
  const info=await this.request('group_open_http_svc/get_group_info',{GroupIdList:[groupID],ResponseFilter:{GroupBaseInfoFilter:['Type'],MemberInfoFilter:[]}});
  const group=info.GroupInfo?.[0];
  if(!group||group.ErrorCode)throw fail(404,'群聊不存在');
  if(group.Type==='AVChatRoom')throw fail(400,'直播群暂不支持按完整成员名单设置 Bot 回复策略');
  const members=new Map<string,string>();let offset=0,next='';let complete=false;
  for(let page=0;page<100;page++){
   const r=await this.request('group_open_http_svc/get_group_member_info',{GroupId:groupID,Limit:100,MemberInfoFilter:['Role'],...(group.Type==='Community'?{Next:next}:{Offset:offset})});
   for(const m of r.MemberList??[])members.set(m.Member_Account,String(m.Role).trim());
   if(group.Type==='Community'){next=r.Next??'';complete=!next}
   else{const count=(r.MemberList??[]).length;offset+=count;complete=Number.isInteger(r.MemberNum)?offset>=r.MemberNum:count<100;if(!count&&!complete)throw fail(503,'群成员同步未完成，请稍后重试')}
   if(complete)break;
  }
  if(!complete)throw fail(503,'群成员同步未完成，请稍后重试');
  const role=members.get(identityID);if(!role)throw fail(403,'只有当前群成员可以查看或设置回复策略');
  const bot=members.size>0&&[...members.keys()].every(id=>this.store.identity(id)?.kind==='agent');
  const policy=this.store.groupReplyPolicy(groupID);const effectiveMode=bot?'all':policy.mode;
  return {groupID,groupKind:bot?'bot':'mixed',...policy,effectiveMode,contextMessages:effectiveMode==='mention_context'?10:0,canManage:role==='Owner'||role==='Admin',memberCount:members.size};
 }
 async update(groupID:string,identityID:string,mode:GroupReplyMode) {
  if(!['mention','mention_context','all'].includes(mode))throw fail(400,'未知的 Agent 回复模式');
  const state=await this.read(groupID,identityID);if(!state.canManage)throw fail(403,'只有群主和管理员可以修改 Agent 回复模式');
  this.store.setGroupReplyPolicy(groupID,mode);
  return {...state,...this.store.groupReplyPolicy(groupID),effectiveMode:state.groupKind==='bot'?'all':mode,contextMessages:state.groupKind!=='bot'&&mode==='mention_context'?10:0};
 }
}
