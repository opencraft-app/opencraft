import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.resolve(appRoot, '../../../frontend');
const requireFrontend = createRequire(path.join(frontendRoot, 'package.json'));
const { JSDOM } = requireFrontend('jsdom');
const html = await fs.readFile(path.join(appRoot, 'assets/mobile-bot-runtime.html'), 'utf8');
const css = html.split('<style>')[1]?.split('</style>')[0] ?? '';
if (!css.includes('text-red-600') || !css.includes('bg-white') || !css.includes('space-y-5')) {
  throw new Error('The embedded Bot CSS is missing frontend utility classes');
}
if (!html.includes('<html class="lv-mobile-bot-runtime">') || !css.includes('overflow-x:hidden')) {
  throw new Error('The embedded Bot viewport boundary is missing');
}
if (!css.includes('-webkit-user-select:none') || !css.includes('contenteditable')) {
  throw new Error('The embedded Bot text-selection policy is missing');
}
const script = html.split('<script type="module">')[1]?.split('</script>')[0];
if (!script) throw new Error('The embedded Bot module is missing');
const localBotScenario = process.env.OPENCRAFT_SMOKE_BOT === '1';
const evaluatedScript = localBotScenario
  ? script.replace("NODE_ENV: 'production',", "NODE_ENV: 'production', NEXT_PUBLIC_LOCAL_PREVIEW_AUTH: '1',")
  : script;

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'https://lightvela.ai/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.__LIGHTVELA_EMBEDDED_REGION__ = 'global';
window.__LIGHTVELA_EMBEDDED_API_BASE__ = 'https://api.lightvela.ai';
window.__LIGHTVELA_EMBEDDED_SITE_BASE__ = 'https://lightvela.ai';
window.__LIGHTVELA_EMBEDDED_TOKEN__ = 'smoke-token';
window.__LIGHTVELA_BOT_RUNTIME_ID__ = 'smoke-runtime';
window.matchMedia ??= () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });

let markReady;
let createState = null;
const externalPaths = [];
let renderFailures = 0;
let botCatalog = null;
const ready = new Promise(resolve => { markReady = resolve; });
window.ReactNativeWebView = {
  postMessage(raw) {
    const envelope = JSON.parse(raw);
    if (envelope.protocol !== 1 || envelope.runtimeId !== 'smoke-runtime') throw new Error('Bot bridge envelope mismatch');
    const message = envelope.payload;
    if (message.type === 'bot-runtime-ready') markReady(message);
    if (message.type === 'bot-create-state') createState = message;
    if (message.type === 'external-navigation') externalPaths.push(new URL(message.href).pathname);
    if (message.type === 'bot-section-render-failed') renderFailures += 1;
    if (message.type === 'bot-catalog') botCatalog = message;
  },
};
window.__LIGHTVELA_BOT_POST__ = payload => window.ReactNativeWebView.postMessage(JSON.stringify({ protocol: 1, runtimeId: 'smoke-runtime', payload }));

try {
  const module = new vm.SourceTextModule(evaluatedScript, { context: dom.getInternalVMContext() });
  await module.link(() => { throw new Error('The embedded Bot module unexpectedly imports a remote module'); });
  await module.evaluate();
  const message = await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('The embedded Bot UI did not mount')), 5000)),
  ]);
  if (message.originMatches !== true) throw new Error('The embedded Bot origin is incorrect');
  await new Promise(resolve => setTimeout(resolve, 100));
  if (typeof createState?.visible !== 'boolean' || typeof createState?.enabled !== 'boolean') {
    throw new Error('The existing Bot page did not report create availability to the native host');
  }
  if (localBotScenario) {
    await new Promise(resolve => setTimeout(resolve, 400));
    if (!botCatalog?.bots?.some(bot => bot.id === 'bot_local_preview')) {
      throw new Error('The local Bot scenario did not produce a Bot catalog');
    }
    window.dispatchEvent(new window.CustomEvent('opencraft-mobile-bot-command', {
      detail: JSON.stringify({ protocol: 1, runtimeId: 'smoke-runtime', payload: { type: 'select', section: 'overview', botId: 'bot_local_preview' } }),
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    if (renderFailures > 0) throw new Error('The Bot Overview crashed with a running Bot');
    for (const [section, selector] of [['buddy', '.lv-buddy-panel'], ['files', '.lv-tat-files-panel']]) {
      window.dispatchEvent(new window.CustomEvent('opencraft-mobile-bot-command', {
        detail: JSON.stringify({ protocol: 1, runtimeId: 'smoke-runtime', payload: { type: 'select', section, botId: 'bot_local_preview' } }),
      }));
      const deadline = Date.now() + 5000;
      while (!window.document.querySelector(selector) && renderFailures === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!window.document.querySelector(selector) || renderFailures > 0) {
        throw new Error(`The packaged ${section} page did not mount its reused frontend component (renderFailures=${renderFailures})`);
      }
    }
    // Exercise every section exposed by the native Bot drawer. Reusing the
    // frontend renderer must not leave a blank panel after repeated switches.
    const drawerSections = [
      'overview', 'channel', 'connectors', 'model', 'skill', 'buddy',
      'automations', 'memory', 'files', 'achievement', 'diagnostics',
      'settings', 'website', 'deepseek-harness', 'cloud-desktop',
    ];
    for (const section of [...drawerSections, ...drawerSections.slice().reverse()]) {
      window.dispatchEvent(new window.CustomEvent('opencraft-mobile-bot-command', {
        detail: JSON.stringify({ protocol: 1, runtimeId: 'smoke-runtime', payload: { type: 'select', section, botId: 'bot_local_preview' } }),
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!window.document.querySelector('#root')?.textContent?.trim() || renderFailures > 0) {
        throw new Error(`The packaged ${section} section became blank after native drawer navigation (renderFailures=${renderFailures})`);
      }
    }
  }
  for (const section of ['model', 'buddy', 'skill', 'channel', 'model', 'channel']) {
    window.dispatchEvent(new window.CustomEvent('opencraft-mobile-bot-command', {
      detail: JSON.stringify({ protocol: 1, runtimeId: 'smoke-runtime', payload: { type: 'select', section, botId: '' } }),
    }));
    await new Promise(resolve => setTimeout(resolve, 50));
    if (!window.document.querySelector('#root > *') || renderFailures > 0) {
      throw new Error(`The embedded Bot UI became blank while switching to ${section}`);
    }
  }
  if (createState.visible && createState.enabled) {
    window.dispatchEvent(new window.CustomEvent('opencraft-mobile-bot-command', {
      detail: JSON.stringify({ protocol: 1, runtimeId: 'smoke-runtime', payload: { type: 'create' } }),
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!externalPaths.includes('/subscribe')) {
      throw new Error('The native create command did not reach the existing subscription-aware create flow');
    }
  }
  console.log('Embedded frontend Bot module mounted; repeated section switching and native create flow passed');
} finally {
  window.close();
}
