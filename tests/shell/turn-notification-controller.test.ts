import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTurnNotifications } from '../../apps/workbench-web/src/runtime/browser-turn-notifications';
import { PwaTurnPushController } from '../../apps/workbench-web/src/runtime/pwa-turn-push';
import { TurnNotificationController } from '../../apps/workbench-web/src/runtime/turn-notification-controller';

const subscription = { endpoint: 'https://web.push.apple.com/fixture', keys: { p256dh: 'key', auth: 'auth' } };
const messages = { completed: 'Complete', failed: 'Failed', interrupted: 'Stopped', body: 'Open', test: 'Test' };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture({ persistent = false, online = false, enrolled = false, available = true } = {}) {
  let preference = online, deviceSubscription = enrolled, serverConsent = enrolled, failure = false, saveFailure = false;
  let permission: NotificationPermission = 'granted';
  let failRead = false;
  const order: string[] = [], shown: unknown[] = [], listeners = new Set<() => void>();
  class NotificationFixture {
    static get permission() { return permission; }
    static requestPermission = async () => { order.push('page-permission'); return permission; };
    constructor(title: string, options: unknown) { shown.push({ title, options }); }
    close() {}
  }
  const page = new BrowserTurnNotifications({ secure: true, notification: NotificationFixture as unknown as typeof Notification,
    serviceWorkers: null, pageUrl: () => 'https://workbench.test/', focus() {} });
  const preferences = {
    get: () => preference,
    set: async (_key: string, value: boolean) => { order.push(`preference:${value}`); if (saveFailure) throw Error('storage unavailable'); preference = value; listeners.forEach(listener => listener()); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const device = { supported: true, permission: () => permission, getSubscription: async () => deviceSubscription ? subscription : null,
    subscribe: async () => { order.push('push-permission'); deviceSubscription = true; return subscription; },
    unsubscribe: async () => { order.push('device-unsubscribe'); deviceSubscription = false; }, dispose() {} };
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    if (!init?.body && failRead) return new Response('', { status: 503 });
    if (!init?.body) return available ? Response.json({ available: true, publicKey: 'key', actorId: 'human', hosts: ['managed'] }) : new Response('', { status: 404 });
    const { operation } = JSON.parse(String(init.body)); order.push(operation);
    if (failure) return new Response('', { status: 503 });
    if (operation === 'subscribe') serverConsent = true;
    if (operation === 'unsubscribe') serverConsent = false;
    return Response.json({ enabled: serverConsent, sent: operation === 'test' });
  }) as typeof fetch;
  const push = persistent ? new PwaTurnPushController(device, fetcher) : undefined;
  const controller = new TurnNotificationController(persistent ? device : undefined, page, push);
  controller.connect(preferences as any); controller.configure('en-US', messages);
  const completion = { hostId: 'managed', threadId: 'thread', turnId: 'turn', status: 'completed' } as any;
  return { controller, order, shown, completion, push, preferences, preference: () => preference,
    fail: () => { failure = true; }, failRead: () => { failRead = true; }, failSave: () => { saveFailure = true; }, deny: () => { permission = 'denied'; }, subscribed: () => deviceSubscription };
}
test('ordinary browser has one explicit permission action and retains page preference', async () => {
  const f = fixture(); const enabling = f.controller.setEnabled(true);
  assert.deepEqual(f.order, ['page-permission'], 'permission starts before asynchronous preference storage');
  await enabling; assert.equal(f.controller.getSnapshot().enabled, true);
  await f.controller.show(f.completion, 'Complete', 'Open', () => {}); assert.equal(f.shown.length, 1);
  await f.controller.setEnabled(false); await f.controller.show(f.completion, 'Complete', 'Open', () => {});
  assert.equal(f.shown.length, 1); assert.equal(f.preference(), false); f.controller.dispose();
});
test('one PWA action enrolls push, deduplicates managed Hosts and preserves page fallback for other Hosts', async () => {
  const f = fixture({ persistent: true }); await settle();
  const enabling = f.controller.setEnabled(true); assert.deepEqual(f.order, ['push-permission']); await enabling;
  assert.equal(f.controller.getSnapshot().delivery, 'background'); assert.equal(f.preference(), true);
  await f.controller.show(f.completion, 'Complete', 'Open', () => {}); assert.equal(f.shown.length, 0);
  await f.controller.show({ ...f.completion, hostId: 'external' }, 'Complete', 'Open', () => {}); assert.equal(f.shown.length, 1);
  await f.controller.setEnabled(false); assert.equal(f.subscribed(), false); assert.equal(f.controller.getSnapshot().enabled, false);
  assert.ok(f.order.indexOf('unsubscribe') < f.order.indexOf('device-unsubscribe')); f.controller.dispose();
});
test('existing page-only consent remains enabled and never silently creates a background subscription', async () => {
  const f = fixture({ persistent: true, online: true }); await settle(); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().enabled, true); assert.equal(f.controller.getSnapshot().delivery, 'page');
  assert.equal(f.subscribed(), false); assert.equal(f.order.includes('push-permission'), false); f.controller.dispose();
});
test('existing push-only consent appears as the same enabled feature and survives document retirement', async () => {
  const f = fixture({ persistent: true, enrolled: true }); await settle();
  assert.equal(f.preference(), false); assert.equal(f.controller.getSnapshot().enabled, true); assert.equal(f.controller.getSnapshot().delivery, 'background');
  f.controller.dispose(); assert.equal(f.subscribed(), true);
});
test('unavailable server retains the page notification path without claiming background delivery', async () => {
  const f = fixture({ persistent: true, available: false }); await settle(); await f.controller.setEnabled(true);
  assert.equal(f.controller.getSnapshot().delivery, 'page'); assert.equal(f.controller.getSnapshot().enabled, true);
  assert.equal(f.order.includes('push-permission'), false); f.controller.dispose();
});
test('failed enrollment remains off; turning off offline still revokes the device', async () => {
  const f = fixture({ persistent: true }); await settle(); f.fail(); await f.controller.setEnabled(true);
  assert.equal(f.controller.getSnapshot().enabled, false); assert.equal(f.controller.getSnapshot().error, 'connection'); f.controller.dispose();
  const g = fixture({ persistent: true, enrolled: true, online: true }); await settle(); g.fail(); await g.controller.setEnabled(false);
  assert.equal(g.subscribed(), false); assert.equal(g.controller.getSnapshot().enabled, false); g.controller.dispose();
});
test('save failures preserve truthful enabled state; denied permission never writes opt-in', async () => {
  const f = fixture(); f.failSave(); await f.controller.setEnabled(true);
  assert.equal(f.controller.getSnapshot().enabled, false); assert.equal(f.controller.getSnapshot().error, 'save'); f.controller.dispose();
  const g = fixture(); g.deny(); await g.controller.setEnabled(true); assert.equal(g.preference(), false); assert.equal(g.controller.getSnapshot().error, 'permission'); g.controller.dispose();
});
test('sign-out fences a pending enable and does not restore page consent from its late continuation', async () => {
  const f = fixture({ persistent: true }); await settle(); const pending = f.controller.setEnabled(true);
  await f.controller.beforeSignOut(); await pending;
  assert.equal(f.controller.getSnapshot().enabled, false); assert.equal(f.preference(), false); assert.equal(f.subscribed(), false); f.controller.dispose();
});
test('a preference change in another consumer disables both delivery paths', async () => {
  const f = fixture({ persistent: true, online: true, enrolled: true }); await settle();
  await f.preferences.set('chat.turnNotifications', false); await settle();
  assert.equal(f.subscribed(), false); assert.equal(f.controller.getSnapshot().enabled, false); f.controller.dispose();
});


test('a transient configuration failure does not duplicate a still-enrolled background notification', async () => {
  const f = fixture({ persistent: true, online: true, enrolled: true }); await settle();
  f.failRead(); await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().delivery, 'background'); assert.equal(f.controller.getSnapshot().error, 'connection');
  await f.controller.show(f.completion, 'Complete', 'Open', () => {});
  assert.equal(f.shown.length, 0); assert.equal(f.subscribed(), true); f.controller.dispose();
});


test('storage failure while disabling still revokes persistent delivery and pauses page alerts', async () => {
  const f = fixture({ persistent: true, online: true, enrolled: true }); await settle(); f.failSave();
  await f.controller.setEnabled(false); assert.equal(f.subscribed(), false); assert.equal(f.controller.getSnapshot().enabled, false);
  assert.equal(f.controller.getSnapshot().error, 'save');
  await f.controller.show(f.completion, 'Complete', 'Open', () => {}); assert.equal(f.shown.length, 0); f.controller.dispose();
});
