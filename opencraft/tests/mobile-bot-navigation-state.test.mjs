import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyBotNavigation, selectBotNavigation, receiveBotNavigation, pruneBotNavigation, projectBotNavigation } from '../apps/workbench-expo/src/runtime/mobile-bot-navigation-state.ts';

const projection = (botId, overrides = {}) => ({
  type: 'bot-console-state', botId, section: 'chat',
  groups: [{ id: 'daily', label: 'Daily', sections: [{ id: 'skill', label: 'Skills' }] },
    { id: 'explore', label: 'Explore', sections: [{ id: 'model', label: 'Models' }] }],
  sessions: [{ chatId: `${botId}-chat`, title: `${botId} conversation`, pinned: false, unread: false }],
  selectedChatId: `${botId}-chat`, loading: false, hasMore: false, commandsReady: true,
  pinSupported: false, pending: false, error: false, ...overrides,
});
const visit = (state, id, overrides) => receiveBotNavigation(selectBotNavigation(state, id), projection(id, overrides));

test('cold switch retains feature rows but never exposes another Bot sessions or actions', () => {
  const a = visit(emptyBotNavigation(), 'a');
  const b = selectBotNavigation(a, 'b');
  const pending = projectBotNavigation(b, 'b', true);
  assert.strictEqual(pending.groups, projectBotNavigation(a, 'a', true).groups);
  assert.equal(pending.interactive, false);
  assert.equal(pending.consoleState, null);
  assert.equal(pending.placeholderRows, 1);
  const ready = projectBotNavigation(receiveBotNavigation(b, projection('b')), 'b', true);
  assert.equal(ready.interactive, true);
  assert.equal(ready.consoleState.sessions[0].chatId, 'b-chat');
});

test('warm switch restores only target snapshots; delayed old projection cannot enable commands', () => {
  let state = visit(visit(emptyBotNavigation(), 'a'), 'b');
  state = selectBotNavigation(state, 'a');
  state = receiveBotNavigation(state, projection('b', { error: true }));
  const pending = projectBotNavigation(state, 'a', true);
  assert.equal(pending.consoleState.sessions[0].chatId, 'a-chat');
  assert.equal(pending.consoleState.commandsReady, false);
  assert.equal(pending.consoleState.error, false);
  assert.equal(pending.interactive, false);
  assert.equal(projectBotNavigation(receiveBotNavigation(state, projection('a')), 'a', true).interactive, true);
});

test('empty loading refresh keeps this Bot rows; authoritative empty success removes them', () => {
  let state = visit(emptyBotNavigation(), 'a');
  state = receiveBotNavigation(state, projection('a', { sessions: [], loading: true }));
  const refreshing = projectBotNavigation(state, 'a', true).consoleState;
  assert.equal(refreshing.sessions.length, 1);
  assert.equal(refreshing.commandsReady, false);
  state = receiveBotNavigation(state, projection('a', { sessions: [] }));
  assert.equal(projectBotNavigation(state, 'a', true).consoleState.sessions.length, 0);
});

test('target-specific groups replace placeholders and successful capability removal is respected', () => {
  let state = selectBotNavigation(visit(emptyBotNavigation(), 'a'), 'b');
  const groups = [{ id: 'daily', label: 'Daily', sections: [{ id: 'automations', label: 'Tasks' }] }];
  state = receiveBotNavigation(state, projection('b', { groups }));
  assert.strictEqual(projectBotNavigation(state, 'b', true).groups, groups);
  state = receiveBotNavigation(state, projection('b', { groups: [] }));
  assert.deepEqual(projectBotNavigation(state, 'b', true).groups, []);
});

test('runtime pending disables cached mutations; empty scope, deletion and LRU retire data', () => {
  let state = visit(emptyBotNavigation(), 'a');
  assert.equal(projectBotNavigation(state, 'a', false).consoleState.commandsReady, false);
  assert.equal(projectBotNavigation(state, 'b', true).interactive, false);
  state = pruneBotNavigation(state, ['b']);
  assert.equal(state.snapshots.has('a'), false);
  assert.equal(state.confirmed, false);
  assert.deepEqual(projectBotNavigation(pruneBotNavigation(state, []), '', true).groups, []);
  assert.equal(projectBotNavigation(emptyBotNavigation(), 'a', true).consoleState, null);
  for (let n = 0; n < 40; n++) state = visit(state, String(n));
  assert.equal(state.snapshots.size, 32);
  assert.equal(state.snapshots.has('0'), false);
  assert.equal(state.snapshots.has('39'), true);
});
