import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_REASONING_OUTPUT ?? "/tmp/opencraft-reasoning-summary-detail";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "reasoning-summary-detail",
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/reasoning-disclosure.tsx"></script>');
    }); },
  }] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1100, height: 900 },
      hasTouch: touch, isMobile: touch });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&locale=zh`);
    await page.locator('[data-revision="0"]').waitFor();
    const update = async (action: string) => {
      const revision = Number(await page.locator('[data-revision]').getAttribute('data-revision'));
      await page.evaluate(action => (window as any).update(action, "codex"), action);
      await page.locator(`[data-revision="${revision + 1}"]`).waitFor();
    };
    const reason = page.locator('.thread-reasoning');
    const toggle = reason.getByRole('button');
    const summary = reason.locator('.thread-activity-item__summary');
    const summaryText = () => summary.evaluate(element => element.firstChild?.textContent);
    const body = reason.locator('.thread-activity-item__prose');
    const activate = async () => { if (touch) await toggle.tap(); else await toggle.click(); };
    await update("summary-detail");
    assert.equal(await summaryText(), "Checking renderer");
    assert.equal(await reason.getByRole('button', { name: "Checking renderer", exact: true }).count(), 1);
    assert.equal(await reason.locator('.thread-activity-item__detail').count(), 0);
    assert.doesNotMatch(await toggle.innerText(), /思考过程|思考中|Thought|Thinking/);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await activate();
    await body.getByRole('heading', { name: "Detailed investigation" }).waitFor();
    assert.equal(await body.locator('li').count(), 2);
    assert.match(await body.locator('code').innerText(), /const detail = 42/);
    assert.doesNotMatch(await body.innerText(), /Checking renderer/);
    await reason.evaluate(element => { (window as any).reasoningNode = element; });
    await update("detail-grow");
    await body.locator('strong').filter({ hasText: /^detail$/ }).waitFor();
    assert.equal(await summaryText(), "Checking renderer");
    await update("summary-grow");
    assert.equal(await summaryText(), "Renderer checked");
    assert.match(await body.innerText(), /New detail arrived/);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await reason.evaluate(element => (window as any).reasoningNode === element), true);
    await update("detail-drop");
    assert.equal(await toggle.count(), 0, 'losing detail removes an already-open disclosure');
    assert.equal(await body.count(), 0);
    await update("detail-grow");
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'returning detail retains the prior user choice');
    await body.getByRole('heading', { name: "Detailed investigation" }).waitFor();
    await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}.png`) });
    await activate(); await activate();
    await body.getByRole('heading', { name: "Detailed investigation" }).waitFor();
    for (const action of ["summary-only", "summary-blank-detail"]) {
      await update(action);
      assert.equal(await summaryText(), "Checking renderer");
      assert.equal(await toggle.count(), 0, 'no readable detail means no disclosure button');
      assert.equal(await reason.locator('.thread-activity-item__chevron').count(), 0);
      assert.equal(await body.count(), 0, 'summary is never repeated as an expanded body');
      const header = reason.locator('.thread-activity-item__header');
      if (touch) await header.tap(); else await header.click();
      assert.equal(await body.count(), 0);
      await page.screenshot({ path: join(output, `summary-only-${theme}-${touch ? 'touch' : 'mouse'}.png`) });
    }
    await update("detail-grow");
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'late detail enables a collapsed disclosure');
    await activate();
    await body.getByRole('heading', { name: "Detailed investigation" }).waitFor();
    await update("detail-only");
    assert.equal(await summaryText(), "const detail = 42;");
    await activate(); await body.getByRole('heading', { name: "Detailed investigation" }).waitFor();
    await update("long-detail");
    const geometry = await summary.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(geometry.scroll > geometry.width, 'long summary remains a bounded single line');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    results.push({ theme, touch, passed: true }); await page.close();
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }));
} finally { await browser?.close(); await vite.close(); }
