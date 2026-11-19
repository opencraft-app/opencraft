/** Presentation only. The Relay supplies full serverId/serverName from its
 * authenticated installation, never from a caller's claimed origin. */
import { messagePresentation } from './message-presentation.mjs';

const clean=value=>typeof value==='string'?value.replace(/[\p{Bidi_Control}\p{Cc}\p{Zl}\p{Zp}]/gu,'').trim():'';
export function wecomAuthorPrefix(message) {
  const {author,serverId,serverName}=message;
  const name=clean(author);
  if(!name)return '';
  if(serverId!==undefined&&(typeof serverId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/u.test(serverId)))return '';
  // Role comes from validated metadata (or the explicit legacy adapter), never
  // from a nickname, a Markdown-looking body, or a claimed origin.
  const role=messagePresentation(message).sender.role;
  const icon=role==='assistant'||role==='agent'?'🤖':'💬';
  if(serverId===undefined)return icon+' '+name+'\n';
  const compact=serverId.replace(/^hub-([a-f0-9]{32,64})$/u,(_,id)=>'hub-'+id.slice(0,8));
  const configured=clean(serverName);
  const label=configured&&configured!==serverId?configured:compact;
  const points=Array.from(label),origin=points.length>32?points.slice(0,32).join('')+'…':label;
  return icon+' '+name+' · '+origin+'\n';
}
export function wecomAttributedText(message,markdown=false) {
  const prefix=wecomAuthorPrefix(message);
  if(!markdown)return prefix+message.text;
  const label=prefix.trimEnd();
  // Encoding differs, attribution does not. Keep body Markdown at a block boundary.
  return (label?'**'+label.replace(/[\\`*_[\]<>#]/gu,'\\$&')+'**\n\n':'')+message.text;
}
