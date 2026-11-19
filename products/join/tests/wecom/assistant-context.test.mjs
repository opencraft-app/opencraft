import test from 'node:test';
import assert from 'node:assert/strict';
import { wecomMention } from '../../plugins/wecom/assistant-mentions.mjs';
import { groupMentionInput } from '../../plugins/wecom/assistant-context.mjs';

const trigger = { id: 'mention', seq: 60, content: '@Join 支持 (Join 支持)', author_id: 'alice', created_at: 1700000000000 };
const decode = text => JSON.parse(text.slice(text.indexOf('\n') + 1));
test('all file processing is agent-driven, not format-specific extraction or text pagination',()=>{
  const text=groupMentionInput('room',trigger,{messages:[],hasEarlier:false});
  assert.match(text,/所有文件统一保留原件/u);
  assert.match(text,/由 agent 根据主人的任务自主选择工具/u);
  assert.match(text,/不按 PDF、Word、Excel、PPT、CSV、纯文本等格式预设处理流程/u);
  assert.doesNotMatch(text,/cursor:"1"|全文已转成文字|可提取文字的文档/u);
});
test('mention-only, expanded spaced names and provider separators retain the actual request', () => {
  for (const text of ['@机器人', '@Join 支持 (Join 支持)', '@Join 支持（Join 支持）', '@Join 支持\u2005', ''])
    assert.deepEqual(wecomMention({ mentioned: true, text }), { kind: 'assistant', text: '' });
  for (const text of ['@机器人 看下上文', '@Join 支持 (Join 支持) 看下上文', '@Join 支持\u2005看下上文'])
    assert.deepEqual(wecomMention({ mentioned: true, text }), { kind: 'assistant', text: '看下上文' });
  assert.deepEqual(wecomMention({ mentioned: true, text: '@机器人 解释 (括号内容)' }), { kind: 'assistant', text: '解释 (括号内容)' });
  assert.deepEqual(wecomMention({ mentioned: true, text: '@Join 支持 (Join 支持) 帮助' }), { kind: 'command', action: '帮助', argument: null });
  assert.equal(wecomMention({ mentioned: false, text: trigger.content }), null);
});
test('group scene carries trigger provenance and current conversation before a bare mention', () => {
  const messages = [{ messageId: 'call', sequence: 58, text: '老歌在吗' }, { messageId: 'followup', sequence: 59, text: '刚才的问题看一下' }];
  const context = decode(groupMentionInput('room-a', trigger, { messages, hasEarlier: false }));
  assert.equal(context.channelId, 'room-a');
  assert.equal(context.publicReply, true);
  assert.deepEqual(context.trigger, { messageId: 'mention', seq: 60, authorId: 'alice', at: 1700000000000 });
  assert.deepEqual(context.request, { rawText: trigger.content, text: '', mentionOnly: true });
  assert.deepEqual(context.history, { messages, truncated: false, omittedMessages: 0, hasEarlier: false, nextBefore: 58 });
});
test('UTF-8 history budget preserves the newest complete messages and a usable older-page cursor', () => {
  const messages = [
    { messageId: 'old', sequence: 1, text: '旧问题'.repeat(9000) },
    { messageId: 'call', sequence: 58, text: '老歌在吗😀' },
    { messageId: 'followup', sequence: 59, text: '看上文' },
  ];
  const context = decode(groupMentionInput('room', trigger, { messages, hasEarlier: false }, 250));
  assert.deepEqual(context.history.messages, messages.slice(1));
  assert.ok(Buffer.byteLength(JSON.stringify(context.history.messages)) <= 250);
  assert.equal(context.history.nextBefore, 58);
  assert.equal(context.history.hasEarlier, true);
  assert.equal(context.history.truncated, true);
  assert.equal(context.history.omittedMessages, 1);
});
test('empty or oversized newest history remains explicitly incomplete and can be queried from the trigger', () => {
  const context = decode(groupMentionInput('room', trigger, { messages: [{ sequence: 59, text: '长消息'.repeat(200) }], hasEarlier: false }, 100));
  assert.deepEqual(context.history.messages, []);
  assert.equal(context.history.truncated, true);
  assert.equal(context.history.nextBefore, 60);
  const empty = decode(groupMentionInput('room', trigger, { messages: [], hasEarlier: true }));
  assert.equal(empty.history.hasEarlier, true);
  assert.equal(empty.history.nextBefore, 60);
});

test('ascii-heavy history and long requests stay within the assistant input limit', () => {
  const messages = Array.from({ length: 80 }, (_, i) => ({ sequence: i + 1, text: 'x'.repeat(900) }));
  const text = groupMentionInput('room', { id: 'm', seq: 99, author_id: 'a', created_at: 1, content: '@bot ' + 'y'.repeat(30000) }, { messages, hasEarlier: false });
  assert.ok(text.length <= 18000, String(text.length));
  const context = decode(text);
  assert.ok(context.history.messages.length > 0 && context.history.truncated);
  assert.ok(context.request.rawText.length < 4100);
});

test('group tool guidance prefers receipts over claims and delegates original images without OCR',()=>{
 const text=groupMentionInput('room',trigger,{messages:[],hasEarlier:true});
 for(const phrase of ['taskKey','wecom task list','task get TASKKEY','image","get','查看进度'])assert.ok(text.includes(phrase),phrase);
 assert.match(text,/看图工具/u);assert.match(text,/不.*OCR/u);assert.match(text,/chat","live/u);
 assert.match(text,/不要额外补发“请看上面助理的消息”/u);
});
