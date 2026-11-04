import {open,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {unknownContext,projectContext,type ThreadContextObservation} from '@opencraft/appserver-protocol/collaboration';
import {canonicalRolloutPath,type NativeRolloutSource} from './codex-rollout-reader.js';
const object=(v:unknown):Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
/** A bounded, read-only tail of the existing Native source, never a billing aggregate or index. */
export async function readLatestContext(path:string,source:NativeRolloutSource,signal:AbortSignal):Promise<ThreadContextObservation> {
  signal.throwIfAborted();await source.validate(signal);
  const canonical=await canonicalRolloutPath(path,source.nativeHome),file=await open(canonical,'r');
  try {
    const before=await file.stat({bigint:true}),end=Number(before.size),start=Math.max(0,end-8*1024*1024);
    if(!Number.isSafeInteger(end))return unknownContext('read-budget');
    const bytes=Buffer.alloc(end-start);signal.throwIfAborted();
    const read=await file.read(bytes,0,bytes.length,start);signal.throwIfAborted();
    if(read.bytesRead!==bytes.length)return unknownContext('source-changed');
    if(bytes.length&&bytes[bytes.length-1]!==10)return unknownContext('invalid-record');
    const first=start===0?0:bytes.indexOf(10)+1;
    if(start>0&&first===0)return unknownContext('read-budget');
    let result=unknownContext(start>0?'read-budget':'no-recorded-usage');
    let right=bytes.length-1,lines=0;
    while(right>=first) {
      signal.throwIfAborted();if(++lines>32768)return unknownContext('read-budget');
      const left=bytes.lastIndexOf(10,right-1)+1;
      if(left<first)break;
      const line=bytes.subarray(left,right);right=left-1;
      if(!line.length)continue;
      if(line.length>256*1024)return unknownContext('read-budget');
      let row;try{row=object(JSON.parse(line.toString('utf8')));}catch{return unknownContext('invalid-record');}
      const payload=object(row.payload);
      // A later compaction invalidates an earlier context measurement.
      if(row.type==='compacted'||row.type==='event_msg'&&payload.type==='context_compacted')break;
      if(row.type!=='event_msg'||payload.type!=='token_count')continue;
      const info=object(payload.info),last=object(info.last_token_usage);
      if(info.model_context_window==null){result=unknownContext('missing-window');break;}
      result=projectContext({status:'observed',source:'native-rollout/token_count',scope:'latest-recorded-context-window',
        observedAt:Date.now(),recordedAt:row.timestamp,usedTokens:last.total_tokens,contextWindow:info.model_context_window,
        breakdown:{inputTokens:last.input_tokens,cachedInputTokens:last.cached_input_tokens,outputTokens:last.output_tokens,reasoningOutputTokens:last.reasoning_output_tokens}});
      break;
    }
    const hash=createHash('sha256').update(bytes).digest('hex'),verify=Buffer.alloc(bytes.length);
    signal.throwIfAborted();const reread=await file.read(verify,0,verify.length,start);signal.throwIfAborted();
    await source.validate(signal);
    const after=await stat(canonical,{bigint:true});signal.throwIfAborted();
    if(reread.bytesRead!==bytes.length||createHash('sha256').update(verify).digest('hex')!==hash
      ||before.dev!==after.dev||before.ino!==after.ino||before.birthtimeNs!==after.birthtimeNs||before.size!==after.size
      ||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)return unknownContext('source-changed');
    return result;
  } finally {await file.close();}
}
