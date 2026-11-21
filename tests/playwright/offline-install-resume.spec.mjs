import {test, expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';

// Real browser ServiceWorker/Cache lifecycle; only the artifact HTTP server is
// synthetic. This is not a production SPA, authenticated account or device test.
for (const profile of [
  {name: 'desktop', viewport: {width: 1440, height: 1000}, isMobile: false, hasTouch: false},
  {name: 'touch', viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true},
]) {
  test.describe(profile.name, () => {
    test.use({viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch});
    test('failed update resumes immutable staging without taking over the old page', async ({page, context}) => {
      const template = await readFile(new URL('../../apps/workbench-web/offline-shell-worker.js', import.meta.url), 'utf8');
      const basePath = '/servers/fixture/';
      const immutable = 'assets/next-NEW12345.js';
      const requests = [];
      let broken = true;
      const server = createServer(async (req, res) => {
        const target = new URL(req.url, 'http://localhost');
        res.setHeader('cache-control', 'no-store');
        if (target.pathname === basePath + 'sw.js') {
          const build = target.searchParams.get('build');
          const files = build === 'old' ? ['opencraft-offline.html'] : [immutable, 'assets/missing.js', 'opencraft-offline.html'];
          res.setHeader('content-type', 'text/javascript');
          res.end(template.replace('"__OPENCRAFT_BUILD__"', JSON.stringify(build)).replace('"__OPENCRAFT_FILES__"', JSON.stringify(files))); return;
        }
        requests.push({path: target.pathname, cookie: !!req.headers.cookie});
        if (target.pathname === basePath + 'assets/missing.js' && broken) {
          // Let the other admitted resource commit before this failure.
          await new Promise(resolve => setTimeout(resolve, 100)); res.writeHead(404); res.end('missing'); return;
        }
        if (target.pathname.startsWith(basePath + 'assets/')) {res.setHeader('content-type', 'text/javascript'); res.end('window.fixtureArtifact = true;'); return;}
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><html><head></head><body>' + (target.pathname.endsWith('opencraft-offline.html') ? 'Cached application shell' : 'Online application shell') + '</body></html>');
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const origin = `http://127.0.0.1:${server.address().port}`;
      const marker = origin + basePath + 'opencraft-offline-installation';
      const cacheName = build => `opencraft-shell-v1:${origin}${basePath}:${build}`;
      const install = async (build, retry = '') => page.evaluate(async ({path, build, retry}) => {
        const registration = await navigator.serviceWorker.register(`${path}sw.js?build=${build}&retry=${retry}`, {scope: path});
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (!['installed', 'activated', 'redundant'].includes(worker.state)) await new Promise(resolve => {
          worker.addEventListener('statechange', () => { if (['installed', 'activated', 'redundant'].includes(worker.state)) resolve(); });
        });
        return worker.state;
      }, {path: basePath, build, retry});
      const readState = async build => page.evaluate(async ({name, marker}) => (await (await (await caches.open(name)).match(marker)).json()), {name: cacheName(build), marker});
      try {
        await page.goto(origin + basePath);
        await context.addCookies([{name: 'fixture_session', value: 'synthetic', url: origin}]);
        await install('old');
        await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')).toContain('build=old');
        await page.evaluate(async () => {
          const controller = navigator.serviceWorker.controller;
          const channel = new MessageChannel();
          const ack = new Promise(resolve => {channel.port1.onmessage = e => resolve(e.data);});
          controller.postMessage({type: 'opencraft-offline-configure', buildId: 'old', deployment: {hosts: [], builtinAgents: true}}, [channel.port2]);
          if (!(await ack).ok) throw new Error('configuration rejected');
        });
        await expect(install('new')).resolves.toBe('redundant');
        expect((await readState('new')).complete).toBe(false);
        expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toContain('build=old');
        expect(await page.evaluate(name => caches.has(name), cacheName('old'))).toBe(true);
        const downloaded = requests.filter(x => x.path === basePath + immutable).length;
        expect(downloaded).toBe(1);
        expect(await page.evaluate(async ({name, url}) => !!await (await caches.open(name)).match(url), {name: cacheName('new'), url: origin + basePath + immutable})).toBe(true);
        broken = false;
        await expect(install('new', 'second')).resolves.toBe('installed');
        expect(requests.filter(x => x.path === basePath + immutable).length).toBe(downloaded);
        expect((await readState('new')).complete).toBe(true);
        expect((await readState('new')).active).toBe(false);
        expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toContain('build=old');
        // Resource fetches carry same-origin credentials, so deployments that gate static files
        // behind a session cookie can still install the offline shell (docs/offline-shell-installation.md).
        expect(requests.filter(x => x.path.startsWith(basePath + 'assets/')).every(x => x.cookie)).toBe(true);
        const observer = await context.newPage(); await observer.goto(origin + '/observer');
        await page.close();
        await expect.poll(() => observer.evaluate(async path => (await navigator.serviceWorker.getRegistration(path))?.active?.scriptURL ?? '', basePath)).toContain('retry=second');
        await expect.poll(() => observer.evaluate(async ({name, marker}) => (await (await (await caches.open(name)).match(marker)).json()).active, {name: cacheName('new'), marker})).toBe(true);
        await context.setOffline(true);
        await observer.goto(origin + basePath + 'local/thread');
        await expect(observer.locator('meta[name="opencraft-offline-build"]')).toHaveAttribute('content', 'new');
        await expect(observer.locator('body')).toHaveText('Cached application shell');
        expect(await observer.evaluate(name => caches.has(name), cacheName('old'))).toBe(false);
      } finally {
        await context.setOffline(false);
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
    });
  });
}
