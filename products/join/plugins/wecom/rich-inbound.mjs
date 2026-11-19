import {senderIdentity} from './external-identity.mjs';
import {emotionURL} from './emotion-media.mjs';
// Non-text WeCom group messages rendered as readable timeline text, so forwarded chat
// records, files, mixed messages and voice reach the assistant instead of being dropped.
const clip = (text, limit) => (text.length > limit ? text.slice(0, limit) + '…' : text);
const items = (node, name) => (node?.children ?? []).filter(n => n.name === name);
const value = (node, name) => items(node, name)[0]?.text.trim() ?? '';
const time = seconds => {
  const n = Number(seconds);
  return Number.isSafeInteger(n) && n > 0 ? new Date(n * 1000 + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ') : '';
};

/** Provider ids that appear as senders inside forwarded records. */
export function forwardedSenders(msg,localCorpId) {
  const ids = new Set();
  const walk = (forward, depth) => {
    for (const item of items(items(forward, 'MsgItemList')[0], 'MsgItem')) {
      const sender = value(item, 'Sender');
      if (sender&&!senderIdentity(sender,value(item,'SenderCorpId'),localCorpId).external) ids.add(sender);
      if (value(item, 'MsgType') === 'forward' && depth < 3) walk(items(item, 'ForwardMessage')[0], depth + 1);
    }
  };
  if (value(msg, 'MsgType') === 'forward') walk(items(msg, 'ForwardMessage')[0], 0);
  return [...ids].slice(0, 200);
}

/** Readable text for a message; '' when there is nothing to record. names maps provider ids to labels. */
export function describeMessage(msg, names = new Map(), depth = 0,localCorpId) {
  const type = value(msg, 'MsgType');
  if (type === 'text') return value(msg, 'Content');
  if (type === 'image') return '[图片]';
  if (type === 'voice') return '[语音]';
  if (type === 'video') return '[视频]';
  if (type === 'emotion') return '[表情]';
  if (type === 'file') return `[文件] ${clip(value(msg, 'FileName') || '未命名文件', 200)}`;
  if (type === 'link') return `[链接] ${clip(value(msg, 'Title') || value(msg, 'Url') || '', 200)}`;
  if (type === 'mixed') {
    return items(items(msg, 'MixedMessage')[0], 'MsgItem').slice(0, 64)
      .map(item => describeMessage(item, names, depth + 1,localCorpId)).filter(Boolean).join(' ');
  }
  if (type === 'forward') {
    const forward = items(msg, 'ForwardMessage')[0];
    const title = clip(value(forward, 'Title') || '聊天记录', 120);
    if (depth >= 3) return `[聊天记录] ${title}`;
    const list = items(items(forward, 'MsgItemList')[0], 'MsgItem');
    const lines = list.slice(0, 200).map(item => {
      const sender = value(item, 'Sender');
      const identity=senderIdentity(sender,value(item,'SenderCorpId'),localCorpId);
      const label=identity.external?identity.displayName:(names.get(sender)??sender??'?');
      const body = describeMessage(item, names, depth + 1,localCorpId).replace(/\n/gu, '\n  ');
      return `${time(value(item, 'Time'))} ${label}: ${clip(body, 2000)}`.trim();
    });
    if (list.length > 200) lines.push(`…（共 ${list.length} 条，仅显示前 200 条）`);
    return [`[聊天记录] ${title}`, ...lines].join('\n');
  }
  return type ? `[${clip(type, 32)}消息]` : '';
}

/** Types the Relay records as text (besides plain text and downloaded images). */
export const DESCRIBED_TYPES = new Set(['voice', 'video', 'emotion', 'file', 'link', 'mixed', 'forward']);

/** Bounded references from nested content only; the enclosing sender remains the authority. */
export function nestedMedia(msg) {
  const found=[]; let visited=0;
  function walk(node,path,depth) {
    if(depth>3 || ++visited>200 || found.length>=16)return;
    const type=value(node,'MsgType'),mediaId=value(node,'MediaId');
    if(type==='emotion'){try{found.push({type:'emotion',picUrl:emotionURL(value(node,'PicUrl')),path:path||'1',name:'表情.jpg'});}catch{ /* Keep readable placeholder for unsupported URL. */ }}
    if(path && ['image','file','voice'].includes(type) && mediaId && mediaId.length<=512) {
      found.push({type,mediaId,path,name:clip(value(node,'FileName') || (type==='image'?'图片.png':type==='voice'?'语音.amr':'文件'),160),format:clip(value(node,'Format'),16)});
    }
    const children=type==='mixed'?items(items(node,'MixedMessage')[0],'MsgItem')
      :type==='forward'?items(items(items(node,'ForwardMessage')[0],'MsgItemList')[0],'MsgItem'):[];
    children.slice(0,200).forEach((item,i)=>walk(item,path?path+'.'+(i+1):String(i+1),depth+1));
  }
  walk(msg,'',0);return found;
}

/** Structural protocol decoding only. No summarization, document interpretation or sender authorization. */
export function forwardedRecord(msg,names=new Map(),localCorpId){
 if(value(msg,'MsgType')!=='forward')return undefined;
 let count=0,budget=0,partial=false;
 const take=(s,max=2*1024*1024)=>{const remaining=Math.max(0,1200000-budget-32);let hi=Math.min(s.length,max),lo=0;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(Buffer.byteLength(JSON.stringify(s.slice(0,mid)))<=remaining)lo=mid;else hi=mid-1;}let out=s.slice(0,lo);if(/[\uD800-\uDBFF]$/u.test(out))out=out.slice(0,-1);if(out!==s)partial=true;budget+=Buffer.byteLength(JSON.stringify(out))+32;return out;};
 const parts=(node,path,depth)=>{
  budget+=64;if(budget>1200000){partial=true;return[{kind:'notice',text:'[记录内容超出接收限额]'}];}
  const type=value(node,'MsgType');
  if(type==='mixed'){if(depth>=5){partial=true;return[{kind:'notice',text:'[混排消息超出展示层级]'}];}const children=items(items(node,'MixedMessage')[0],'MsgItem'),out=[];if(children.length>128)partial=true;for(let i=0;i<children.length;i++){if(out.length>=128){partial=true;break;}const decoded=parts(children[i],path+'.'+(i+1),depth+1),remaining=128-out.length;if(decoded.length>remaining)partial=true;out.push(...decoded.slice(0,remaining));}return out;}
  if(type==='forward'){if(depth>=5){partial=true;return[{kind:'notice',text:'[嵌套聊天记录超出展示层级]'}];}return[{kind:'record',record:record(node,path,depth+1)}];}
  if(type==='text')return[{kind:'text',text:take(items(node,'Content')[0]?.text??'')}];
  if(type==='link')return[{kind:'link',text:take(value(node,'Title'),256),url:take(value(node,'Url'),2048)}];
  if(['image','file','voice','emotion'].includes(type))return[{kind:type==='emotion'?'image':type,resource:path,...(type==='file'?{name:take(value(node,'FileName')||'文件',256)}:{})}];
  return[{kind:'notice',text:describeMessage(node,names,depth,localCorpId)}];
 };
 const record=(node,path,depth)=>{
  const forward=items(node,'ForwardMessage')[0],title=take(value(forward,'Title')||'聊天记录',256),list=items(items(forward,'MsgItemList')[0],'MsgItem'),entries=[];
  for(let i=0;i<list.length;i++){
   if(count>=1000||budget>1200000){partial=true;break;}count++;
   const n=list[i],id=value(n,'Sender'),identity=senderIdentity(id,value(n,'SenderCorpId'),localCorpId),p=path?path+'.'+(i+1):String(i+1),at=value(n,'Time')?Number(value(n,'Time'))*1000:NaN;
   entries.push({path:p,sender:{id:take(identity.external?identity.id:id,256),name:take(identity.external?identity.displayName:names.get(id)??id??'未知发送人',256)},...(Number.isSafeInteger(at)&&at>=0&&at<=8640000000000000?{at}:{}),parts:parts(n,p,depth)});
  }
  return{version:1,title,entries};
 };
 const result=record(msg,'',0);if(partial)result.partial=true;return result;
}
