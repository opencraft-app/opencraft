import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseRequest } = require('../../packages/browser-cdp/src/automation/request.cjs');
const { press } = require('../../packages/browser-cdp/src/automation/keyboard.cjs');
const { createCdpAutomation } = require('../../packages/browser-cdp/src/automation/index.cjs');

test('native API rejects unbounded and arbitrary commands before drawing or dispatch', async () => {
  const automation = createCdpAutomation({ instanceId: 'test', sessions: () => [],
    transport: { subscribe: () => () => {}, send: () => assert.fail('Unexpected CDP dispatch') },
    acquireDrawing: () => assert.fail('Invalid requests must not acquire native resources'),
  });
  for (const [method, input] of [['Runtime.evaluate', {}], ['wait', { text: 'x', timeoutMs: Infinity }],
    ['scroll', { x: NaN, y: 0 }], ['fill', { ref: 'x', expectedRevision: 1, value: 42 }],
    ['inspect', { expression: 'untrusted code' }], ['press', { key: 'unknown+Enter' }]])
    await assert.rejects(automation.invoke(method, input), { code: 'INVALID_ARGUMENT', outcome: 'not-dispatched' });
  automation.dispose();
});

test('admission copies a bounded request and preserves intentional whitespace', () => {
  const input = { ref: 'instance:1:1', expectedRevision: 1, value: '  draft\n ' };
  const parsed = parseRequest('fill', input, 'linux'); input.value = 'different';
  assert.equal(parsed.value, '  draft\n '); assert(Object.isFrozen(parsed));
});

test('failed native key down releases all admitted keys once, without replay', async () => {
  const seen = [];
  await assert.rejects(press(async (method, input) => {
    seen.push([method, input]);
    if (input.key === 'Enter') throw Object.assign(new Error('Result unknown'), { code: 'CDP_TIMEOUT' });
  }, async (method, input) => { seen.push([method, input]); }, 'Control+Shift+Enter', 'linux'), { code: 'CDP_TIMEOUT' });
  assert.deepEqual(seen.map(([, event]) => [event.type, event.key]), [
    ['rawKeyDown', 'Control'], ['rawKeyDown', 'Shift'], ['rawKeyDown', 'Enter'],
    ['keyUp', 'Enter'], ['keyUp', 'Shift'], ['keyUp', 'Control'],
  ]);
  assert.equal(seen.at(-1)[1].modifiers, 0);
});

test('release failures never conceal the original operation error or omit other releases', async () => {
  const released = [];
  await assert.rejects(press(async () => { throw Object.assign(new Error('Control revoked'), { code: 'CONTROL_LOST' }); },
    async (_method, event) => { released.push(event.key); throw new Error('Release also failed'); }, 'Control+Enter', 'linux'), { code: 'CONTROL_LOST' });
  assert.deepEqual(released, ['Control']);
});

test('native character input and platform shortcuts retain keyboard semantics', async () => {
  const events = [];
  const send = async (_method, event) => { events.push(event); };
  await press(send, send, 'Shift+a', 'linux');
  assert.equal(events[1].key, 'A'); assert.equal(events[1].text, 'A');
  events.length = 0;
  await press(send, send, 'ControlOrMeta+a', 'darwin');
  assert.equal(events[0].key, 'Meta'); assert.equal(events[1].text, undefined);
});
