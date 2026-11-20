// Real App and Composer; synthetic Host creation/acceptance held across painted frames.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { transform } from 'esbuild';
import { WebSocketServer, type WebSocket } from 'ws';
import { chromium } from 'playwright';

const output = process.env.OPENCRAFT_HANDOFF_EVIDENCE ?? '.local/first-message-placement';
await mkdir(output, { recursive: true });
const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => host.once('listening', resolve));
let pending: (() => void) | null = null;
let createThread: (() => void) | null = null;
let created = 0, started = 0;
let durable = false;
const acceptedTurns = new Map<string, any>();
const turnSockets = new Map<string, WebSocket>();
const thread = (id: string, turns: unknown[] = []) => ({ id, name: null, preview: '', cwd: '/fixture', path: '/fixture/history', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, turns });
const requests: string[] = [];
function receive(socket: WebSocket, raw: string) {
  const message = JSON.parse(raw);
  if (message.id === undefined) return;
  requests.push(message.method);
  const send = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
  if (message.method === 'initialize') send({ codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux', userAgent: 'handoff-fixture', capabilities: { extensions: durable ? { 'opencraft/thread-start-durability': { version: 1, durableAfter: 'first-turn-accepted' } } : {} } });
  else if (message.method === 'model/list') send({ data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [], defaultReasoningEffort: null }], nextCursor: null });
  else if (message.method === 'opencraft/agents/usage') send({ providers: [], conversation: null });
  else if (message.method === 'config/read') send({ config: { model: 'fixture', model_provider: 'fixture' }, origins: {} });
  else if (message.method === 'permissionProfile/list') send({ data: [{ id: 'workspace', description: 'Workspace', allowed: true }], nextCursor: null });
  else if (message.method === 'thread/start') { createThread = () => { created++; send({ thread: thread(`new-${created}`) }); }; }
  else if (message.method === 'thread/read') send({ thread: thread(message.params.threadId, acceptedTurns.has(message.params.threadId) ? [acceptedTurns.get(message.params.threadId)] : []) });
  else if (message.method === 'thread/turns/list') send({ data: acceptedTurns.has(message.params.threadId) ? [acceptedTurns.get(message.params.threadId)] : [], nextCursor: null });
  else if (message.method === 'thread/resume') {
    const id = message.params.threadId;
    pending = () => send({ thread: thread(id), model: 'fixture', modelProvider: 'fixture', cwd: '/fixture', runtimeWorkspaceRoots: ['/fixture'], instructionSources: [], activePermissionProfile: { id: 'workspace' }, approvalsReviewer: 'user', serviceTier: 'default', reasoningEffort: null, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: ['/fixture'] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
  } else if (message.method === 'turn/start') {
    started++;
    const turn = { id: 'first-turn', status: 'inProgress', items: [{ id: 'canonical-user', type: 'userMessage', clientId: message.params.clientUserMessageId, content: message.params.input }] };
    acceptedTurns.set(message.params.threadId, turn);
    turnSockets.set(message.params.threadId, socket);
    send({ turn });
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: message.params.threadId, turn } }));
    socket.send(JSON.stringify({ method: 'item/started', params: { threadId: message.params.threadId, turnId: turn.id, item: turn.items[0] } }));
  } else if (message.method.endsWith('/list') || message.method === 'skills/list') send({ data: [], nextCursor: null });
  else if (message.method === 'thread/unsubscribe') send({ status: 'unsubscribed' });
  else send({});
}
host.on('connection', socket => socket.on('message', data => receive(socket, String(data))));
process.env.VITE_HYPERNODE_PLUGIN = 'disabled';
process.env.VITE_WEB_EXTENSIONS = 'join.server';
process.env.VITE_APPSERVER_HOSTS_JSON = JSON.stringify([{ hostId: 'handoff-fixture', label: 'Fixture', kind: 'local', url: `ws://127.0.0.1:${(host.address() as any).port}` }]);
const vite = await createServer({ plugins: [{ name: 'fixture-local-cjs', async transform(code, id) { if (id.split('?')[0].endsWith('/packages/browser-core/src/presentation.cjs')) { const result = await transform(code.replace('module.exports = {', 'export {'), { loader: 'js', format: 'esm' }); return result.code; } } }], configFile: 'apps/workbench-web/vite.config.ts', root: process.cwd() + '/apps/workbench-web', server: { host: '127.0.0.1', port: 0 }, cacheDir: process.cwd() + '/node_modules/.vite-handoff', logLevel: 'error' });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results: unknown[] = [];
try {
  await vite.listen();
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const atomic of [false, true]) {
    durable = atomic; pending = null;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    await context.addInitScript(mode => { (window as any).__name = (value: unknown) => value; localStorage.setItem('opencraft.appearance-theme', mode); localStorage.setItem('opencraft.onboarding.completedAt', 'fixture'); }, theme);
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
      (window as any).placementFrames = [];
      const sample = () => {
        const message = document.querySelector('[data-user-message-bubble]');
        const content = message?.closest('.thread-content');
        const footer = document.querySelector('[data-thread-scroll-footer="true"]');
        if (message && content && footer) (window as any).placementFrames.push({
          top: message.getBoundingClientRect().top,
          bottom: message.getBoundingClientRect().bottom,
          footerTop: footer.getBoundingClientRect().top,
          pending: !!document.querySelector('[data-pending-conversation-phase]'),
          tail: content.hasAttribute('data-thread-follow-tail-layout'),
        });
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
    if (!atomic) assert.ok(pending, 'Resume is held at the external Host boundary');
    assert.equal(await page.locator('.opencraft-composer-queue-item').count(), 0, 'initial outbox handoff is not a second copy of the bubble');
    if (pending) { pending(); pending = null; }
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
    const frames = await page.evaluate(() => (window as any).placementFrames);
    await writeFile(`${output}/${width}-${theme}-${atomic}-frames.json`, JSON.stringify(frames));
    assert.ok(frames.length > 0);
    assert.ok(frames.every((frame: any) => frame.footerTop - frame.bottom >= 0 && frame.footerTop - frame.bottom <= 120), 'first message stays above the Composer throughout creation and canonical handoff');
    // A stable answer string must not move when completion reveals its controls.
    const threadId = `new-${created}`, turn = acceptedTurns.get(threadId);
    const socket = turnSockets.get(threadId)!;
    const answer = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '回复内容保持不变。 Stable answer.' };
    turn.items.push(answer);
    socket.send(JSON.stringify({ method: 'item/started', params: { threadId, turnId: turn.id, item: answer } }));
    const answerText = page.locator('.thread-frame--assistant .opencraft-chat-document').filter({ hasText: answer.text }).last();
    await answerText.waitFor();
    await page.waitForTimeout(200);
    const completionGeometry = () => page.evaluate(() => [...document.querySelectorAll('.thread-turn, .thread-frame, .thread-frame > *, .thread-scroll-footer, .thread-user-message__actions')].map(element => ({
      className: element.className, top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height, text: element.textContent?.slice(0,80),
    })));
    const beforeGeometry = await completionGeometry();
    const beforeCompletion = await answerText.boundingBox();
    const lane = page.locator('.thread-frame--assistant > .thread-message-actions').last();
    assert.equal(await lane.locator('button,time').count(), 0, 'running Turn has no completed actions');
    await answerText.evaluate(element => {
      (window as any).completionTops = [];
      (window as any).sampleCompletion = true;
      const sample = () => {
        if (!(window as any).sampleCompletion) return;
        (window as any).completionTops.push(element.getBoundingClientRect().top);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    turn.status = 'completed';
    socket.send(JSON.stringify({ method: 'item/completed', params: { threadId, turnId: turn.id, item: answer } }));
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn } }));
    await lane.locator('button').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(100);
    const afterCompletion = await answerText.boundingBox();
    const completionTops = await page.evaluate(() => { (window as any).sampleCompletion = false; return (window as any).completionTops as number[]; });
    await writeFile(`${output}/${width}-${theme}-${atomic}-completion.json`, JSON.stringify({ before: beforeGeometry, after: await completionGeometry(), completionTops }, null, 2));
    assert.ok(completionTops.length > 0 && completionTops.every(top => Math.abs(top - beforeCompletion!.y) < 1), 'completion is stable in every painted frame');
    if (width === 390 && theme === 'light' && !atomic) await page.screenshot({ path: `${output}/completion.png` });
    assert.ok(beforeCompletion && afterCompletion && Math.abs(beforeCompletion.y - afterCompletion.y) < 1,
      `completion must reuse its action slot: ${JSON.stringify({beforeCompletion, afterCompletion})}`);
    results.push({ width, theme, atomic, completionStable: true, heldResume: !atomic, visibleInput: true, duplicateUsers: 0, starts: 1, pageerrors: 0 });
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); await vite.close(); for (const socket of host.clients) socket.terminate(); await new Promise<void>(resolve => host.close(() => resolve())); }
