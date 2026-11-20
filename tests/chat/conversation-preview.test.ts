import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationPreview, type TimelineFrame } from '@opencraft/chat-core';
const frames = (...blocks: any[]): TimelineFrame[] => blocks.map((block, i) => ({ type: 'assistant', id: String(i), blocks: [block] } as TimelineFrame));
const user = (message: string) => ({ type: 'user-message', message });
const text = (text: string, phase: string = 'commentary') => ({ type: 'text', text, phase });
test('recent question and conclusion displace intermediate commentary', () => {
 assert.deepEqual(conversationPreview(frames(user('old'), text('old answer', 'final_answer'), user('new'), text('progress one'), text('progress two'), text('**Answer** [guide](/tmp/private)', 'final_answer'))), [{role:'user',text:'new'},{role:'assistant',text:'Answer guide'}]);
});
test('a new unanswered question never inherits an older answer; live progress uses latest update', () => {
 assert.deepEqual(conversationPreview(frames(user('old'),text('old answer','final_answer'),user('new'))),[{role:'user',text:'new'}]);
 assert.deepEqual(conversationPreview(frames(user('new'),text('one'),text('two'))),[{role:'user',text:'new'},{role:'assistant',text:'two'}]);
});
test('partial histories and empty blocks do not lose the latest answer', () => {
 assert.deepEqual(conversationPreview(frames(text('answer','final_answer'),text('  '))),[{role:'assistant',text:'answer'}]);
 assert.deepEqual(conversationPreview([]),[]);
});
