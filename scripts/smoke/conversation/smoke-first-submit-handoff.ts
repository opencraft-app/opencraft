import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import { chromium } from 'playwright';

const output = process.env.OPENCRAFT_HANDOFF_EVIDENCE ?? '.local/first-submit-handoff';
await mkdir(output, { recursive: true });
const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => host.once('listening', resolve));
let pending: (() => void) | null = null;
let createThread: (() => void) | null = null;
let rejectResume: (() => void) | null = null;
let created = 0, started = 0;
let durable = false;
let queued: any[] = [];
let dispatchQueued: (() => void) | null = null;
const thread = (id: string, turns: unknown[] = []) => ({ id, name: null, preview: '', cwd: '/fixture', path: '/fixture/history', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, turns });
const requests: string[] = [];
function receive(socket: WebSocket, raw: string) {
  const message = JSON.parse(raw);
  if (message.id === undefined) return;
  requests.push(message.method);
  const send = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
  if (message.method === 'initialize') send({ codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux', userAgent: 'handoff-fixture', capabilities: { extensions: durable ? { 'opencraft/thread-start-durability': { version: 1, durableAfter: 'first-turn-accepted' } } : {} } });
  else if (message.method === 'model/list') send({ data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null });
  else if (message.method === 'config/read') send({ config: { model: 'fixture', model_provider: 'fixture' }, origins: {} });
  else if (message.method === 'permissionProfile/list') send({ data: [{ id: 'workspace', description: 'Workspace', allowed: true }], nextCursor: null });
  else if (message.method === 'thread/start') { createThread = () => { created++; send({ thread: thread(`new-${created}`) }); }; }
  else if (message.method === 'thread/read') send({ thread: thread(message.params.threadId) });
  else if (message.method === 'thread/resume') {
    const id = message.params.threadId;
    rejectResume = () => socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Synthetic recovery rejection' } }));
    pending = () => send({ thread: thread(id), model: 'fixture', modelProvider: 'fixture', cwd: '/fixture', runtimeWorkspaceRoots: ['/fixture'], instructionSources: [], activePermissionProfile: { id: 'workspace' }, approvalsReviewer: 'user', serviceTier: 'default', reasoningEffort: null, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: ['/fixture'] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
  } else if (message.method === 'thread/queue/list') send({ data: queued, nextCursor: null });
  else if (message.method === 'thread/queue/add') {
    queued.push({ id: 'first-queue', clientUserMessageId: message.params.clientUserMessageId,
      input: message.params.input, createdAt: Date.now(), pausedReason: null });
    send({ queuedSubmission: queued.at(-1) });
    socket.send(JSON.stringify({ method: 'thread/queue/changed', params: { threadId: message.params.threadId } }));
    dispatchQueued = () => {
      const input = queued.shift();
      const turn = { id: 'first-turn', status: 'inProgress', items: [{ id: 'canonical-user', type: 'userMessage', clientId: input.clientUserMessageId, content: input.input }] };
      started++;
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: message.params.threadId, turn } }));
      socket.send(JSON.stringify({ method: 'item/started', params: { threadId: message.params.threadId, turnId: turn.id, item: turn.items[0] } }));
      socket.send(JSON.stringify({ method: 'thread/queue/changed', params: { threadId: message.params.threadId } }));
    };
  } else if (message.method === 'turn/start') {
    started++;
    const turn = { id: 'first-turn', status: 'inProgress', items: [{ id: 'canonical-user', type: 'userMessage', clientId: message.params.clientUserMessageId, content: message.params.input }] };
    send({ turn });
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: message.params.threadId, turn } }));
    socket.send(JSON.stringify({ method: 'item/started', params: { threadId: message.params.threadId, turnId: turn.id, item: turn.items[0] } }));
    // Durable creation starts its first Turn before the View Resume.
    if (durable) {
      const acceptedTurn = turn;
      const handler = (data: Buffer) => {
        const request = JSON.parse(String(data));
        if (request.method === 'thread/resume') pending = () => socket.send(JSON.stringify({ id: request.id, result: { thread: thread(request.params.threadId, [acceptedTurn]), model: 'fixture', modelProvider: 'fixture', cwd: '/fixture', runtimeWorkspaceRoots: ['/fixture'], instructionSources: [], activePermissionProfile: { id: 'workspace' }, approvalsReviewer: 'user', serviceTier: 'default', reasoningEffort: null, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: ['/fixture'] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null } }));
      };
      socket.on('message', handler);
    }
  } else if (message.method.endsWith('/list') || message.method === 'skills/list') send({ data: [], nextCursor: null });
  else if (message.method === 'thread/unsubscribe') send({ status: 'unsubscribed' });
  else send({});
}
host.on('connection', socket => socket.on('message', data => receive(socket, String(data))));
process.env.VITE_HYPERNODE_PLUGIN = 'disabled';
process.env.VITE_WEB_EXTENSIONS = 'join.server';
process.env.VITE_APPSERVER_HOSTS_JSON = JSON.stringify([{ hostId: 'handoff-fixture', label: 'Fixture', kind: 'local', url: `ws://127.0.0.1:${(host.address() as any).port}` }]);
const vite = await createServer({ configFile: 'apps/workbench-web/vite.config.ts', root: process.cwd() + '/apps/workbench-web', server: { host: '127.0.0.1', port: 0 }, cacheDir: process.cwd() + '/node_modules/.vite-handoff', logLevel: 'error' });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results: unknown[] = [];
try {
  await vite.listen();
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const atomic of [false, true]) {
    durable = atomic; pending = null; queued = []; dispatchQueued = null;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    await context.addInitScript(mode => { (window as any).__name = (value: unknown) => value; localStorage.setItem('opencraft.appearance-theme', mode); }, theme);
    const page = await context.newPage();
    page.on('console', message => { if (/failed|error/i.test(message.text())) console.log('CONSOLE', message.text()); });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
    const editor = page.locator('[contenteditable=true]').first();
    await editor.waitFor({ timeout: 60000 });
    await page.keyboard.press('Escape');
    const prompt = `Handoff ${width} ${theme} ${atomic ? 'atomic' : 'ordinary'}`;
    await editor.fill(prompt);
    await page.evaluate(() => {
      (window as any).duplicateFrames = [];
      const sample = () => {
        const message = document.querySelector('[data-user-message-bubble]');
        const queue = document.querySelector('.opencraft-composer-queue-item');
        if (message && queue) (window as any).duplicateFrames.push(performance.now());
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const beforeStarts = started, beforeCreates = created;
    const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
    if (width === 390) await sendButton.tap(); else await sendButton.click();
    await page.locator('[data-pending-conversation-phase]').waitFor();
    const followupEditor = page.locator('.opencraft-composer-editor');
    await followupEditor.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('.opencraft-composer-editor'));
    assert.equal(created, beforeCreates, 'editor is ready before Thread creation resolves');
    const followup = `Follow-up ${width} ${theme}`;
    await page.keyboard.type(followup);
    await followupEditor.evaluate(element => { (window as any).pendingEditor = element; });
    const selection = await page.evaluate(() => getSelection()?.anchorOffset);
    assert.equal(await sendButton.isDisabled(), true, 'pending input cannot create a second Thread');
    await page.screenshot({path: `${output}/${width}-${theme}-${atomic ? 'atomic' : 'ordinary'}-starting.png`});
    assert.ok(createThread); createThread!(); createThread = null;
    await page.waitForURL(/new-/).catch(async error => { console.log('REQUESTS', requests); console.log('BODY', await page.locator('body').innerText()); throw error; });
    await page.locator('[data-user-message-bubble]').filter({ hasText: prompt }).waitFor();
    // Hold canonical synchronization across multiple frames; keep content visible.
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.conversation-recovery-loading').count(), 0);
    assert.equal(await page.locator('.conversation-recovery-notice').count(), 0, 'first submission has no redundant syncing overlay');
    assert.equal(await page.locator('[data-user-message-bubble]').filter({ hasText: prompt }).count(), 1);
    assert.equal(created - beforeCreates, 1, 'typing never creates an additional Thread');
    await page.screenshot({ path: `${output}/${width}-${theme}-${atomic ? 'atomic' : 'ordinary'}-held.png` });
    if (!pending) { console.log('REQUESTS', requests); console.log('BODY', await page.locator('body').innerText()); }
    assert.ok(pending, 'Resume is held at the external Host boundary');
    if (width === 390 && theme === 'dark' && atomic) {
      rejectResume!(); pending = null;
      await page.locator('.conversation-recovery-notice[role=alert]').waitFor();
      assert.equal(await page.locator('[data-user-message-bubble]').filter({ hasText: prompt }).count(), 1);
      await page.getByRole('button', { name: 'Try again', exact: true }).tap();
      for (let i = 0; i < 100 && pending === null; i++) await page.waitForTimeout(20);
      assert.ok(pending, 'retry restores the same created Thread');
      assert.equal(await page.locator('.conversation-recovery-loading').count(), 0);
      // Retry is an explicit focus move; resume editing before testing continuity.
      await followupEditor.focus();
    }
    assert.equal(await page.locator('.opencraft-composer-queue-item').count(), 0, 'initial outbox handoff is not a second copy of the bubble');
    pending!(); pending = null;
    if (!atomic) {
      for (let i = 0; i < 150 && !dispatchQueued; i++) await page.waitForTimeout(20);
      assert.ok(dispatchQueued, 'first input reaches the real execution queue adapter');
      await page.waitForTimeout(500);
      assert.equal(queued.length, 1, 'queue admission is retained while execution is held');
      assert.equal(await page.locator('[data-user-message-bubble]').filter({ hasText: prompt }).count(), 1);
      await page.screenshot({ path: `${output}/${width}-${theme}-queued-first.png` });
      dispatchQueued!(); dispatchQueued = null;
    }
    if (!atomic) {
      for (let i = 0; i < 150 && !dispatchQueued; i++) await page.waitForTimeout(20);
      assert.ok(dispatchQueued, 'first input reaches the real execution queue adapter');
      await page.waitForTimeout(500);
      assert.equal(queued.length, 1, 'queue admission is retained while execution is held');
      assert.equal(await page.locator('.opencraft-composer-queue-item').count(), 0, 'accepted first queue row must not duplicate the visible handoff');
      assert.equal(await page.locator('[data-user-message-bubble]').filter({ hasText: prompt }).count(), 1);
      await page.screenshot({ path: `${output}/${width}-${theme}-queued-first.png` });
      dispatchQueued!(); dispatchQueued = null;
    }
    await page.waitForFunction(() => !document.querySelector('.conversation-recovery-loading'));
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('[data-user-message-bubble]').filter({ hasText: prompt }).count(), 1, 'canonical user replaces rather than duplicates submitted input');
    assert.equal(await followupEditor.innerText(), followup, 'promotion retains the follow-up draft');
    assert.equal(await followupEditor.evaluate(element => element === (window as any).pendingEditor), true, 'promotion keeps the same physical editor');
    assert.equal(await followupEditor.evaluate(element => document.activeElement === element), true, 'promotion retains focus');
    assert.equal(await page.evaluate(() => getSelection()?.anchorOffset), selection, 'promotion retains caret');
    assert.equal(created - beforeCreates, 1);
    if (started - beforeStarts !== 1) { console.log('REQUESTS', requests); console.log('BODY', await page.locator('body').innerText()); }
    assert.equal(started - beforeStarts, 1, 'first Turn submitted exactly once');
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => (window as any).duplicateFrames), [], 'no rendered frame may contain both copies of the first input');
    results.push({ width, theme, atomic, heldResume: true, visibleInput: true, duplicateUsers: 0, starts: 1, pageerrors: 0 });
    if (width === 1280 && theme === 'dark' && atomic) {
      const oldUrl = page.url().replace(/new-\d+/, 'old-cold');
      const old = await browser.newContext({ viewport: { width, height: 900 } });
      const oldPage = await old.newPage();
      await oldPage.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
      await oldPage.goto(oldUrl);
      await oldPage.locator('.conversation-recovery-loading').waitFor({ timeout: 30000 });
      assert.equal(await oldPage.locator('[data-user-message-bubble]').count(), 0);
      results.push({ oldColdThread: true, historySpinnerRetained: true });
      await old.close();
    }
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); await vite.close(); for (const socket of host.clients) socket.terminate(); await new Promise<void>(resolve => host.close(() => resolve())); }
