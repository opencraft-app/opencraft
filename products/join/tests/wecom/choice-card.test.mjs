import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choiceQuestionText, parseChoiceQuestion, CHOICE_HINT } from '../../plugins/wecom/choice-card.mjs';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';
import { wecomMention } from '../../plugins/wecom/assistant-mentions.mjs';

const source = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'room']);

test('choice questions are readable text that round-trips into a card definition', () => {
  const text = choiceQuestionText('用哪个方案？', [{ label: '方案 A' }, { label: '方案 B', value: 'b' }, { label: '' }]);
  assert.equal(text, `用哪个方案？\n\n1. 方案 A\n2. 方案 B\n${CHOICE_HINT}`);
  assert.deepEqual(parseChoiceQuestion(text), { prompt: '用哪个方案？', choices: ['方案 A', '方案 B'] });
  assert.equal(choiceQuestionText('自由回答？', []), '自由回答？');
  assert.equal(parseChoiceQuestion('普通回答\n1. 不是选择题'), null);
  assert.equal(parseChoiceQuestion(`没有空行\n1. A\n${CHOICE_HINT}`), null);
});

test('a clicked choice is an assistant mention, not a control command', () => {
  assert.deepEqual(wecomMention({ mentioned: true, text: '选择：方案 A' }), { kind: 'assistant', text: '选择：方案 A' });
});

function fixture() {
  const kv = new Map(), calls = { cards: [], updates: [], ingest: [], respond: [] };
  const store = {
    rememberCard: async (s, t, c) => kv.set('card' + s + t, c), card: async (s, t) => kv.get('card' + s + t) ?? null,
    rememberMention: async (s, id, a) => kv.set('m' + s + id, a), mentionAuthor: async (s, id) => kv.get('m' + s + id) ?? null,
    claimCardEvent: async (s, id) => kv.has('ev' + id) ? false : (kv.set('ev' + id, 1), true),
    answerCard: async (s, t, a) => kv.has('ans' + t) ? [false, kv.get('ans' + t)] : (kv.set('ans' + t, a), [true, a]),
    claimStream: async () => true,
    snapshot: async () => ({ binding: { serverId: 'one' } }),
    ingest: async e => { calls.ingest.push(e); return 'stored'; },
  };
  const transport = { subscribe: () => () => {}, senderNames: async () => new Map([['T1A', 'skipzhang'], ['T2B', 'lisi']]),
    respond: async (...a) => { calls.respond.push(a); return 0; }, send: async () => 'delivered',
    sendCard: async (s, c) => { calls.cards.push(c); return 'delivered'; },
    updateCard: async (...a) => { calls.updates.push(a); return 0; } };
  const service = new MirrorService({ store, transport, servers: [], corpId: 'wxfixture', streamReplies: true });
  return { service, calls, store };
}
const settle = svc => Promise.allSettled([...svc.pending]);

test('the requester gets buttons; only the requester can answer and the answer reaches their assistant', async () => {
  const f = fixture();
  await f.store.rememberMention(source, 'MSG-1', 'T1A');
  const text = choiceQuestionText('用哪个方案？', [{ label: '方案 A' }, { label: '方案 B' }]);
  assert.equal(await f.service.reply({ source, requestId: 'r1', text, author: 'skipzhang的助理', replyTo: 'MSG-1' }, AbortSignal.timeout(1000)), 'delivered');
  await settle(f.service);
  const [card] = f.calls.cards;
  assert.equal(card.card_type, 'button_interaction'); assert.equal(card.owner, undefined, 'owner never leaves the Relay');
  assert.deepEqual(card.button_list.map(b => b.text), ['方案 A', '方案 B']);
  const click = over => ({ source, id: 'E', author: 'T1A', cardType: 'button_interaction', eventKey: 'c2', taskId: card.task_id, responseCode: 'RC', selected: [], at: 5, ...over });

  assert.equal(await f.service.cardEvent(click({ id: 'E0', author: 'T2B', responseCode: 'RC0' })), 'not_owner');
  assert.deepEqual(f.calls.updates[0][2], ['T2B'], 'the note is shown only to the other clicker');
  assert.equal(f.calls.ingest.length, 0);

  assert.equal(await f.service.cardEvent(click({ id: 'E1' })), 'stored');
  assert.equal(f.calls.updates[1][1].sub_title_text, '✅ skipzhang 已选择：方案 B');
  assert.deepEqual(f.calls.ingest[0], { source, id: 'card:E1', author: 'T1A', sender: { id: 'T1A', displayName: 'skipzhang' }, text: '选择：方案 B', at: 5, mentioned: true });
});

test('plain answers and unknown requesters get no card', async () => {
  const f = fixture();
  await f.service.reply({ source, requestId: 'r', text: '普通回答', author: 'A', replyTo: 'MSG-1' }, AbortSignal.timeout(1000));
  await f.service.reply({ source, requestId: 'r2', text: choiceQuestionText('Q', [{ label: 'x' }]), author: 'A', replyTo: 'MSG-unknown' }, AbortSignal.timeout(1000));
  await settle(f.service);
  assert.equal(f.calls.cards.length, 0);
});

test('the card menu lets the requester skip; the assistant hears it as an answer', async () => {
  const f = fixture();
  await f.store.rememberMention(source, 'MSG-1', 'T1A');
  await f.service.reply({ source, requestId: 'r1', text: choiceQuestionText('Q', [{ label: 'A' }, { label: 'B' }]), author: 'A', replyTo: 'MSG-1' }, AbortSignal.timeout(1000));
  await settle(f.service);
  const [card] = f.calls.cards;
  assert.deepEqual(card.action_menu.action_list.map(a => a.key), ['oc-skip']);
  assert.equal(await f.service.cardEvent({ source, id: 'E1', author: 'T1A', cardType: 'button_interaction', eventKey: 'oc-skip', taskId: card.task_id, responseCode: 'RC', selected: [], at: 5 }), 'stored');
  assert.equal(f.calls.updates[0][1].sub_title_text, '✅ skipzhang 已选择：不选了');
  assert.equal(f.calls.ingest[0].text, '选择：不选了');
});
