import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ entryPoints: ["tests/fixtures/hermes-bot-history-ui.tsx"], bundle: true, write: false,
  outdir: "/tmp/opencraft-hermes-history-bundle", format: "esm", platform: "browser", jsx: "automatic",
  loader: { ".scss": "empty", ".css": "empty" } });
const assets = resolve("apps/workbench-web/dist/assets");
const cssNames = (await readdir(assets)).filter(name => name.endsWith(".css"));
const css = Buffer.concat(await Promise.all(cssNames.map(name => readFile(join(assets, name)))));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle.outputFiles.find(file => file.path.endsWith(".js"))!.contents);
  } else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else {
    res.setHeader("content-type", "text/html");
    res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  }
});
let browser: any;
try {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const evidence = await mkdtemp(join(tmpdir(), "opencraft-hermes-history-evidence-"));
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(base);
    const question = page.getByText("Original history question", { exact: true });
    try { await question.waitFor({ timeout: 10000 }); }
    catch (error) {
      console.error(JSON.stringify({ errors, fixture: await page.evaluate(() => ({
        text: document.body.innerText, requests: (window as any).__historyFixture?.requests,
        snapshot: (window as any).__historyFixture?.snapshot(),
      })) }));
      await page.screenshot({ path: join(evidence, `failure-${width}.png`) });
      throw error;
    }
    assert.deepEqual(await page.evaluate(() => (window as any).__historyFixture.requests), [0, 120, 240]);
    assert.equal(await page.getByText("What should we work on?", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no new horizontal overflow");
    const bubble = await question.elementHandle();
    await page.evaluate(() => (window as any).__historyFixture.resync());
    await page.waitForFunction(() => (window as any).__historyFixture.requests.length === 5);
    assert.equal(await bubble!.evaluate((element: Element) => element.isConnected), true, "resync must retain mounted history");
    await page.screenshot({ path: join(evidence, `loaded-${width}.png`) });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.screenshot({ path: join(evidence, `loaded-${width}-dark.png`) });

    await page.goto(`${base}/?mode=budget`);
    const earlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
    await earlier.waitFor();
    await page.waitForFunction(() => (window as any).__historyFixture.requests.length === 4);
    const recoveryStyle = await earlier.evaluate((element: Element) => {
      const style = getComputedStyle(element);
      return { appearance: style.appearance, border: style.borderTopWidth };
    });
    assert.equal(recoveryStyle.appearance, "none", "recovery action must use the application control primitive");
    assert.equal(recoveryStyle.border, "0px", "no native browser button frame");
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => (window as any).__historyFixture.requests), [0, 120, 240, 360]);
    assert.equal(await page.getByText("What should we work on?", { exact: true }).count(), 0);
    await earlier.click();
    await page.waitForFunction(() => (window as any).__historyFixture.requests.length === 7);
    await earlier.waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => (window as any).__historyFixture.requests.length), 7);
    await page.screenshot({ path: join(evidence, `bounded-${width}.png`) });

    await page.goto(`${base}/?mode=failure`);
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await retry.waitFor();
    assert.equal(await page.getByRole("alert").textContent(), "Could not load earlier messages.Try again");
    await retry.click();
    await page.getByText("Original history question", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).__historyFixture.requests), [0, 120, 120, 240]);
    assert.deepEqual(errors, []);
    const avatar = await page.locator(".bot-chat-header__identity svg").first().boundingBox();
    assert.ok(avatar && avatar.width <= 64, "actual built product styles must be present");
    await page.close();
  }
  console.log(`PASS real Hermes Adapter/Handler → AppServer/Cordis → Bot Source/View: empty history progress, bounded continuation, retry, resync DOM continuity; desktop/mobile, light/dark. Native RPC/REST simulated; no inference. Evidence: ${evidence}`);
} finally {
  await browser?.close();
  await new Promise<void>(done => server.close(() => done()));
}
