import { Lexer } from 'marked';
import { wecomAttributedText } from './message-attribution.mjs';
import { utf8Chunks } from './text-chunks.mjs';

export const MARKDOWN_BYTES = 4096;

/** Plan the whole reply before sending any part. null means send the original
 * as a file: do not tear apart lists, tables, links, HTML or code blocks. */
export function markdownMessageFrames(message) {
  const text=message.text;
  if(typeof text!=='string'||!text.trim()||!text.isWellFormed())throw Error('Invalid message Markdown');
  const header=wecomAttributedText({...message,text:''},true);
  const budget=MARKDOWN_BYTES-Buffer.byteLength(header);
  if(budget<4)return null;
  if(Buffer.byteLength(text)<=budget)return [header+text];
  const tokens=Lexer.lex(text,{gfm:true});
  // Reference definitions are document-wide; independently sent frames would
  // lose their targets. Lexer normalization must not silently change the source.
  if(Object.keys(tokens.links).length||tokens.some(t=>t.type==='html')||tokens.map(t=>t.raw).join('')!==text)return null;
  const blocks=[];
  for(const token of tokens) {
    if(Buffer.byteLength(token.raw)<=budget)blocks.push(token.raw);
    else if(token.type==='paragraph'&&!/[\\`*_[\]<>#~|+\-]|\d[.)]/u.test(token.raw)&&token.tokens?.every(t=>t.type==='text'&&t.raw===t.text)) {
      blocks.push(...utf8Chunks(token.raw,budget));
    } else return null;
  }
  const frames=[];let body='';
  for(const block of blocks) {
    if(Buffer.byteLength(body+block)>budget){frames.push(header+body);body='';}
    body+=block;
  }
  if(body)frames.push(header+body);
  return frames;
}

/** A refusal or unknown result after a delivered frame is a partial delivery,
 * never a clean rejection that could cause the caller to resend the whole reply. */
export async function sendMarkdownMessage(transport,message,signal) {
  signal.throwIfAborted();
  const frames=markdownMessageFrames(message);
  if(frames===null) {
    if(typeof transport.sendFile!=='function')return 'rejected';
    return transport.sendFile(message.source,'聊天消息.md',Buffer.from(wecomAttributedText(message,true)),signal);
  }
  if(typeof transport.sendMarkdown!=='function')return 'rejected';
  let delivered=0;
  for(const text of frames) {
    signal.throwIfAborted();
    const status=await transport.sendMarkdown({source:message.source,text},signal);
    if(status!=='delivered') {
      if(delivered)throw Error('partial_markdown_delivery');
      return status;
    }
    delivered++;
  }
  return 'delivered';
}
