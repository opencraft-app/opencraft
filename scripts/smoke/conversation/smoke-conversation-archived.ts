import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = ".local/conversation-archived";
await mkdir(output, {recursive: true});
const vite = await createServer({root: process.cwd(), configFile: false, logLevel: "error", resolve: {dedupe: ["react", "react-dom"]},
  cacheDir: "node_modules/.vite-conversation-archived", esbuild: {jsx: "automatic", target: "esnext"}, server: {host: "127.0.0.1", port: 0, hmr: false},
  plugins: [{name: "archive-fixture", configureServer(server) {server.middlewares.use((req,res,next) => {
    if (!req.url?.startsWith("/?")) return next();
    res.setHeader("content-type", "text/html");
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-archived.tsx"></script>');
  });}}]});
let browser;
try {
  await vite.listen(); browser = await chromium.launch({headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE || undefined, args: ["--no-sandbox"]});
  for (const width of [360, 1280]) for (const theme of ["light", "dark"]) {
    const touch = width === 360;
    const context = await browser.newContext({viewport: {width, height: 800}, hasTouch: touch, isMobile: touch});
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${vite.resolvedUrls!.local[0]}?theme=${theme}`);
    const card = page.locator('.conversation-unavailable-state');
    await card.waitFor();
    await page.getByText('历史回复 8：', {exact: false}).waitFor();
    assert.equal(await page.locator('.thread-scroll-footer .conversation-unavailable-state').count(), 1);
    assert.equal(await page.locator('.conversation-archived-badge').count(), 1);
    const button = page.getByRole('button', {name: '恢复会话', exact: true});
    assert.match(await button.getAttribute('class') ?? '', /ui-button/);
    const bounds = await card.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 800);
    const action = await button.boundingBox(); assert.ok(action && action.x >= bounds.x && action.x + action.width <= bounds.x + bounds.width);
    await page.screenshot({path: `${output}/${width}-${theme}.png`});
    // The same transcript node survives pending, failed and successful restore.
    await page.evaluate(() => { (window as any).historyNode = [...document.querySelectorAll('p')].find(p => p.textContent?.includes('历史回复 8')); });
    if (touch) await button.tap(); else {await button.focus(); await page.keyboard.press('Enter');}
    assert.equal(await button.isDisabled(), true);
    await page.evaluate(() => (window as any).settleRestore(false));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.conversation-unavailable-state__restore')?.disabled);
    assert.deepEqual(await card.boundingBox(), bounds);
    if (touch) await button.tap(); else await button.click();
    await page.evaluate(() => (window as any).settleRestore(true));
    await page.getByRole('textbox', {name: '继续对话'}).waitFor();
    assert.equal(await page.locator('.conversation-archived-badge').count(), 0);
    assert.equal(await page.evaluate(() => (window as any).historyNode?.isConnected), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: real Shell/Conversation archive footer, retained read-only history, narrow/wide light/dark, keyboard/touch and held/failed/successful restore (synthetic boundary).');
} finally {await browser?.close(); await vite.close();}
