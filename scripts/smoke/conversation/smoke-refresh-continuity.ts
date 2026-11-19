import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_REFRESH_EVIDENCE ?? "/tmp/opencraft-refresh-continuity";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-refresh-smoke",
  optimizeDeps: { entries: ["tests/fixtures/refresh-continuity-browser.tsx"] }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "refresh-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split("?")[0] !== "/") return next();
    res.setHeader("content-type", "text/html");
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/refresh-continuity-browser.tsx"></script>');
  }); } }] });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1100, "light"]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, hasTouch: width === 390 });
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    page.setDefaultTimeout(45000);
    await page.addInitScript("window.__name = v => v");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?theme=${theme}`);
    const answer = page.getByText("刷新后正文保持稳定。", { exact: true }); await answer.waitFor();
    await page.locator('[data-display-activity="first"]').waitFor();
    await page.locator('[data-display-activity="third"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const before = await answer.boundingBox();
    const opacity = await page.locator("[data-history-presentation]").evaluate(e => getComputedStyle(e).opacity);
    assert.equal(opacity, "1");
    assert.equal(await page.locator("header strong").textContent(), "排查刷新连续性");
    assert.equal(await page.getByText("PRIVATE RESULT", { exact: true }).count(), 0);
    await page.getByRole("textbox", { name: "Draft" }).fill("草稿不能被接管清空");
    await page.screenshot({ path: `${output}/${width}-${theme}-cached.png` });
    await page.evaluate(() => (window as any).refreshTest.partial());
    await page.waitForTimeout(200);
    assert.equal(await page.locator("[data-display-activity]").count(), 3);
    await page.evaluate(() => (window as any).refreshTest.live());
    await page.locator("[data-display-activity]").first().waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    const after = await answer.boundingBox();
    assert.ok(before && after && Math.abs(before.y - after.y) <= 1, JSON.stringify({ before, after }));
    assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "草稿不能被接管清空");
    await page.screenshot({ path: `${output}/${width}-${theme}-live.png` });
    const commits = await page.evaluate(() => (window as any).refreshTest.commits);
    assert.ok(commits.filter((c: any) => c.frames > 0).every((c: any) => c.title === "排查刷新连续性"));
    await page.evaluate(() => (window as any).refreshTest.other());
    await answer.waitFor({ state: "hidden" });
    assert.equal(await page.locator("header strong").textContent(), "");
    assert.deepEqual(errors, []);
    results.push({ width, theme, touch: width === 390, before, after, opacity, titleAtomic: true, draftPreserved: true, partialPreserved: true, commits });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2)); console.log(JSON.stringify(results));
} finally { await browser.close(); await vite.close(); }
