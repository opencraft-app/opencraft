import ChatPackage from '@tencentcloud/lite-chat/professional';
import {VelaError,type Attachment} from './index.ts';
import {VelaIMClient} from './client.ts';
export {safeJSON,type CredentialSource} from './client.ts';

// 腾讯的声明使用 export=；NodeNext 对 UMD 包的 default 类型需显式归一化。
export const TencentCloudChat:any=ChatPackage;
async function audioSeconds(file:Blob):Promise<number|undefined> {
 const url=URL.createObjectURL(file);const audio=new Audio();audio.preload='metadata';
 try {
  return await new Promise<number|undefined>(resolve=>{
   const timer=setTimeout(()=>{cleanup();resolve(undefined)},15000);
   const cleanup=()=>{clearTimeout(timer);audio.onloadedmetadata=null;audio.onerror=null};
   audio.onloadedmetadata=()=>{cleanup();resolve(Number.isFinite(audio.duration)&&audio.duration>0?Math.ceil(audio.duration):undefined)};
   audio.onerror=()=>{cleanup();resolve(undefined)};
   audio.src=url;
  });
 }finally {audio.removeAttribute('src');URL.revokeObjectURL(url)}
}
async function toFile(a:Attachment):Promise<Blob> {
 if(!('base64' in a))throw new VelaError('浏览器请直接在 payload.file 中传入 File','PATH_UNSUPPORTED');
 const bytes=Uint8Array.from(atob(a.base64),c=>c.charCodeAt(0));
 return new File([bytes],a.name,{type:a.mimeType});
}

/**
 * Browser / WKWebView client: connects this identity directly to Tencent with a short-lived UserSig.
 * Pass `() => humanAPI.imSession()` to `connect`.
 */
export class VelaBrowserClient extends VelaIMClient {
 constructor() {super(TencentCloudChat,{toFile,audioSeconds})}
}
