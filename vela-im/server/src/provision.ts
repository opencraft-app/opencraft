import {randomInt} from 'node:crypto';
import {userSig} from './signature.js';
import type {Config} from './config.js';
export async function imAdminCall(c:Config,command:string,body:any) {
  const q=new URLSearchParams({sdkappid:String(c.appId),identifier:c.admin,usersig:userSig(c.appId,c.imSecret,c.admin),random:String(randomInt(0,2147483647)),contenttype:'json'});
  const r=await fetch(`https://${c.restHost}/v4/${command}?${q}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await r.json() as any;
  if(!r.ok||data.ErrorCode)throw Object.assign(new Error(data.ErrorInfo??'IM 账号创建失败'),{code:data.ErrorCode??r.status});
  return data;
}
export async function provision(c:Config,id:string,name:string) {
 await imAdminCall(c,'im_open_login_svc/account_import',{UserID:id,Nick:name});
 // 人类与 Agent 默认均需要确认好友请求。
 await imAdminCall(c,'profile/portrait_set',{From_Account:id,ProfileItem:[{Tag:'Tag_Profile_IM_Nick',Value:name},{Tag:'Tag_Profile_IM_AllowType',Value:'AllowType_Type_NeedConfirm'}]});
}
