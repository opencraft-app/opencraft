import {nativePicture} from './picture-codec.mjs';
import { inboundFileId, inboundFileLine, storeInboundFile } from './inbound-files.mjs';
import { MAX_VOICE_BYTES } from './voice-text.mjs';

/** Resolve only provider media IDs from the authenticated parent delivery. Never fetch content URLs. */
export async function resolveNestedMedia(event, { secret, download, downloadEmotion, transcribe, signal, store = storeInboundFile }) {
  const { nestedMedia, ...rest } = event;
  if (!Array.isArray(nestedMedia)) return rest;
  const notes=[],transcripts=[];
  let total=0;
  const boundedDownload=async(mediaId,limit)=>{
    if(total>=40*1024*1024)throw Error('nested media too large');
    const bytes=await download(event.source,mediaId,signal,Math.min(limit,40*1024*1024-total));
    total+=bytes.length;
    if(total>40*1024*1024)throw Error('nested media too large');
    return bytes;
  };
  for(const [index,item] of nestedMedia.slice(0,16).entries()) {
    if(!item || !['image','file','voice','emotion'].includes(item.type) || (item.type==='emotion'?typeof item.picUrl!=='string':typeof item.mediaId!=='string'||!item.mediaId||item.mediaId.length>512) || typeof item.name!=='string'
      || !/^\d+(?:\.\d+){0,2}$/u.test(item.path))continue;
    const label=item.type==='emotion'?`[表情第 ${item.path} 项]`:`[转发/混排第 ${item.path} 项]`;
    try {
      if(item.type==='emotion') {
        if(total>=40*1024*1024)throw Error('nested media too large');
        const bytes=await downloadEmotion(event.source,item.picUrl,signal);total+=bytes.length;
        if(total>40*1024*1024)throw Error('nested media too large');
        const picture=await nativePicture(bytes,{force:true});if(!picture)throw Error('Unsupported emotion image');
        const id=inboundFileId(secret,event.source,event.id+':nested:'+index);
        await store(id,'表情.jpg',async()=>picture.bytes,{signal,source:event.source});
        notes.push(inboundFileLine(label+'（动态图取首帧）',id));
      }else if(item.type==='voice') {
        const bytes=await boundedDownload(item.mediaId,MAX_VOICE_BYTES),id=inboundFileId(secret,event.source,event.id+':nested:'+index);
        await store(id,item.name,async()=>bytes,{signal,source:event.source});
        const said=await transcribe(bytes,item.format,{signal});
        if(said)transcripts.push({path:item.path,text:said});
        notes.push(`${label} [语音] ${said||'未识别出文字'}`);
      } else {
        const id=inboundFileId(secret,event.source,event.id+':nested:'+index);
        await store(id,item.name,()=>boundedDownload(item.mediaId,20*1024*1024),{signal,source:event.source});
        notes.push(inboundFileLine(`${label} [${item.type==='image'?'图片':'文件'}] ${item.name}`,id));
      }
    } catch(error) {
      if(signal?.aborted){notes.push('其余附件读取超时，请将需要的附件单独重发。');break;}
      notes.push(`${label} 附件读取失败或超过限制，请单独重发。`);
    }
  }
  return {...rest,...(rest.forwardedRecord?{forwardedRecord:{...rest.forwardedRecord,...(transcripts.length?{transcripts}:{})}}:{}),text:[event.text,...notes].filter(Boolean).join('\n')};
}
