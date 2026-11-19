/** Additive display metadata on the existing outbound envelope. It conveys no
 * authority: origin, binding, membership and notification checks stay separate. */
export function messagePresentation(message) {
  const p=message.presentation;
  if(p===undefined) {
    // Old Gateways give native assistant replies a server-assigned immutable ID.
    // Ordinary channel messages use UUIDs. Never infer a role/format from a name,
    // content, @ occurrence, reply anchor, or the stream feature switch.
    const assistant=typeof message.requestId==='string'&&/^wecom-assistant:[a-f0-9]{64}$/u.test(message.requestId);
    return {version:0,sender:{id:null,role:assistant?'assistant':'unknown',displayName:message.author},format:assistant?'markdown':'text'};
  }
  if(!p||typeof p!=='object'||Array.isArray(p)||p.version!==1
    ||Object.keys(p).some(k=>!['version','sender','format'].includes(k))
    ||!['text','markdown'].includes(p.format)||!p.sender||typeof p.sender!=='object'||Array.isArray(p.sender)
    ||Object.keys(p.sender).some(k=>!['id','role','displayName'].includes(k))
    ||typeof p.sender.id!=='string'||!p.sender.id.trim()||p.sender.id.length>512||/[\p{Cc}\p{Bidi_Control}]/u.test(p.sender.id)
    ||!['human','agent','assistant','system'].includes(p.sender.role)
    ||typeof p.sender.displayName!=='string'||!p.sender.displayName.trim()||p.sender.displayName.length>256
    ||p.sender.displayName!==message.author)throw Error('invalid_message_presentation');
  return p;
}
