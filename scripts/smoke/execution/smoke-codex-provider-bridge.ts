import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppHostServer } from '@opencraft/app-host-server';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { createWorkbenchWebServer } from '../../serve-workbench-web.mjs';
import { assertHeadlessWebRelease } from '../../headless-web-release.mjs';
import { createCodexPreview } from '../../../tests/agent-bridge/fixtures/codex-preview.js';

const webRoot = process.env.OPENCRAFT_BRIDGE_WEB_ROOT ?? resolve('apps/workbench-web/dist');
const output = process.env.OPENCRAFT_BRIDGE_WEB_EVIDENCE ?? '/tmp/opencraft-p2a-web';
await assertHeadlessWebRelease(webRoot);
await mkdir(output, { recursive: true });
const fixture = await createCodexPreview();
let proxy = fixture.createTransport();
await proxy.connect();
const seedFrames: any[] = [];
proxy.subscribeMessage(raw => seedFrames.push(JSON.parse(raw)));
let sequence = 0;
const seed = async (method: string, params: unknown) => {
  const id = `seed:${++sequence}`;
  await proxy.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'seed' }));
  const result = seedFrames.find(f => f.id === id);
  assert.equal(result?.error, undefined); assert(result); return result.result;
};
await seed('initialize', { capabilities: { extensions: { 'opencraft/steer-evidence': { version: 1 } } } });
await seed('thread/start', { cwd: '/remote', agentBridge: { threadId: 'preview', clientRequestId: 'create' } });
await seed('turn/start', { threadId: fixture.publicId, clientUserMessageId: 'start', input: [{ type: 'text', text: 'Run the fixture tool', text_elements: [] }] });
let appHost: AppHostServer;
let web: Awaited<ReturnType<typeof createWorkbenchWebServer>> | undefined;
let browser: any, page: any;
const start = async (port = 0) => {
  appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: 'server', createTransport(hostId) { return hostId.startsWith('ssh:') ? proxy : emptyTransport(); } });
  web = await createWorkbenchWebServer({ root: webRoot, loopbackOnly: true, appServerTarget: null, appHostServer: appHost,
    sshServerDescriptors: [{ serverId: 'ssh:fixture', displayName: 'Bridge UI fixture', workspaceBrowseRoots: ['/remote'] }], onAppHostDiagnostic: () => {} });
  const address = await web.listen({ host: '127.0.0.1', port }); return address.port;
};
const emptyTransport = () => {
  let listener: (raw: string) => void = () => {};
  return { status: { state: 'open' as const }, async connect() {}, async close() {}, subscribeStatus() { return () => {}; },
    subscribeMessage(callback: (raw: string) => void) { listener = callback; return () => {}; },
    async send(raw: string) { const f = JSON.parse(raw); if (f.id === undefined) return;
      const result = f.method === 'initialize' ? { capabilities: {} } : ['thread/list','model/list','threadSection/list','thread/loaded/list'].includes(f.method) ? { data: [], nextCursor: null } : undefined;
      listener(JSON.stringify({ id: f.id, [LOGICAL_CLIENT_FIELD]: f[LOGICAL_CLIENT_FIELD], ...(result ? { result } : { error: { code: -32601, message: 'Empty fixture Host' } }) }));
    },
  };
};
const errors: string[] = [];
try {
  let port = await start();
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const onboard = page.locator('.agent-onboard-gate');
  await onboard.getByRole('button', { name: 'Use an API model instead', exact: true }).click();
  await page.getByRole('button', { name: 'Work in', exact: true }).click();
  await page.locator('.new-thread-host-menu').getByRole('menuitem').filter({ hasText: 'Bridge UI fixture' }).click();
  await page.getByText('Legacy preview', { exact: true }).first().click();
  await page.getByText('Old bridge fixture answer', { exact: true }).waitFor();
  assert.equal(await page.getByText('Old fixture question', { exact: true }).count(), 1);
  assert.equal(await page.locator('.sidebar-panel').getByText('Codex bridge preview', { exact: true }).count(), 1);
  assert.equal(await page.locator('.sidebar-panel').getByText('Legacy preview', { exact: true }).count(), 1);
  await page.getByText('Codex bridge preview', { exact: true }).first().click();
  await page.getByText('Run the fixture tool', { exact: true }).waitFor();
  const editor = page.locator('.opencraft-composer-editor');
  await editor.fill('Keep the fixture task short');
  await page.getByRole('button', { name: 'Steer active response', exact: true }).click();
  await page.getByText('Accepted; context not yet confirmed', { exact: true }).waitFor();
  assert.equal(fixture.counts().steers, 1);
  await page.screenshot({ path: output + '/admission.png', fullPage: true });
  fixture.confirm();
  await page.getByText('Input confirmed in task context', { exact: true }).waitFor();
  assert.equal(await page.getByText('Keep the fixture task short', { exact: true }).count(), 1);
  await editor.fill('Draft survives gateway restart'); await editor.focus();
  const focused = await editor.evaluate((element: HTMLElement) => element.contains(document.activeElement)); assert(focused);
  await web!.close(); await appHost!.close();
  proxy = fixture.createTransport(); port = await start(port);
  await page.getByText('Input confirmed in task context', { exact: true }).waitFor({ timeout: 45000 });
  await page.waitForFunction(() => document.querySelector('.opencraft-composer-editor')?.textContent?.includes('Draft survives gateway restart'));
  assert.equal(await editor.evaluate((element: HTMLElement) => element.contains(document.activeElement)), true);
  fixture.finish();
  await page.getByText('P2a bridge fixture completed', { exact: true }).waitFor();
  assert.equal(await page.getByText('P2a bridge fixture completed', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Keep the fixture task short', { exact: true }).count(), 1);
  assert.equal(await page.locator('.sidebar-panel').getByText('Codex bridge preview', { exact: true }).count(), 1);
  await page.screenshot({ path: output + '/reconnected.png', fullPage: true });
  const conversationUrl = page.url();
  await editor.focus();
  await page.keyboard.press('Control+,');
  await page.locator('.settings-page__navigation').getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.selectOption('#workbench-language', 'zh-CN');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  for (let i = 0; i < 3 && page.url() !== conversationUrl; i++) await page.goBack();
  await page.getByText('已确认输入进入任务上下文', { exact: true }).waitFor();
  assert.match(await editor.innerText(), /Draft survives gateway restart/);
  await page.locator('.settings-page__navigation').waitFor({ state: 'hidden' });
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: output + '/localized.png', fullPage: true });
  assert.deepEqual(fixture.counts(), { starts: 1, steers: 1 });
  assert.deepEqual(errors, []);
  await writeFile(output + '/result.json', JSON.stringify({ result: 'passed', nativeBoundary: 'synthetic Unix WebSocket AppServer; no external model', ui: 'built Workbench', scenarios: ['legacy history', 'bridge history', 'admission before native evidence', 'single native input after evidence', 'gateway attachment restart', 'draft and focus continuity', 'no duplicate tool/steer/answer', 'localized evidence and retained draft'], counts: fixture.counts() }, null, 2));
  console.log('PASS: built Workbench, legacy/bridge history, separate admission/evidence and gateway reconnect continuity');
} catch (error) {
  if (page) { await page.screenshot({ path: output + '/failure.png', fullPage: true }).catch(() => {}); await writeFile(output + '/failure.txt', (error as Error).stack + '\n' + await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally { await browser?.close(); await web?.close(); await appHost!?.close(); await proxy.close(); await fixture.close(); }
