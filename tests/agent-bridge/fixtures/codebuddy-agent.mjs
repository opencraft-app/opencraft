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
    _meta: { ...(scenario === 'ownerless' ? {} : { 'codebuddy.ai/conversationRequestId': nativeOwner }), ...(metaId ? { 'codebuddy.ai/messageId': id } : {}) },
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
    if (['explicit-reject', 'explicit-reject-after-insertion'].includes(scenario)) {
      if (scenario === 'explicit-reject-after-insertion') update('user_message_chunk', mid);
      send({ id, error: { code: -32602, message: 'Steer explicitly rejected' } });
      response(promptId, { stopReason: 'end_turn' });
      return;
    }
    if (['coalesced-before-end', 'insertion-after-end', 'admission-after-end'].includes(scenario)) {
      const admitted = { id, result: { steered: true, ownerRequestId: owner() } };
      const ended = { id: promptId, result: { stopReason: 'end_turn' } };
      const inserted = { method: 'session/update', params: { sessionId: sid, update: {
        sessionUpdate: 'user_message_chunk', messageId: mid,
        content: { type: 'text', text: 'fixture' },
        _meta: { 'codebuddy.ai/conversationRequestId': owner() },
      } } };
      const frames = scenario === 'coalesced-before-end' ? [admitted, inserted, ended]
        : scenario === 'insertion-after-end' ? [admitted, ended, inserted] : [inserted, ended, admitted];
      // One write preserves the exact frame order across the Promise boundary.
      process.stdout.write(frames.map((frame) => JSON.stringify({ jsonrpc: '2.0', ...frame })).join('\n') + '\n');
      return;
    }
    const admission = () => response(id, { steered: true, ownerRequestId: scenario === 'wrong-admission-owner' ? 'alien' : owner() });
    const inserted = () => {
      if (!['missing-insertion', 'hold-missing-insertion', 'late-receipts', 'stop-ignored'].includes(scenario)) {
        update('user_message_chunk', scenario === 'wrong-id' ? 'alien-id' : mid,
          scenario === 'wrong-insertion-owner' ? 'alien' : owner(),
          scenario === 'wrong-session' ? 'alien-session' : sid, scenario === 'meta-id');
      }
    };
    if (scenario === 'echo-first') { inserted(); admission(); }
    else { if (scenario !== 'missing-admission') admission(); inserted(); }
    // Coalesced frames exercise response/notification/turn-end microtask ordering.
    if (scenario === 'late-receipts') late = { id: mid, owner: owner() };
    if (!['hold-missing-insertion', 'stop-ignored'].includes(scenario)) response(promptId, { stopReason: 'end_turn' });
  }
  if (method === 'session/prompt') {
    promptId = id;
    run++;
    if (late) update('user_message_chunk', late.id, late.owner);
    update('user_message_chunk', `initial-${run}`);
  }
  if (method === 'session/cancel' && scenario !== 'stop-ignored') response(promptId, { stopReason: 'cancelled' });
});
