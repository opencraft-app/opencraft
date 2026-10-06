import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const artifacts = await mkdtemp(join(tmpdir(), "opencraft-codex-change-card-"));
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-codex-change-card", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "codex-change-card", configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
    response.setHeader("content-type", "text/html");
    response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/codex-change-card.tsx"></script>');
  }); } }] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const results = [];
  for (const width of [320, 390, 1000]) for (const theme of ["light", "dark", "frost"]) for (const locale of ["en-US", "zh-CN"]) {
    const touch = width < 768;
    const page = await browser.newPage({ viewport: { width, height: 1500 }, hasTouch: touch, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&locale=${locale}${touch ? "&touch=1" : ""}`);
    const multi = page.locator('[data-card="multiple"] .thread-turn-diff');
    await multi.waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no narrow-screen document overflow");
    assert(await multi.evaluate((node: Element) => node.getBoundingClientRect().right <= window.innerWidth), "the complete card stays in the viewport");
    const rows = multi.locator(".thread-turn-diff__files > button:not(.thread-turn-diff__more)");
    assert.equal(await rows.count(), 3);
    assert.equal(await multi.locator(".thread-turn-diff__actions button").innerText(), locale === "zh-CN" ? "查看更改" : "View changes");
    const geometry = await multi.evaluate((node: Element) => {
      const header = node.querySelector(".thread-turn-diff__header")!, icon = node.querySelector(".thread-turn-diff__icon")!;
      const h = getComputedStyle(header), stats = getComputedStyle(node.querySelector(".thread-turn-diff__stats")!);
      return { radius: getComputedStyle(node).borderRadius, height: header.getBoundingClientRect().height, gap: h.gap,
        padding: h.paddingLeft, icon: icon.getBoundingClientRect().width, statsGap: stats.gap,
        foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor,
        fontSize: stats.fontSize, chatSize: getComputedStyle(node).fontSize,
        rowHeight: node.querySelector(".thread-turn-diff__files > button")!.getBoundingClientRect().height };
    });
    assert.equal(geometry.radius, "10px"); assert.equal(geometry.gap, "10px"); assert.equal(geometry.padding, "12px");
    assert.equal(geometry.icon, 40); assert.equal(geometry.rowHeight, 36); assert.equal(geometry.statsGap, "4px");
    assert.notEqual(geometry.foreground, geometry.background, "theme supplies distinct card foreground and background");
    assert.notEqual(geometry.background, "rgba(0, 0, 0, 0)", "card does not rely on undefined theme colors");
    assert(geometry.height >= 64 && geometry.height < 66, `reference header rhythm: ${JSON.stringify(geometry)}`);
    assert.equal(parseFloat(geometry.fontSize), parseFloat(geometry.chatSize) - 1);
    const more = multi.locator(".thread-turn-diff__more");
    await more.click(); assert.equal(await more.getAttribute("aria-expanded"), "true"); assert.equal(await rows.count(), 4);
    assert(await rows.last().evaluate((row: Element) => row.querySelector("b")!.getBoundingClientRect().right <= row.querySelector(".thread-turn-diff__stats")!.getBoundingClientRect().left - 7));
    await more.click(); assert.equal(await more.getAttribute("aria-expanded"), "false");
    const single = page.locator('[data-card="single"]');
    assert.equal(await single.locator(".thread-turn-diff__files").count(), 0);
    assert.equal(await single.locator(".thread-turn-diff__stats i").innerText(), "-0");
    assert.equal(await page.locator('[data-card="binary"] .thread-turn-diff__stats b').innerText(), "+0");
    assert.equal(await page.locator('[data-card="binary"] .thread-turn-diff__stats i').innerText(), "-0");
    assert.equal(await page.locator('[data-card="readonly"] .thread-turn-diff__actions button').count(), 0);
    assert(await page.locator('[data-card="readonly"] .thread-turn-diff__header-target').isDisabled());
    assert.equal(await page.locator('[data-card="mixed"] .thread-turn-diff__large').isVisible(), !touch);
    const live = page.locator(".thread-turn-diff-live");
    await live.evaluate((node: Element) => { (window as any).__liveNode = node; });
    await page.locator("#update").click();
    assert(await live.evaluate((node: Element) => (window as any).__liveNode === node), "counter updates must not remount the entry");
    assert.equal(await live.locator(".thread-turn-diff__number").first().getAttribute("aria-label"), "25");
    if (!touch) {
      await live.focus(); await live.press("ArrowDown");
      await page.waitForFunction(() => document.activeElement?.matches(".thread-turn-diff-file-list button"));
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("html").getAttribute("data-review"), "live:turn-diff:src/components/conversation/turn-diff-resource.tsx");
      assert.equal(await page.locator(".thread-turn-diff-file-list").count(), 0, "keyboard selection closes the live list");
      await live.hover();
      const list = page.locator(".thread-turn-diff-file-list"); await list.waitFor();
      assert.equal(await list.locator(":scope > ul > li").count(), 4);
      await list.locator(":scope > ul > li button").nth(1).click();
      assert.equal(await page.locator("html").getAttribute("data-review"), "live:turn-diff:docs/design.md");
      await page.mouse.move(0, 0);
      await rows.first().hover();
      const preview = page.locator(".thread-turn-diff-preview"); await preview.waitFor();
      assert((await preview.innerText()).includes("turn-diff-resource.tsx"));
      await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}-hover.png`) });
      await page.mouse.move(0, 0, { steps: 10 }); await preview.waitFor({ state: "hidden" });
      await page.locator('[data-card="large"] .thread-turn-diff__header-target').hover();
      await page.waitForTimeout(900);
      assert.equal(await preview.count(), 0, "large diffs do not inline-render");
    }
    await rows.first().click();
    assert.equal(await page.locator("html").getAttribute("data-review"), "multiple:turn-diff:src/components/conversation/turn-diff-resource.tsx");
    await rows.first().click({ modifiers: ["Control"] });
    assert.equal(await page.locator("html").getAttribute("data-open-file"), "file:///workspace/src/components/conversation/turn-diff-resource.tsx");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#update").click();
    assert.equal(await live.locator(".thread-turn-diff__number").first().getAttribute("aria-label"), "27");
    assert.equal(await live.locator(".thread-turn-diff__digit > span").first().evaluate((node: Element) => getComputedStyle(node).transitionDuration), "0.2s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert(parseFloat(await live.locator(".thread-turn-diff__digit > span").first().evaluate((node: Element) => getComputedStyle(node).transitionDuration)) <= 0.00001,
      "reduced motion disables perceptible counter animation, including the global 0.01ms accessibility override");
    await page.locator("#clear").click(); assert.equal(await page.locator(".thread-turn-diff-live").count(), 0);
    await page.locator("#clear").click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
    assert.deepEqual(errors, []); results.push({ width, theme, locale, geometry }); await page.close();
  }
  console.log(JSON.stringify({ artifacts, passed: results }));
} finally { await browser?.close(); await vite.close(); }
