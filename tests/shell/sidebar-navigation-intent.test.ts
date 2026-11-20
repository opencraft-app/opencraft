import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchThreadLocation } from '../../packages/workbench-runtime/src/index';
import { createWorkbenchNavigationTransaction } from '../../apps/workbench-web/src/runtime/workbench-navigation-transaction';

const a = createWorkbenchThreadLocation('local', 'a');
const b = createWorkbenchThreadLocation('local', 'b');
const c = createWorkbenchThreadLocation('local', 'c');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('a synchronous newer selection during intent publication supersedes the outer selection', async () => {
  const restored: string[] = [];
  const nav = createWorkbenchNavigationTransaction(a, {
    setViewId() {}, cancelPending() {}, mountRestored() {}, prepare: () => new Promise(() => {}),
  } as any, { getActiveDraft: () => null } as any, { mode: 'memory',
    restoreViewId: async location => { if (location.kind === 'thread') restored.push(location.key.threadId); return 'view' as any; },
  });
  try {
    let latest!: Promise<boolean>;
    nav.subscribePendingLocation(() => { if (nav.getPendingLocation() === b) latest = nav.selectConversation(c); });
    assert.equal(await nav.selectConversation(b), false);
    assert.equal(await latest, true);
    assert.deepEqual(restored, ['c']);
    assert.deepEqual(nav.getSnapshot().location, c);
  } finally { nav.dispose(); }
});

test('a confirmed retained View returns locally while physical readiness stays pending', async () => {
  let hold = false, mounted: unknown;
  const nav = createWorkbenchNavigationTransaction(a, {
    setViewId() {}, cancelPending() {}, mountRestored(location: unknown) { mounted = location; },
    prepare: () => hold ? new Promise(() => {}) : Promise.resolve({ commit: () => true, cancel() {} }),
  } as any, { getActiveDraft: () => null } as any, { mode: 'memory', isRetainedView: () => true });
  try {
    await nav.selectConversation(b);
    hold = true;
    const returning = nav.selectConversation(a);
    assert.deepEqual(nav.getSnapshot().location, a, 'local selection commits synchronously');
    assert.equal(mounted, a);
    assert.equal(await returning, true);
    assert.equal(nav.getPendingLocation(), null);
  } finally { nav.dispose(); }
});

test('sidebar intent is observable before local restoration and never commits a speculative route', async () => {
  let restore!: (id: any) => void;
  const nav = createWorkbenchNavigationTransaction(a, {
    setViewId() {}, cancelPending() {}, mountRestored() {},
    prepare: () => new Promise(() => {}),
  } as any, { getActiveDraft: () => null } as any, {
    mode: 'memory', restoreViewId: () => new Promise(resolve => { restore = resolve; }),
  });
  try {
    const pending: unknown[] = [];
    nav.subscribePendingLocation(() => pending.push(nav.getPendingLocation()));
    const selection = nav.selectConversation(b);
    assert.equal(nav.getPendingLocation(), b);
    assert.deepEqual(nav.getSnapshot().location, a);
    assert.deepEqual(pending, [b]);
    await tick(); restore('restored-b');
    assert.equal(await selection, true, 'local presentation does not await connection readiness');
    assert.deepEqual(nav.getSnapshot().location, b);
    assert.equal(nav.getPendingLocation(), null);
    assert.deepEqual(pending, [b, null]);
  } finally { nav.dispose(); }
});

test('late restoration failure cannot clear a newer sidebar intent', async () => {
  const failures: Array<(error: Error) => void> = [];
  const nav = createWorkbenchNavigationTransaction(a, { setViewId() {}, cancelPending() {} } as any,
    { getActiveDraft: () => null } as any, { mode: 'memory',
      restoreViewId: () => new Promise((_resolve, reject) => failures.push(reject)),
    });
  try {
    const old = nav.selectConversation(b); await tick();
    const current = nav.selectConversation(c); await tick();
    failures[0]!(Error('old failure'));
    assert.equal(await old, false);
    assert.equal(nav.getPendingLocation(), c);
    failures[1]!(Error('current failure'));
    await assert.rejects(current, /current failure/);
    assert.equal(nav.getPendingLocation(), null);
    assert.deepEqual(nav.getSnapshot().location, a);
  } finally { nav.dispose(); }
});

test('leaving for Settings immediately revokes selection feedback and late restore', async () => {
  let restore!: (id: any) => void;
  const nav = createWorkbenchNavigationTransaction(a, {
    setViewId() {}, cancelPending() {}, mountRestored() { assert.fail('obsolete local presentation'); },
  } as any, { getActiveDraft: () => null } as any, { mode: 'memory',
    restoreViewId: () => new Promise(resolve => { restore = resolve; }),
  });
  try {
    const selection = nav.selectConversation(b); await tick();
    nav.openSettings();
    assert.equal(nav.getPendingLocation(), null);
    restore('old-b'); assert.equal(await selection, false);
    assert.equal(nav.getSnapshot().applicationRoute.kind, 'settings');
  } finally { nav.dispose(); }
});
