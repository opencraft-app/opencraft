import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { describeChoice, answeredCard, timelineText } from '../../plugins/wecom/mirror/cards.mjs';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';
import { createWeComChannelTransport } from '../../plugins/wecom/channel-transport.mjs';

const source = JSON.stringify(['wecom-customer-service', 'wxfixture', 'fwfixture', 'room']);
const buttons = { card_type: 'button_interaction', task_id: 't1', main_title: { title: '部署审批' }, button_list: [{ text: '批准', key: 'ok', style: 1 }, { text: '拒绝', key: 'no', style: 2 }] };
const vote = { card_type: 'vote_interaction', task_id: 't2', main_title: { title: '午饭' },
  checkbox: { question_key: 'lunch', mode: 1, option_list: [{ id: 'a', text: '面' }, { id: 'b', text: '饭' }] }, submit_button: { text: '提交', key: 'submit' } };

test('card outcomes use the labels the card was sent with', () => {
  assert.equal(describeChoice(buttons, { eventKey: 'no' }), '拒绝');
  assert.equal(describeChoice(vote, { eventKey: 'submit', selected: [{ questionKey: 'lunch', optionIds: ['a', 'b'] }] }), '面、饭');
  assert.equal(describeChoice(null, { eventKey: 'raw' }), 'raw');
  const done = answeredCard(vote, 'skipzhang', '面');
  assert.equal(done.checkbox.disable, true); assert.equal(done.main_title.desc, '✅ skipzhang 已选择：面');
  assert.equal(answeredCard({ card_type: 'unknown', main_title: { title: '已处理' } }, 'x', 'ok').card_type, 'text_notice');
  assert.equal(timelineText(buttons, '批准'), '[卡片] 部署审批 → 批准');
});

function fixture({ bound = true } = {}) {
  const kv = new Map(), calls = { update: [], ingest: [], send: [] };
  const store = {
    rememberCard: async (s, t, c) => kv.set('card' + s + t, c), card: async (s, t) => kv.get('card' + s + t) ?? null,
    claimCardEvent: async (s, id) => kv.has('ev' + s + id) ? false : (kv.set('ev' + s + id, 1), true),
    answerCard: async (s, t, a) => kv.has('ans' + s + t) ? [false, kv.get('ans' + s + t)] : (kv.set('ans' + s + t, a), [true, a]),
    snapshot: async () => ({ binding: bound ? { serverId: 'one' } : null }),
    ingest: async event => { calls.ingest.push(event); return 'stored'; },
  };
  const transport = { subscribe: () => () => {}, senderNames: async () => new Map([['T1A', 'skipzhang'], ['T2B', 'lisi']]),
    updateCard: async (...a) => { calls.update.push(a); return 0; }, sendCard: async (...a) => { calls.send.push(a); return 'delivered'; } };
  return { service: new MirrorService({ store, transport, servers: [], corpId: 'wxfixture' }), calls };
}
const click = (over = {}) => ({ source, id: 'E1', author: 'T1A', cardType: 'button_interaction', eventKey: 'ok', taskId: 't1', responseCode: 'RC1', selected: [], at: 1, ...over });

test('first answer updates the card and records once; later clicks see the recorded answer', async () => {
  const f = fixture();
  assert.equal(await f.service.sendCard(source, buttons, AbortSignal.timeout(1000)), 'delivered');
  assert.equal(await f.service.cardEvent(click()), 'stored');
  assert.equal(f.calls.update[0][0], 'RC1');
  assert.equal(f.calls.update[0][1].sub_title_text, '✅ skipzhang 已选择：批准');
  assert.deepEqual(f.calls.ingest[0], { source, id: 'card:E1', author: 'T1A', sender: { id: 'T1A', displayName: 'skipzhang' }, text: '[卡片] 部署审批 → 批准', at: 1 });
  assert.equal(await f.service.cardEvent(click()), 'duplicate');
  assert.equal(await f.service.cardEvent(click({ id: 'E2', author: 'T2B', eventKey: 'no', responseCode: 'RC2' })), 'already_answered');
  assert.equal(f.calls.update[1][1].sub_title_text, '✅ skipzhang 已选择：批准', 'a late click re-shows the first answer');
  assert.equal(f.calls.ingest.length, 1);
  await assert.rejects(f.service.sendCard(source, { ...buttons, task_id: 'bad id' }, AbortSignal.timeout(1000)), /invalid_card/);
});

test('unknown cards still get answered; unbound rooms are not recorded', async () => {
  const f = fixture({ bound: false });
  assert.equal(await f.service.cardEvent(click({ taskId: 'from-cli' })), 'answered');
  assert.equal(f.calls.update[0][1].card_type, 'text_notice');
  assert.equal(f.calls.ingest.length, 0);
});

// Encrypted provider callback → transport → onCardEvent, acknowledged without forwarding.
const aesKey = Buffer.alloc(32, 1).toString('base64').replace(/=$/, '');
function encrypt(xml) {
  const key = Buffer.from(aesKey + '=', 'base64'), body = Buffer.from(xml), length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  let plain = Buffer.concat([randomBytes(16), length, body, Buffer.from('fwfixture')]); const pad = 32 - (plain.length % 32);
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]).toString('base64');
}
test('signed card callbacks reach onCardEvent with selections and are never forwarded', async () => {
  const events = [], forwarded = [];
  const t = createWeComChannelTransport({ corpId: 'wxfixture', corpSecret: 's', serviceId: 'fwfixture', token: 'fixture', aesKey,
    relayIngress: true, onCardEvent: async e => { events.push(e); }, fetcher: async () => Response.json({ errcode: 0 }) });
  const enc = encrypt(`<xml><ToUserName>wxfixture</ToUserName><ServiceId>fwfixture</ServiceId><AgentType>chat</AgentType><Msg>
    <From><Type>group</Type><Id>room</Id><Sender>T1A</Sender></From><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
    <MsgType>Event</MsgType><Event>template_card_event</Event><MsgId>E9</MsgId><ResponseCode>RC9</ResponseCode>
    <TemplateCardEvent><CardType>vote_interaction</CardType><EventKey>submit</EventKey><TaskId>t2</TaskId>
    <SelectedItems><SelectedItem><QuestionKey>lunch</QuestionKey><OptionIds><OptionId>a</OptionId><OptionId>b</OptionId></OptionIds></SelectedItem></SelectedItems>
    </TemplateCardEvent></Msg></xml>`);
  const ts = String(Math.floor(Date.now() / 1000)), sig = createHash('sha1').update(['fixture', ts, 'n', enc].sort().join('')).digest('hex');
  const req = Object.assign(Readable.from([Buffer.from(`<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`)]),
    { method: 'POST', headers: {}, setTimeout() {}, url: `${t.callback.path}?msg_signature=${sig}&timestamp=${ts}&nonce=n` });
  const res = { destroyed: false, writeHead(s) { this.status = s; }, end() {} };
  await t.callback.handle(req, res, body => { forwarded.push(body); res.status = 299; });
  assert.equal(res.status, 200); assert.equal(forwarded.length, 0);
  assert.equal(events[0].responseCode, 'RC9'); assert.equal(events[0].taskId, 't2'); assert.equal(events[0].source, source);
  assert.deepEqual(events[0].selected, [{ questionKey: 'lunch', optionIds: ['a', 'b'] }]);
});
