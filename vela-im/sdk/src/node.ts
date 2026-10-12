import './xhr.ts';
import {readFile,stat} from 'node:fs/promises';
import {basename,extname,resolve,sep} from 'node:path';
import {realpathSync} from 'node:fs';
import ChatPackage from './vendor/lite-chat-node.mjs';
import {VelaAPI,VelaError,type Attachment} from './index.ts';
import {VelaIMClient} from './client.ts';
import {audioSeconds} from './audio.ts';
export {safeJSON} from './client.ts';

export const TencentCloudChat:any=ChatPackage;
const MAX_ATTACHMENT=100*1024*1024;
const MIME:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.heic':'image/heic',
 '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.opus':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.mp4':'video/mp4','.mov':'video/quicktime',
 '.txt':'text/plain','.pdf':'application/pdf','.json':'application/json','.zip':'application/zip'};
export interface NodeClientOptions {
 /** When set, path attachments must resolve inside this directory (symlinks included). */
 fileRoot?:string;
}

let active:VelaNodeClient|undefined;

/**
 * Node.js client for Agents and services: logs this identity into Tencent directly with the official Node SDK build.
 * Tencent's SDK is a per-process singleton, so one process serves one identity (use one worker per Agent).
 */
export class VelaNodeClient extends VelaIMClient {
 override async connect(...args:Parameters<VelaIMClient['connect']>) {
  if(active&&active!==this&&active.native)throw new VelaError('一个 Node 进程只能登录一个 IM 身份；请为每个身份启动独立的 worker 进程','ONE_IDENTITY_PER_PROCESS');
  active=this;
  try{await super.connect(...args)}catch(e){if(active===this)active=undefined;throw e}
 }
 override async disconnect() {
  try{await super.disconnect()}finally{if(active===this)active=undefined}
 }
 constructor(api:VelaAPI,options:NodeClientOptions={}) {
  super(api,TencentCloudChat,{
   async toFile(a:Attachment) {
    let bytes:Uint8Array,name:string,type:string;
    if('base64' in a){bytes=Buffer.from(a.base64,'base64');name=a.name;type=a.mimeType}
    else {
     const path=realpathSync(resolve(a.path));
     if(options.fileRoot){const root=realpathSync(options.fileRoot);if(path!==root&&!path.startsWith(root+sep))throw new VelaError('附件不在允许的媒体目录中','FILE_OUTSIDE_ROOT',400)}
     const info=await stat(path);
     if(!info.isFile())throw new VelaError('附件必须是文件','INVALID_ATTACHMENT',400);
     if(info.size>MAX_ATTACHMENT)throw new VelaError('附件超过 100 MB','ATTACHMENT_TOO_LARGE',400);
     bytes=await readFile(path);name=a.name??basename(path);type=a.mimeType??MIME[extname(path).toLowerCase()]??'application/octet-stream';
    }
    if(bytes.byteLength>MAX_ATTACHMENT)throw new VelaError('附件超过 100 MB','ATTACHMENT_TOO_LARGE',400);
    return new File([bytes as Uint8Array<ArrayBuffer>],name,{type});
   },
   async audioSeconds(file:Blob) {return audioSeconds(new Uint8Array(await file.arrayBuffer()))},
  });
 }
}
