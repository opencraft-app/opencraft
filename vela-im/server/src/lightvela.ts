import type {LightVelaRegion} from './config.js';

export interface LightVelaUser {id:string;name:string;avatarUrl?:string}

/**
 * Verifies a LightVela session token with LightVela itself. The same LightVela user always maps to the same
 * natural person here, whichever client (web, desktop, mobile) obtained the token.
 */
export async function verifyLightVelaToken(apiBase:string,token:string,fetchImpl:typeof fetch=fetch):Promise<LightVelaUser|null> {
 const response=await fetchImpl(`${apiBase.replace(/\/$/,'')}/auth/profile`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
 if(response.status===401||response.status===403)return null;
 if(!response.ok)throw Object.assign(new Error('LightVela 账号服务暂时不可用'),{statusCode:502});
 const body=await response.json() as {user?:{id?:unknown;name?:unknown;avatarUrl?:unknown}};
 const user=body.user;
 if(!user||typeof user.id!=='string'||!user.id)throw Object.assign(new Error('LightVela 账号信息无效'),{statusCode:502});
 const name=typeof user.name==='string'&&user.name.trim()?user.name.trim().slice(0,40):`LightVela ${user.id.slice(-6)}`;
 return {id:user.id,name,...(typeof user.avatarUrl==='string'&&user.avatarUrl?{avatarUrl:user.avatarUrl}:{})};
}

export const lightvelaSubject=(region:LightVelaRegion,userId:string)=>`lightvela:${region}:${userId}`;
