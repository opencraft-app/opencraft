import {CHANNEL_ATTACHMENT_LIMIT,FORWARDED_RECORD_MIME,type ChannelMessage} from '@opencraft/appserver-protocol';
import type {ChannelsClient} from './channel-client';
export const canForwardMessage=(message:ChannelMessage)=>message.attachment?.type!==FORWARDED_RECORD_MIME&&!!(message.text||message.attachment||message.image?.state==='ready');
/** Fetch through the current authenticated source read, never a path or copied internal URL. */
export async function messageFile(client:ChannelsClient,source:string,message:ChannelMessage,signal:AbortSignal){
 if(!message.attachment&&message.image?.state!=='ready')throw Error('attachment_unavailable');
 const blob=await client.attachment(source,message.sequence,signal);signal.throwIfAborted();
 if(blob.size>CHANNEL_ATTACHMENT_LIMIT)throw Error('attachment_too_large');
 return new File([blob],message.attachment?.name??('image.'+(blob.type==='image/jpeg'?'jpg':'png')),{type:blob.type||message.attachment?.type||'application/octet-stream'});
}
/** The caller retains one key per destination across failed or uncertain retries. No implicit mentions/wakes. */
export async function forwardChannelMessage(client:ChannelsClient,source:string,message:ChannelMessage,target:string,key:string,signal:AbortSignal){
 if(!canForwardMessage(message))throw Error('forward_unavailable');signal.throwIfAborted();
 if(message.attachment||message.image){const file=await messageFile(client,source,message,signal);signal.throwIfAborted();return client.sendChannelAttachment(target,key,file,signal);}
 return client.sendText(target,key,message.text,signal);
}
/** Clipboard promises are created during the initiating user gesture (Safari included). */
export function copyChannelImage(load:()=>Promise<Blob>,signal:AbortSignal){
 const view=typeof window==='undefined'?null:window;
 const ClipboardItemConstructor=(view as (Window & typeof globalThis)|null)?.ClipboardItem;
 if(!ClipboardItemConstructor||!navigator.clipboard?.write)throw Error('clipboard_unavailable');
 const png=load().then(async blob=>{
  signal.throwIfAborted();if(blob.type==='image/png')return blob;
  if(!/^image\/(jpeg|webp|gif)$/u.test(blob.type))throw Error('clipboard_format_unavailable');
  const bitmap=await createImageBitmap(blob);try{
   if(bitmap.width*bitmap.height>16000000)throw Error('clipboard_image_too_large');
   const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);
   const result=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('clipboard_encode_failed')),'image/png'));signal.throwIfAborted();return result;
  }finally{bitmap.close();}
 });
 void png.catch(()=>{});return navigator.clipboard.write([new ClipboardItemConstructor({'image/png':png})]);
}
