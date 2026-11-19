import test from'node:test';import assert from'node:assert/strict';
import{wecomAuthorPrefix,wecomAttributedText}from'../../plugins/wecom/message-attribution.mjs';
test('chat icon and identity occupy their own line before literal body',()=>{assert.equal(wecomAttributedText({author:'skipzhang',serverId:'server-01',text:'你好'}),'💬 skipzhang · server-01\n你好');});
test('existing body paragraphs are preserved rather than flattened',()=>{assert.equal(wecomAttributedText({author:'skipzhang',serverId:'server-01',text:'第一段\n第二段'}),'💬 skipzhang · server-01\n第一段\n第二段');});
test('Markdown reply and standalone message use the same compact label',()=>{assert.equal(wecomAttributedText({author:'skipzhang',serverId:'server-01',text:'你好'},true),'**💬 skipzhang · server-01**\n\n你好');});
test('legacy local transports omit unknown server instead of inventing an ID',()=>{assert.equal(wecomAuthorPrefix({author:'skipzhang'}),'💬 skipzhang\n');});
test('author controls cannot insert a new header line and invalid server labels fail closed',()=>{assert.equal(wecomAuthorPrefix({author:'skip\nzhang\u202e',serverId:'server-01'}),'💬 skipzhang · server-01\n');assert.equal(wecomAuthorPrefix({author:'skipzhang',serverId:'bad\nserver'}),'');assert.equal(wecomAuthorPrefix({author:'  ',serverId:'s'}),'');});
test('Markdown metacharacters in author labels are escaped without escaping user content',()=>{assert.equal(wecomAttributedText({author:'*name*',serverId:'s',text:'**body**'},true),'**💬 \\*name\\* · s**\n\n**body**');});

test('all encoders shorten generated Hub attribution, without mutating origin or body',()=>{const message={author:'skipzhang的助理',serverId:'hub-d00bd6f39112a3c11a62656c397b9515c5a1f2e2',text:'# 说明\n\n**正文**'};assert.equal(wecomAttributedText(message,true),'**💬 skipzhang的助理 · hub-d00bd6f3**\n\n# 说明\n\n**正文**');assert.equal(message.serverId,'hub-d00bd6f39112a3c11a62656c397b9515c5a1f2e2');assert.equal(wecomAttributedText(message),'💬 skipzhang的助理 · hub-d00bd6f3\n# 说明\n\n**正文**');});

const presentation=(name,role,format='text')=>({version:1,sender:{id:'native',displayName:name,role},format});
test('icons follow validated roles, never nickname, Markdown syntax or format',()=>{
 for(const [role,icon]of [['human','💬'],['system','💬'],['agent','🤖'],['assistant','🤖']])for(const format of ['text','markdown']){
  const message={author:'同名的助理',text:'**原文**\n第二段',presentation:presentation('同名的助理',role,format)};
  assert.equal(wecomAttributedText(message),icon+' 同名的助理\n**原文**\n第二段');
  assert.equal(wecomAttributedText(message,true),'**'+icon+' 同名的助理**\n\n**原文**\n第二段');
 }
 assert.equal(wecomAuthorPrefix({author:'🤖 个人助理'}),'💬 🤖 个人助理\n');
 assert.equal(wecomAuthorPrefix({author:'管家',requestId:'wecom-assistant:'+'a'.repeat(64)}),'🤖 管家\n');
 assert.equal(wecomAuthorPrefix({author:'管家',requestId:'wecom-assistant:fake'}),'💬 管家\n');
});
test('invalid declared roles do not render an agent icon or fall back silently',()=>{
 assert.throws(()=>wecomAuthorPrefix({author:'Alice',presentation:presentation('Alice','admin')}),/invalid_message_presentation/);
 assert.throws(()=>wecomAuthorPrefix({author:'Alice',presentation:presentation('Mallory','assistant')}),/invalid_message_presentation/);
});
