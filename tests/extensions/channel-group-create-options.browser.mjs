// Real-browser check of installation group creation options in the create-group
// dialog: default state, localized label/description, toggling, submission and
// presentation across touch/desktop and light/dark. Evidence goes to .local/.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const output = process.env.OPENCRAFT_GROUP_OPTIONS_OUTPUT ?? root + '/.local/channel-group-create-options/';
fs.mkdirSync(output, { recursive: true });
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { chromium } = await import(pathToFileURL(root + '/node_modules/playwright/index.mjs'));

const source = `
import React from 'react';
import { CreateGroupButton } from '/plugins/im/src/channel-group-controls.tsx';
import { createIntlTestRoot } from '/tests/fixtures/intl-root.tsx';
import { initializeAppearanceTheme, setThemePreference } from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '/plugins/im/src/channel-chat.scss';
const params = new URLSearchParams(location.search);
initializeAppearanceTheme(); setThemePreference(params.get('theme') || 'light');
const calls = []; window.calls = calls;
const client = {
  async inviteCandidates() { return { candidates: [{ actorId: 'human://fixture/ada', displayName: 'Ada', actorKind: 'human' }] }; },
  async createGroup(title, ids, key, signal, options) { calls.push({ title, ids, options }); return { id: 'g1', title, kind: 'group' }; },
};
const options = [{ id: 'linked-group', label: { id: 'fixture.channels.group.linked', defaultMessage: 'Also create a linked group' },
  description: { id: 'fixture.channels.group.linkedHint', defaultMessage: 'Messages, name and members stay in sync.' }, defaultSelected: true }];
createIntlTestRoot(document.getElementById('root'), undefined, 'en-US').render(
  <div style={{ padding: 24 }}><CreateGroupButton client={client} options={options} reportError={() => {}} onCreated={group => { window.created = group; }} /></div>);
`;

const server = await createServer({
  root, configFile: false, cacheDir: output + 'vite', publicDir: root + '/apps/workbench-web/public', logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom', 'react-intl'] }, esbuild: { jsx: 'automatic', target: 'esnext' },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{
    name: 'group-options-probe',
    resolveId: id => id === '/group-options-probe.tsx' ? id : null,
    load: id => id === '/group-options-probe.tsx' ? source : null,
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (/^\/(@|node_modules|apps|packages|plugins|tests|group-options-probe)/.test(req.url ?? '')) return next();
        if (req.headers.accept?.includes('text/html')) {
          res.setHeader('content-type', 'text/html');
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/group-options-probe.tsx"></script>');
        } else next();
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {});
  const url = 'http://127.0.0.1:' + server.httpServer.address().port + '/';
  for (const touch of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url + '?theme=' + theme);
    await page.getByRole('button', { name: 'New group chat', exact: true }).click();
    const option = page.getByRole('checkbox', { name: /Also create a linked group/ });
    await option.waitFor();
    assert.equal(await option.isChecked(), true, 'declared default is the initial state');
    assert.equal(await page.getByText('Messages, name and members stay in sync.', { exact: true }).count(), 1);
    // The option row keeps readable secondary text in both themes.
    const contrast = await page.locator('.im-channel-group-dialog__option small').evaluate(node => {
      const style = getComputedStyle(node); return { color: style.color, visible: node.getBoundingClientRect().height > 0 };
    });
    assert.equal(contrast.visible, true);
    await page.screenshot({ path: output + (touch ? 'touch' : 'desktop') + '-' + theme + '.png' });
    await page.getByRole('checkbox', { name: /Ada/ }).check();
    await option.uncheck();
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await page.waitForFunction(() => window.created);
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(calls, [{ title: 'Ada', ids: ['human://fixture/ada'], options: { 'linked-group': false } }]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ touch, theme, defaultChecked: true, description: true, submittedExplicitFalse: true }));
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
