import assert from'node:assert/strict';import test from'node:test';
import{groupVisibleText}from'../../plugins/wecom/group-receipts.mjs';
import{Store}from'../../../../apps/personal-assistant/src/store.mjs';
import{profileFor}from'../../../../apps/personal-assistant/test/helpers.mjs';
test('matching words are not provenance; only trusted host presentation suppresses progress',()=>{
 for(const s of['收到，继续。','好，在弄了，弄完告诉你。','好，停下了。'])assert.equal(groupVisibleText(s),s);
 assert.equal(groupVisibleText('好，在弄了，弄完告诉你。',{origin:'reception',text:''}),'');
 assert.equal(groupVisibleText('host\n\n收到，继续。',{origin:'reception',text:'收到，继续。'}),'收到，继续。');
 assert.equal(groupVisibleText('收到，继续。',{origin:'model',text:''}),'收到，继续。');
});
test('actual canonical reception projects host-only progress, preserving identical model replies in a mixed batch',t=>{
 const s=new Store(profileFor(t));t.after(()=>s.close());const a=s.app;
 const apply=(id,proposal)=>{a.reception.accept(id,{text:'请处理'});a.reception.apply(a.reception.turn(id),proposal);const m=a.messages.pending()[0];a.messages.accepted(m,{messageId:m.id,channel:m.body.channel,level:'accepted',remoteId:id});return m;};
 const reply=apply('reply',{kind:'reply',text:'好，在弄了，弄完告诉你。'});assert.equal(reply.presentation,undefined);assert.equal(groupVisibleText(reply.body.content,reply.presentation),reply.body.content);
 const host=apply('delegate',{kind:'delegate',goal:'分析问题'});assert.equal(host.presentation.origin,'reception');assert.equal(host.presentation.text,'');assert.ok(host.body.content);
 const batch=apply('batch',{kind:'batch',commands:[{kind:'delegate',goal:'独立分析'},{kind:'reply',text:'好，在弄了，弄完告诉你。'}]});assert.equal(groupVisibleText(batch.body.content,batch.presentation),'好，在弄了，弄完告诉你。');
 assert.throws(()=>a.history.prepareMessage({type:'text',content:'x',presentation:{origin:'reception',text:''}}));
});
