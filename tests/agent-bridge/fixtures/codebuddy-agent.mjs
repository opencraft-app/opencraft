import { createInterface } from 'node:readline';
const scenario = process.env.CODEBUDDY_FIXTURE ?? 'success';
const sid = 'codebuddy-session';
let run = 0;
let promptId;
let late;
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const response = (id, result) => send({ id, result });
const owner = () => `owner-${run}`;
const update = (kind, id, nativeOwner = owner(), sessionId = sid, metaId = false) => send({
  method: 'session/update', params: { sessionId, update: {
    sessionUpdate: kind, content: { type: 'text', text: 'fixture' },
    ...(metaId ? {} : { messageId: id }),
    _meta: { 'codebuddy.ai/conversationRequestId': nativeOwner, ...(metaId ? { 'codebuddy.ai/messageId': id } : {}) },
  } },
});
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialize') response(id, {
    protocolVersion: 1, _meta: { midTurnSteering: true },
    agentCapabilities: { promptCapabilities: { image: true } },
  });
  if (method === 'session/new') response(id, { sessionId: sid });
  if (method === 'session/steer' && !params.sessionId) {
    send({ id, error: { code: -32602, message: scenario === 'probe-drift'
      ? 'sessionId is required' : 'Steer operation requires "sessionId"' } });
  } else if (method === 'session/steer') {
    const mid = params.clientUserMessageId;
    const admission = () => response(id, { steered: true, ownerRequestId: scenario === 'wrong-admission-owner' ? 'alien' : owner() });
    const inserted = () => {
      if (!['missing-insertion', 'hold-missing-insertion', 'late-receipts'].includes(scenario)) {
        update('user_message_chunk', scenario === 'wrong-id' ? 'alien-id' : mid,
          scenario === 'wrong-insertion-owner' ? 'alien' : owner(),
          scenario === 'wrong-session' ? 'alien-session' : sid, scenario === 'meta-id');
      }
    };
    if (scenario === 'echo-first') { inserted(); admission(); }
    else { if (scenario !== 'missing-admission') admission(); inserted(); }
    // Coalesced frames exercise response/notification/turn-end microtask ordering.
    if (scenario === 'late-receipts') late = { id: mid, owner: owner() };
    if (scenario !== 'hold-missing-insertion') response(promptId, { stopReason: 'end_turn' });
  }
  if (method === 'session/prompt') {
    promptId = id;
    run++;
    if (late) update('user_message_chunk', late.id, late.owner);
    update('user_message_chunk', `initial-${run}`);
  }
  if (method === 'session/cancel') response(promptId, { stopReason: 'cancelled' });
});
