import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import WebSocket, { WebSocketServer } from 'ws';
const { chromium } = await import('playwright');
const endpoint = process.env.OPENCRAFT_BENCHMARK_HOST_DESCRIPTOR ? JSON.parse(await readFile(process.env.OPENCRAFT_BENCHMARK_HOST_DESCRIPTOR, 'utf8')).websocketUrl : process.env.OPENCRAFT_BENCHMARK_NATIVE_URL, thread = process.env.OPENCRAFT_BENCHMARK_THREAD_ID;
const latency = Number(process.env.OPENCRAFT_BENCHMARK_RESPONSE_DELAY_MS ?? 0);
if (!endpoint || !thread)
    throw Error('Explicit native URL and Thread required');
const out = process.env.OPENCRAFT_BENCHMARK_OUTPUT!;
if (!out)
    throw Error('Explicit output directory required');
await mkdir(out, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', resolve: { dedupe: ['react', 'react-dom'] }, cacheDir: 'node_modules/.vite-session-loading-benchmark', optimizeDeps: { entries: ['tests/fixtures/session-loading-browser.tsx'] }, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'loading-benchmark', configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url?.split('?')[0] !== '/')
                return next(); res.setHeader('content-type', 'text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/session-loading-browser.tsx"></script>'); }); } }] });
const wss = new WebSocketServer({ noServer: true });
let browser: any;
const trace: any[] = [];
const allowed = new Set(['initialize', 'initialized', 'thread/read', 'thread/resume', 'thread/turns/list', 'thread/items/list', 'thread/loaded/list', 'thread/goal/get', 'thread/queue/list', 'runtime/machine/read', 'skills/list', 'model/list']);
try {
    await vite.listen();
    vite.httpServer!.on('upgrade', (req, socket, head) => { if (req.url === '/benchmark-rpc')
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); });
    // Credentials stay in this Node bridge; the browser sees only its local URL.
    wss.on('connection', down => {
        const upstream = new WebSocket(endpoint);
        const queue: string[] = [];
        down.on('message', raw => {
            const frame = String(raw), request = JSON.parse(frame);
            trace.push({ direction: 'request', method: request.method, id: request.id });
            if (request.method && !allowed.has(request.method)) {
                if (request.id !== undefined) down.send(JSON.stringify({
                    id: request.id, error: { code: -32601, message: 'Read benchmark method unavailable' },
                }));
                return;
            }
            if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
            else queue.push(frame);
        });
        upstream.on('open', () => {
            for (const frame of queue) upstream.send(frame);
            queue.length = 0;
        });
        upstream.on('message', raw => {
            const response = JSON.parse(String(raw));
            trace.push({ direction: 'response', id: response.id, code: response.error?.code });
            setTimeout(() => {
                if (down.readyState === WebSocket.OPEN) down.send(String(raw));
            }, latency);
        });
        upstream.on('error', () => down.close());
        down.on('close', () => upstream.close());
    });
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const rows = [];
    // Exclude module/renderer warm-up; each measured page starts with a fresh Runtime.
    for (let i = 0; i < Number(process.env.OPENCRAFT_BENCHMARK_SAMPLES ?? 5) + 1; i++) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
        const errors: string[] = [];
        page.on('console', msg => { if (msg.type() === 'error')
            console.error('BROWSER_ERROR', msg.text().slice(0, 400)); });
        page.on('pageerror', (e: Error) => { errors.push(e.message); console.error('PAGE_ERROR', e.message, e.stack); });
        await page.addInitScript('window.__name=value=>value');
        await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?thread=${encodeURIComponent(thread)}`);
        await page.getByRole('button', { name: 'Open conversation' }).click();
        try {
            await page.waitForFunction(() => (window as any).loadingBenchmark?.metrics.paintedMs != null && (window as any).loadingBenchmark?.metrics.readyMs != null, {}, { timeout: 60000 });
        }
        catch (error) {
            await page.screenshot({ path: out + '/failure.png' });
            throw error;
        }
        const value = await page.evaluate(() => (window as any).loadingBenchmark.metrics);
        assert.deepEqual(errors, []);
        if (i > 0)
            rows.push(value);
        if (i === 1)
            await page.screenshot({ path: out + '/conversation.png' });
        await page.close();
    }
    await writeFile(out + '/browser-samples.json', JSON.stringify(rows, null, 2));
    console.log(JSON.stringify(rows));
}
finally {
    await writeFile(out + '/rpc-trace.json', JSON.stringify(trace, null, 2));
    await browser?.close();
    for (const ws of wss.clients)
        ws.terminate();
    wss.close();
    await vite.close();
}
