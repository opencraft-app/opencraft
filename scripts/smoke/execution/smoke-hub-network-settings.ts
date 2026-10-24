import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { HubNetwork } from "../../../packages/hub-network/src/node";
import { createHubController } from "../../../packages/hub-network/src/controller";

const output = resolve(process.env.OPENCRAFT_HUB_SMOKE_DIRECTORY ?? '.local/hub-network-settings'); await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'private-')), cleanups: (() => unknown)[] = [];
let operator: string | null = '["fixture","administrator"]', failReads = false;
try {
  const controller = await createHubController(join(directory, 'controller.json'), join(directory, 'node.json')); cleanups.push(() => controller.close());
  const pair = generateKeyPairSync('ed25519'), other = new HubNetwork(join(directory, 'other.json'), { authority: { issuer: 'fixture-login', publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), providers: ['enterprise-identity'] } }); cleanups.push(() => other.close());
  const peer = createHttpServer((_req, res) => { res.writeHead(404); res.end(); }); peer.on('upgrade', (req, socket, head) => { if (!other.handleUpgrade(req, socket, head)) socket.destroy(); });
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening'); const peerPort = (peer.address() as { port: number }).port; other.start(peerPort);
  cleanups.unshift(() => new Promise<void>(r => { peer.close(() => r()); peer.closeAllConnections(); }));
  other.command({ revision: other.store.state.revision, action: 'configure', name: 'Department fixture', endpoint: `http://127.0.0.1:${peerPort}`, origin: '', accepting: true, forwarding: true }, 'fixture');
  const source = `import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '/apps/workbench-web/src/styles/settings-page.scss';
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory'});
application.supervisor.navigation.openSettings('appearance');
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,route:()=>application.supervisor.navigation.getSnapshot().applicationRoute};`;
  const vite = await createServer({ configFile: false, cacheDir: ".local/hub-settings/vite-cache", root: process.cwd(), logLevel: 'error', define: { 'process.env.NEXT_PUBLIC_REGION': '"cn"', 'process.env.NEXT_PUBLIC_PREVIEW_LOCALES': '""', 'import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN': '"false"', 'import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST': '"true"' }, esbuild: { jsx: 'automatic' }, resolve: { dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'hub-network-ui-proof', resolveId: id => id === '/proof.tsx' ? id : null,
      load: id => id === '/proof.tsx' ? source : null, configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/proof.tsx"></script></body></html>'); }
        else if (req.url === '/__opencraft_hub/settings') { if (failReads && req.method === 'GET') { res.writeHead(503); res.end('{}'); } else void controller.handle(req, res, () => operator); }
        else next();
      }); } }] });
  await vite.listen(); cleanups.unshift(() => vite.close()); const port = (vite.httpServer!.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  controller.node!.start(port);
  const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--no-proxy-server'] }); cleanups.push(() => browser.close());
  const cases = [];
  for (const width of (process.env.OPENCRAFT_HUB_SMOKE_NARROW_ONLY ? [390] : [1280, 390])) for (const theme of (process.env.OPENCRAFT_HUB_SMOKE_NARROW_ONLY ? ['dark'] : ['light', 'dark'])) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript('window.__name = target => target;'); await page.goto(origin); if (width === 390) await page.getByRole('button', { name: '显示侧边栏', exact: true }).first().click(); await page.getByRole('navigation', { name: 'Settings sections', exact: true }).getByRole('button', { name: 'Hub 网络', exact: true }).click(); if (width === 390 && await page.getByRole('button', { name: 'Close sidebar', exact: true }).count()) await page.getByRole('button', { name: 'Close sidebar', exact: true }).click(); await page.getByRole('textbox', { name: '节点名称', exact: true }).waitFor();
    await page.evaluate(theme => (window as any).proof.theme(theme), theme); await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    await page.getByRole('textbox', { name: '节点名称', exact: true }).fill('Department Hub');
    await page.getByRole('textbox', { name: '接入地址', exact: true }).fill(origin);
    const toggle = page.getByRole('switch', { name: '允许其他 Hub 接入', exact: true }); if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
    await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.waitForFunction(async () => (await (await fetch('/__opencraft_hub/settings')).json()).accepting === true);
    await page.getByRole('textbox', { name: '允许发布的访问地址', exact: true }).fill('http://team-c.test');
    await page.getByRole('button', { name: '生成邀请', exact: true }).click(); await page.getByRole('textbox', { name: '生成的邀请', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭邀请', exact: true }).click();
    const generated = other.command({ revision: other.store.state.revision, action: 'invite', origins: ['http://team-c.test'], allowTransit: true }, 'fixture') as { invitation: string };
    await page.getByRole('textbox', { name: '接入邀请', exact: true }).fill(generated.invitation); await page.getByRole('button', { name: '检查邀请', exact: true }).click();
    const connect = page.getByRole('button', { name: '连接 Hub', exact: true }); await connect.waitFor(); assert.equal(await connect.isDisabled(), true);
    await page.getByRole('switch', { name: '信任邀请中的登录来源', exact: true }).click(); await connect.click();
    await page.getByRole('textbox', { name: '接入邀请', exact: true }).waitFor(); await page.waitForFunction(async () => (await (await fetch('/__opencraft_hub/settings')).json()).peers.some((p: any) => p.connected));
    await page.waitForTimeout(3200); assert.equal(await page.getByRole('textbox', { name: '接入邀请', exact: true }).inputValue(), '');
    assert.ok(await page.getByText('已连接', { exact: false }).count());
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })); assert.ok(geometry.scrollWidth <= geometry.width + 1, JSON.stringify(geometry));
    await page.locator('.settings-page__viewport').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: join(output, `${width}-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: '断开并移除', exact: true }).click(); await page.waitForFunction(async () => (await (await fetch('/__opencraft_hub/settings')).json()).peers.length === 0);
    assert.deepEqual(errors, []); cases.push({ width, theme, connected: true, invitationHidden: true, geometry, errors }); await context.close();
  }
  const page = await browser.newPage(); await page.addInitScript('window.__name = target => target;'); await page.goto(origin); await page.getByRole('navigation', { name: 'Settings sections', exact: true }).getByRole('button', { name: 'Hub 网络', exact: true }).click(); await page.getByRole('textbox', { name: '节点名称', exact: true }).waitFor();
  failReads = true; await page.getByRole('alert').waitFor({ timeout: 10_000 }); assert.equal(await page.getByRole('textbox', { name: '节点名称', exact: true }).inputValue(), 'Department Hub');
  failReads = false; await page.getByRole('alert').waitFor({ state: 'hidden', timeout: 10_000 }); operator = null;
  await page.getByText('需要当前服务器的管理员权限才能管理 Hub 网络。', { exact: true }).waitFor({ timeout: 10_000 }); assert.equal(await page.getByRole('textbox', { name: '节点名称', exact: true }).count(), 0);
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ cases, cachedErrorRetained: true, revokedAdministratorClearsView: true,
    boundary: 'Real Workbench bootstrap and settings navigation, private state, invitation verification and peer transport. Administrator identity is an isolated fixture; no production employee sessions.' }, null, 2));
  console.log(JSON.stringify({ cases: cases.length, cachedErrorRetained: true, revokedAdministratorClearsView: true, output }));
} finally { for (const close of cleanups.reverse()) await close(); await rm(directory, { recursive: true, force: true }); }
