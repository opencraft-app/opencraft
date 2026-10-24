import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import('playwright');
const output = process.env.OPENCRAFT_DISPLAY_CACHE_EVIDENCE ?? '/tmp/opencraft-session-display-cache';
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-display-cache-smoke', optimizeDeps: { entries: ['tests/fixtures/session-display-cache-browser.tsx'] }, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'display-cache-smoke', configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/')
                return next(); res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/session-display-cache-browser.tsx"></script>'); }); } }] });
let browser: any;
const results = [];
try {
    await mkdir(output, { recursive: true });
    await vite.listen();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    for (const width of [390, 1100]) {
        const page = await browser.newPage({ viewport: { width, height: 850 } });
        const errors: string[] = [];
        page.on('pageerror', (e: Error) => errors.push(e.message));
        await page.addInitScript('window.__name=value=>value');
        await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/`);
        await page.getByRole('button', { name: 'Open A', exact: true }).click();
        await page.getByText('My previously viewed answer', { exact: true }).waitFor();
        const first = await page.evaluate(() => (window as any).displayBenchmark.commits.find((x: any) => x.thread === 'a'));
        assert.equal(first.frames, 2, 'first render must paint cached history before Effects');
        assert.equal(first.authoritative, false);
        await page.getByRole('button', { name: 'Send', exact: true }).isDisabled().then((v: boolean) => assert.equal(v, true));
        await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('Keep my unsent draft');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Open A', exact: true }).click();
        await page.getByText('My previously viewed answer', { exact: true }).waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'Draft', exact: true }).inputValue(), 'Keep my unsent draft');
        await page.screenshot({ path: `${output}/cached-${width}.png` });
        // Only display-scope replacement is modeled here; account draft disposal has its own owner tests.
        await page.getByRole('button', { name: 'Switch account', exact: true }).click();
        await page.getByText('My previously viewed answer', { exact: true }).waitFor({ state: 'hidden' });
        assert.deepEqual(errors, []);
        results.push({ width, firstRenderFrames: first.frames, authoritative: first.authoritative, accountIsolation: true, draftPreserved: true });
        await page.close();
    }
    await writeFile(output + '/results.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
}
finally {
    await browser?.close();
    await vite.close();
}
