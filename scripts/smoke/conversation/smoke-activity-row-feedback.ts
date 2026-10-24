import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const vite = await createServer({ configFile: false, root, logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "activity-feedback-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/activity-row-feedback.tsx"></script>');
    });
  } }],
});
let browser;
try {
  await vite.listen();
  const address = vite.httpServer!.address();
  assert.ok(address !== null && typeof address !== "string");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const output = process.env.OPENCRAFT_ACTIVITY_FEEDBACK_REPORT;
  if (output) await mkdir(output, { recursive: true });
  for (const width of [390, 1200]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: width === 390,
      hasTouch: width === 390, reducedMotion: "no-preference" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${address.port}/?theme=${theme}`);
    const toggle = page.getByRole("button", { name: "Toggle running" });
    await toggle.waitFor();
    assert.equal(await page.locator(".is-shimmering").count(), 0);
    await toggle.click();
    const measureCommand = (row: string) => page.locator(`[data-row="${row}"] .thread-activity-item__summary`).evaluate(node => {
      const style = getComputedStyle(node), range = document.createRange();
      range.selectNodeContents(node.firstChild!);
      return { size: style.fontSize, line: style.lineHeight, textHeight: range.getBoundingClientRect().height,
        adjustment: style.getPropertyValue("text-size-adjust") || style.getPropertyValue("-webkit-text-size-adjust"),
        copies: [...node.querySelectorAll(".is-shimmering__highlight")].map(copy => getComputedStyle(copy).fontSize) };
    });
    const runningMetrics = await measureCommand("long-command");
    const doneMetrics = await measureCommand("completed-command");
    assert.equal(runningMetrics.size, "14px");
    assert.equal(runningMetrics.adjustment, "100%", "long running command must not use mobile auto inflation");
    assert.equal(runningMetrics.size, doneMetrics.size);
    assert.equal(runningMetrics.line, doneMetrics.line);
    assert.equal(runningMetrics.textHeight, doneMetrics.textHeight, "painted glyph height is independent of running state");
    assert.deepEqual(runningMetrics.copies, [runningMetrics.size]);
    if (output) await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) });
    for (const name of ["disclosure", "summary", "group"]) {
      const row = page.locator(`[data-row="${name}"]`);
      await row.locator(".is-shimmering").waitFor();
      assert.equal(await row.locator(".is-shimmering").count(), 1, `${name} owns one sweep`);
      assert.equal(await row.locator('.is-shimmering > [aria-hidden="true"]').count(), 1);
    }
    assert.equal(await page.locator(".is-shimmering .is-shimmering").count(), 0);
    assert.equal(await page.locator('[data-row="group"] .thread-activity-item__icon[data-running="true"]').count(), 0, "expanded group hands only glyph motion to rows");
    const sweep = page.locator('[data-row="disclosure"] .is-shimmering__sweep');
    await page.waitForTimeout(750);
    const before = await sweep.evaluate(node => getComputedStyle(node).transform);
    await page.waitForTimeout(180);
    assert.notEqual(await sweep.evaluate(node => getComputedStyle(node).transform), before);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await sweep.evaluate(node => getComputedStyle(node).animationName), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Remount so the next summary arrives inside the one-second deferred slot.
    await page.reload(); await toggle.waitFor(); await toggle.click();
    const group = page.locator('[data-row="group"]');
    const label = group.locator(".thread-agent-activity__deferred-summary");
    await page.getByRole("button", { name: "Settle with deferred label" }).click();
    assert.equal(await label.textContent(), "Initial summary", "label is still the committed snapshot");
    assert.equal(await page.locator(".is-shimmering").count(), 0, "settled state stops paint before deferred copy commits");
    assert.equal((await measureCommand("long-command")).textHeight, runningMetrics.textHeight,
      "settling a long command preserves its text geometry");
    await page.waitForFunction(() => document.querySelector('[data-row="group"] .thread-agent-activity__deferred-summary')?.textContent === "Next summary");
    assert.equal(await page.locator(".is-shimmering").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Activity row feedback passed: shared adapters, live state, deferred summary, glyph handoff and reduced motion");
} finally { await browser?.close(); await vite.close(); }
