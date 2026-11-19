import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/cold-history");
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom", "react-intl"] }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "cold-history", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split("?")[0] !== "/") return next();
    res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-cold-history.tsx"></script>');
  }); } }],
});
let browser;
try {
  await vite.listen(); const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  browser = await (process.env.OPENCRAFT_SMOKE_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  for (const width of [402, 1200]) for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const page = await browser.newPage({ viewport: { width, height: 780 }, hasTouch: width === 402, reducedMotion });
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const settle = () => page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame); });
    const tail = page.locator('[data-probe="tail"]');
    const bottom = () => tail.evaluate(e => e.closest(".thread-turn")!.getBoundingClientRect().bottom);
    const resetSamples = () => page.evaluate(() => { (window as any).samples = []; });
    const stableBottom = async (expected: number, label: string) => {
      const samples = await page.evaluate(() => (window as any).samples as { bottom: number }[]);
      assert.ok(samples.length > 0);
      assert.ok(samples.every(s => Math.abs(s.bottom - expected) < 2), `${label}: ${JSON.stringify(samples.map(s => s.bottom))}`);
    };
    await page.goto(url); await tail.waitFor();
    if (process.env.OPENCRAFT_COLD_HISTORY_NEGATIVE_CONTROL === "1") {
      await page.addStyleTag({ content: '.thread-content[data-thread-follow-tail-layout] { justify-content: flex-start !important; }' });
    }
    await settle();
    await page.waitForFunction(() => (window as any).loads === 1 && (window as any).ready === 1);
    const edge = await bottom(); const tailNode = await tail.elementHandle();
    const draft = page.getByRole("textbox", { name: "Draft" }), draftNode = await draft.elementHandle();
    await resetSamples(); await page.evaluate(() => (window as any).grow(240)); await settle();
    await stableBottom(edge, "ongoing short output stays bottom aligned while history is pending");
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-pending.png` });
    await resetSamples(); await page.evaluate(() => (window as any).release()); await settle();
    await stableBottom(edge, "prepending a page cannot move the already visible tail");
    assert.equal(await tail.evaluate((node, original) => node === original, tailNode), true, "prepending retains tail DOM");
    assert.equal(await draft.evaluate((node, original) => node === original, draftNode), true);
    assert.equal(await draft.inputValue(), "Keep this draft");
    assert.equal(await page.evaluate(() => (window as any).ready), 1, "stream revisions and pages do not restart readiness");
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-loaded.png` });
    if (width === 402) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 180, y: 180 }] });
      for (const y of [240, 320, 400, 480]) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 180, y }] }); await settle(); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
    } else { await page.mouse.move(300, 250); await page.mouse.wheel(0, -300); }
    await page.waitForFunction(() => document.querySelector(".thread-scroll")!.scrollTop < -100); await settle();
    const anchor = await page.locator('[data-probe="old"] p').evaluateAll(elements => elements.find(e => e.getBoundingClientRect().top > 80 && e.getBoundingClientRect().bottom < 500)?.getAttribute("data-line"));
    assert.ok(anchor); const anchorElement = page.locator(`[data-line="${anchor}"]`);
    const position = await anchorElement.evaluate(e => e.getBoundingClientRect().top);
    await page.evaluate(() => (window as any).grow(420)); await settle();
    assert.ok(Math.abs(await anchorElement.evaluate(e => e.getBoundingClientRect().top) - position) < 2, "streaming does not steal historical reading");
    await page.evaluate(() => (window as any).prepend("older", 800)); await settle();
    assert.ok(Math.abs(await anchorElement.evaluate(e => e.getBoundingClientRect().top) - position) < 2, "older-page insertion preserves the reader");
    await page.evaluate(() => (window as any).leave()); await page.locator(".thread-scroll").waitFor({ state: "detached" });
    await page.evaluate(() => (window as any).return()); await anchorElement.waitFor(); await settle();
    assert.ok(Math.abs(await anchorElement.evaluate(e => e.getBoundingClientRect().top) - position) < 2, "return restores reading checkpoint");
    await writeFile(`${output}/${width}-${reducedMotion}.json`, JSON.stringify(await page.evaluate(() => ({ events: (window as any).events, samples: (window as any).samples })), null, 2));
    await page.goto(url + "?noOlder"); await tail.waitFor(); await settle();
    assert.equal(await page.evaluate(() => (window as any).ready), 1); assert.equal(await page.evaluate(() => (window as any).loads), 0);
    await page.goto(url + "?cached&shortOld"); await page.locator('[data-probe="old"]').waitFor(); await settle();
    const oldTurn = page.locator('[data-turn-key="old"]');
    const geometry = () => oldTurn.evaluate(element => {
      const root = element.getBoundingClientRect();
      return [element, ...element.querySelectorAll("[data-presentation-slot-id], .thread-message-actions, [data-turn-fork], .thread-agent-activity__turn-header")].map(node => {
        const box = node.getBoundingClientRect();
        return { key: node.getAttribute("data-presentation-slot-id") ?? node.className ?? node.tagName,
          x: box.x - root.x, y: box.y - root.y, width: box.width, height: box.height };
      });
    });
    const cachedGeometry = await geometry();
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-cached-regions.png` });
    const stableRegions = async (label: string) => {
      const actual = await geometry();
      assert.equal(actual.length, cachedGeometry.length, label + ": same region structure");
      for (let i = 0; i < actual.length; i++) for (const field of ["x", "y", "width", "height"] as const) {
        assert.ok(Math.abs(actual[i]![field] - cachedGeometry[i]![field]) < 1,
          label + ": " + JSON.stringify({ expected: cachedGeometry, actual }));
      }
    };
    assert.equal(await oldTurn.locator("[data-turn-fork]").isDisabled(), true, "cached fork occupies its final slot without authority");
    assert.equal(await oldTurn.locator(".thread-agent-activity__turn-header").count(), 1, "omitted tool body retains its activity header");
    if (process.env.OPENCRAFT_COLD_REGIONS_NEGATIVE_CONTROL === "1") {
      await page.addStyleTag({ content: '[data-turn-key="old"] [data-turn-fork]:disabled { display:none }' });
      await stableRegions("negative control must expose a missing action slot");
    }
    const cachedEdge = await bottom(); await resetSamples();
    await page.evaluate(() => (window as any).startLive()); await settle();
    assert.equal(await page.evaluate(() => (window as any).source), "mixed");
    await page.waitForFunction(() => (window as any).loads === 1);
    await stableBottom(cachedEdge, "cache-to-partial-history handoff retains geometry");
    assert.equal(await page.locator('[data-probe="old"]').getAttribute("data-can-answer"), "false");
    assert.equal(await page.locator('[data-probe="old"]').getAttribute("data-can-fork"), "false");
    await stableRegions("cache-to-mixed regions");
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-mixed-regions.png` });
    assert.equal(await oldTurn.locator("[data-turn-fork]").isDisabled(), true);
    assert.equal(await tail.getAttribute("data-can-answer"), "true");
    assert.equal(await tail.getAttribute("data-can-fork"), "true");
    await resetSamples(); await page.evaluate(() => (window as any).grow(240)); await settle();
    await stableBottom(cachedEdge, "live output continues beside cached history");
    const cachedTurn = await page.locator('[data-probe="old"]').evaluateHandle(e => e.closest(".thread-turn"));
    await resetSamples(); await page.evaluate(() => (window as any).release()); await settle();
    assert.equal(await page.evaluate(() => (window as any).source), "history");
    await stableRegions("cache-to-authoritative regions");
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-history-regions.png` });
    assert.equal(await oldTurn.locator("[data-turn-fork]").isEnabled(), true);
    await stableBottom(cachedEdge, "confirming a cached prefix preserves tail geometry");
    assert.equal(await page.locator('[data-probe="old"]').getAttribute("data-can-answer"), "true");
    assert.equal(await page.locator('[data-probe="old"]').evaluate((e, original) => e.closest(".thread-turn") === original, cachedTurn), true);
    // Learn expanded geometry from real content, then restore into body-less cache.
    const activity = oldTurn.locator(".thread-agent-activity").first();
    const disclosure = activity.locator(".thread-agent-activity__turn-header button");
    await disclosure.click(); await page.waitForTimeout(300); await settle();
    assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
    const bodyHeight = await activity.locator(".thread-agent-activity__body").evaluate(e => e.getBoundingClientRect().height);
    assert.ok(bodyHeight > 27, "learn actual expanded geometry rather than the fallback estimate");
    await page.evaluate(() => (window as any).leave()); await settle();
    assert.ok(await page.evaluate(() => Object.keys((window as any).restore?.activityContentHeights ?? {}).some(k => k.endsWith(":body:expanded"))));
    await page.evaluate(() => (window as any).cache()); await settle();
    await page.evaluate(() => (window as any).return()); await settle();
    assert.equal(await page.evaluate(() => (window as any).source), "cache");
    const pending = activity.locator("[data-content-pending]");
    assert.equal(await disclosure.getAttribute("aria-expanded"), "true", "missing body cannot force collapse");
    assert.ok(Math.abs(await pending.evaluate(e => e.getBoundingClientRect().height) - bodyHeight) < 1);
    assert.equal(await oldTurn.locator("[data-turn-fork]").isDisabled(), true, "reading is independent of action authority");
    if (width === 402) await disclosure.tap(); else { await disclosure.focus(); await page.keyboard.press("Enter"); }
    await settle(); assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
    await disclosure.click(); await settle();
    assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
    assert.ok(Math.abs(await pending.evaluate(e => e.getBoundingClientRect().height) - bodyHeight) < 1, "placeholder cannot overwrite learned height");
    const expandedGeometry = await geometry();
    const stableExpanded = async (label: string) => {
      assert.equal(await disclosure.getAttribute("aria-expanded"), "true", label);
      const actual = await geometry();
      assert.equal(actual.length, expandedGeometry.length);
      for (let i = 0; i < actual.length; i++) for (const field of ["x", "y", "width", "height"] as const)
        assert.ok(Math.abs(actual[i]![field] - expandedGeometry[i]![field]) < 1, label + ": " + JSON.stringify({ expected: expandedGeometry, actual }));
    };
    await page.evaluate(() => (window as any).startLive()); await settle();
    assert.equal(await page.evaluate(() => (window as any).source), "mixed");
    await stableExpanded("expanded cache-to-mixed");
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-expanded-cache.png` });
    const expandedNode = await activity.elementHandle();
    await page.evaluate(() => (window as any).release()); await settle();
    assert.equal(await page.evaluate(() => (window as any).source), "history");
    await stableExpanded("expanded cache-to-authoritative");
    assert.equal(await pending.count(), 0);
    assert.equal(await activity.evaluate((node, original) => node === original, expandedNode), true);
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-expanded-history.png` });

    // Cached Turn resources use the same renderers and final action slots.
    await page.goto(url + "?cached&shortOld&resources"); await page.locator('[data-probe="old"]').waitFor(); await settle();
    const summary = oldTurn.locator(".thread-turn-diff");
    const hook = oldTurn.locator(".thread-hook-stats__trigger");
    assert.equal(await hook.getAttribute("aria-busy"), "true");
    assert.equal(await summary.getAttribute("aria-busy"), "true");
    assert.equal(await summary.locator(".thread-turn-diff__actions button").isDisabled(), true);
    await summary.locator(".thread-turn-diff__more").click(); await settle();
    const resourceGeometry = () => oldTurn.evaluate(element => {
      const root = element.getBoundingClientRect();
      return [element, ...element.querySelectorAll("[data-turn-resource-id], .thread-turn-diff, .thread-turn-diff__header, .thread-turn-diff__files, .thread-turn-diff__actions button, .thread-message-actions, .thread-hook-stats__trigger")].map(node => {
        const box = node.getBoundingClientRect(); return { x: box.x - root.x, y: box.y - root.y, width: box.width, height: box.height };
      });
    });
    const resourceBaseline = await resourceGeometry();
    const stableResources = async (label: string) => {
      assert.deepEqual(await resourceGeometry(), resourceBaseline, label);
      assert.equal(await summary.locator(".thread-turn-diff__more").getAttribute("aria-expanded"), "true");
    };
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-resources-cache.png` });
    await page.evaluate(() => (window as any).startLive()); await settle();
    await stableResources("resource cache-to-mixed geometry");
    assert.equal(await summary.locator(".thread-turn-diff__actions button").isDisabled(), true);
    await page.evaluate(() => (window as any).release()); await settle();
    await stableResources("resource cache-to-canonical geometry");
    assert.equal(await hook.getAttribute("aria-busy"), null);
    await hook.focus();
    await oldTurn.locator(".thread-hook-stats__tooltip strong").waitFor();
    assert.match(await oldTurn.locator(".thread-hook-stats__tooltip").innerText(), /Hooks/u);
    assert.equal(await summary.locator(".thread-turn-diff__actions button").isEnabled(), true);
    await summary.locator(".thread-turn-diff__actions button").click(); await settle();
    assert.equal(await page.evaluate(() => (window as any).reviews), 1);
    await page.screenshot({ path: `${output}/${width}-${reducedMotion}-resources-history.png` });

    await page.goto(url + "?cached&resources&resourceOnly"); await summary.waitFor(); await settle();
    assert.equal(await page.evaluate(() => (window as any).source), "cache");
    assert.equal(await hook.getAttribute("aria-busy"), "true", "resource-only Turn has its own assistant surface");
    const bodylessGeometry = await resourceGeometry();
    await page.evaluate(() => (window as any).startLive()); await settle();
    await page.evaluate(() => (window as any).release()); await settle();
    assert.deepEqual(await resourceGeometry(), bodylessGeometry, "resources do not require an assistant message body to retain layout");
    assert.equal(await hook.getAttribute("aria-busy"), null);
    assert.equal(await summary.locator(".thread-turn-diff__actions button").isEnabled(), true);
    // A missing expanded body must reject geometry after either layout or font
    // changes, while its View-owned disclosure preference remains untouched.
    await page.goto(url + "?cached&shortOld"); await page.locator('[data-probe="old"]').waitFor(); await settle();
    await page.evaluate(() => (window as any).startLive()); await settle();
    await page.evaluate(() => (window as any).release()); await settle();
    await activity.locator(".thread-agent-activity__turn-header button").click(); await page.waitForTimeout(300); await settle();
    const learnedHeight = await activity.locator(".thread-agent-activity__body").evaluate(e => e.getBoundingClientRect().height);
    await page.evaluate(() => (window as any).leave()); await settle();
    await page.evaluate(() => (window as any).cache()); await settle();
    await page.evaluate(() => (window as any).return()); await settle();
    const skeleton = activity.locator("[data-content-pending]");
    assert.equal(await skeleton.evaluate(e => e.getBoundingClientRect().height), learnedHeight);
    await page.setViewportSize({ width: width === 1200 ? 600 : width + 101, height: 780 }); await settle();
    assert.equal(await skeleton.evaluate(e => e.getBoundingClientRect().height), 27, "width change invalidates measured height");
    assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
    await page.setViewportSize({ width, height: 780 }); await settle();
    await page.evaluate(() => (window as any).startLive()); await settle();
    await page.evaluate(() => (window as any).release()); await settle();
    await page.evaluate(() => (window as any).leave()); await settle();
    await page.evaluate(() => (window as any).cache()); await settle();
    await page.evaluate(() => (window as any).return()); await settle();
    assert.equal(await skeleton.evaluate(e => e.getBoundingClientRect().height), learnedHeight);
    await skeleton.evaluate(e => { (e as HTMLElement).style.fontSize = "19px"; }); await settle();
    assert.equal(await skeleton.evaluate(e => e.getBoundingClientRect().height), 27, "font change invalidates otherwise compatible height");
    assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
    await page.goto(url + "?cached&longTail"); await tail.waitFor(); await settle();
    await page.evaluate(() => (window as any).startLive()); await settle();
    assert.equal(await page.evaluate(() => (window as any).loads), 0, "offscreen cached history does not force a fetch");
    await page.locator(".thread-scroll").evaluate(e => { e.scrollTop = -600; }); await settle();
    await page.waitForFunction(() => (window as any).loads === 1);
    assert.deepEqual(errors, []); await page.close();
    console.log(`PASS ${width} ${reducedMotion}: held first page, live output, prepend, user reading, restore, short conversation and mixed cache authority`);
  }
} finally { await browser?.close(); await vite.close(); }
