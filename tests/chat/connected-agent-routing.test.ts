import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';

test('connected sessions use their deployed Host authority, including the native Pi and Claude paths', () => {
  const execution = createRoutedConversationExecution(() => null, { machineId:'fixture', engines:['dsh'], connectedAgentsOwner:'dsh', getInputs:async () => null });
  for (const id of ['codex_new','claude_new','codebuddy_new','pi_new','cursor_new']) {
    assert.equal(execution.serverForHost('opencraft-server', id), 'server:fixture:dsh');
    assert.equal(execution.serverForThread(id), 'server:fixture:dsh');
  }
  assert.equal(execution.serverForHost('local-codex','native-uuid'), 'server:fixture:codex');
  assert.throws(() => execution.serverForHost('opencraft-server','acp_unknown'));
});

test('separately deployed engines retain their own authority', () => {
  const execution = createRoutedConversationExecution(() => null, { machineId:'fixture', engines:['dsh','pi','claude-code'], connectedAgentsOwner:'dsh', getInputs:async () => null });
  assert.equal(execution.serverForThread('pi_new'), 'server:fixture:pi');
  assert.equal(execution.serverForThread('claude_new'), 'server:fixture:claude-code');
  const absent = createRoutedConversationExecution(() => null, { machineId:'fixture', engines:['dsh'], getInputs:async () => null });
  assert.throws(() => absent.serverForHost('opencraft-server','pi_new'));
});
