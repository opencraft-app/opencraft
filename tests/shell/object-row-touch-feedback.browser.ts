import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { navigationLifecycleFixture } from "../fixtures/navigation-lifecycle";

// Actual Shell, Router, IM renderer and shared route-family retention. Only the
// account/channel transport is synthetic; no production data or inference.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/object-row-touch-feedback");
const source = navigationLifecycleFixture
  .replace(
    "window.navigationProbe=navigation;",
    "const routeFamilies=new Map([...views.values()].filter(v=>v.routeFamily).map(v=>[v.id,v.routeFamily]));window.navigationProbe=navigation;",
  )
  .replace(
    "routeStackPresentation(state,'synthetic-account')",
    "routeStackPresentation(state,'synthetic-account',routeFamilies)",
  )
  .replace("<RouteViewStack navigation={state}>", "<RouteViewStack navigation={state} routeFamilies={routeFamilies}>");
assert.notEqual(source, navigationLifecycleFixture);
assert.ok(source.includes("routeFamilies={routeFamilies}"));
const server = await createServer({
  root: process.cwd(),
  configFile: false,
  cacheDir: ".local/object-row-touch-vite",
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react/jsx-runtime",
      "motion/react",
      "@tanstack/react-query",
      "react-intl",
      "tslib",
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-model",
      "prosemirror-transform",
      "prosemirror-commands",
      "prosemirror-history",
      "prosemirror-keymap",
      "prosemirror-inputrules",
      "prosemirror-schema-list",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-alert-dialog",
    ],
  },
  plugins: [
    {
      name: "object-row-touch-fixture",
      resolveId: (id) => (id === "/inbox-swipe.tsx" ? id : null),
      load: (id) => (id === "/inbox-swipe.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes("text/html")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/inbox-swipe.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
    });
    await page.goto(server.resolvedUrls!.local[0]! + "?theme=" + theme);
    await page.getByRole("button", { name: "Open Inbox", exact: true }).tap();
    const row = page.getByRole("button", { name: "Navigation group 3", exact: true });
    await row.waitFor();
    await row.evaluate((el) => (el.id = "press-probe"));
    const rest = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    const stream = page.locator(".people-stream");
    const before = await stream.evaluate((el) => el.scrollTop);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#press-probe" });
    const box = (await row.boundingBox())!,
      x = box.x + box.width * 0.6,
      y = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    // Explicitly hold native :active to model WebKit retaining it after a pan.
    // Actual touch input still drives scroll/cancellation; this is not an iPhone claim.
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active", "hover"] });
    assert.equal(
      await row.getAttribute("data-touch-press"),
      "false",
      "contact starts undecided, not highlighted before scroll intent",
    );
    await page.waitForTimeout(180);
    assert.notEqual(
      await row.evaluate((el) => getComputedStyle(el).backgroundColor),
      rest,
      "stationary contact keeps press feedback",
    );
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 12 }] });
      assert.equal(
        await row.evaluate((el) => getComputedStyle(el).backgroundColor),
        rest,
        "scroll cancellation clears paint without an exit fade",
      );
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(180);
    assert.ok(
      (await stream.evaluate((el) => el.scrollTop)) > before + 20,
      "native vertical scrolling is not prevented",
    );
    assert.equal(
      await row.evaluate((el) => getComputedStyle(el).backgroundColor),
      rest,
      "drag must retire native pressed paint",
    );
    assert.equal(await row.getAttribute("aria-current"), null);
    assert.equal(
      await page.evaluate(() => (window as any).navigationProbe.getSnapshot().applicationRoute.viewId),
      "opencraft.im.people",
    );
    await page.screenshot({ path: resolve(output, theme + "-drag-held.png") });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(
      await row.evaluate((el) => getComputedStyle(el).backgroundColor),
      rest,
      "release must not revive pressed paint",
    );
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });

    // Fast native flick: don't flash before movement is classified, and don't
    // let the cancelled dwell timer revive either :hover or :active paint.
    const quick = page.getByRole("button", { name: "Navigation group 7", exact: true });
    await quick.evaluate((el) => (el.id = "quick-probe"));
    const quickBox = (await quick.boundingBox())!;
    const qx = quickBox.x + quickBox.width * 0.6,
      qy = quickBox.y + quickBox.height / 2;
    const { nodeId: quickId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#quick-probe" });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: qx, y: qy }] });
    await cdp.send("CSS.forcePseudoState", { nodeId: quickId, forcedPseudoClasses: ["active", "hover"] });
    assert.equal(await quick.getAttribute("data-touch-press"), "false");
    assert.equal(await quick.evaluate((el) => getComputedStyle(el).backgroundColor), rest);
    for (let i = 1; i <= 3; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: qx, y: qy - i * 20 }] });
      assert.equal(
        await quick.evaluate((el) => getComputedStyle(el).backgroundColor),
        rest,
        "quick scroll stays unhighlighted",
      );
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(180);
    assert.equal(await quick.getAttribute("data-touch-press"), "false");
    assert.equal(await quick.evaluate((el) => getComputedStyle(el).backgroundColor), rest);
    await cdp.send("CSS.forcePseudoState", { nodeId: quickId, forcedPseudoClasses: [] });

    // Explicit platform cancellation, native scroll and long-press handoff retire
    // only paint, not the event's default behavior.
    await row.dispatchEvent("pointerdown", {
      pointerId: 41,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    assert.equal(await row.getAttribute("data-touch-press"), "false");
    await row.dispatchEvent("pointercancel", { pointerId: 41, pointerType: "touch" });
    assert.equal(await row.getAttribute("data-touch-press"), "false");
    await row.dispatchEvent("pointerdown", {
      pointerId: 42,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    const menuAllowed = await row.evaluate((el) =>
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    assert.equal(menuAllowed, true, "do not hijack native context menus");
    assert.equal(await row.getAttribute("data-touch-press"), "false");
    await row.dispatchEvent("pointerdown", {
      pointerId: 43,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    });
    await stream.dispatchEvent("scroll");
    assert.equal(await row.getAttribute("data-touch-press"), "false");
    await page.waitForTimeout(180);
    assert.equal(await row.getAttribute("data-touch-press"), "false", "cancelled pending feedback cannot revive");
    // Real tap after cancellation must still open the intended conversation.
    await row.tap();
    await page.waitForFunction(
      () => (window as any).navigationProbe.getSnapshot().applicationRoute.resourceUri === "opencraft-channel:g3",
    );
    await page.locator('.im-channel-chat__conversation [contenteditable="true"]:visible').waitFor();
    assert.deepEqual(errors, []);
    results.push({
      theme,
      nativePan: true,
      delayedFeedback: true,
      immediateRetirement: true,
      quickFlickNoFlash: true,
      heldPaintCleared: true,
      noRouteDuringPan: true,
      subsequentTap: true,
      nativeMenuPreserved: true,
    });
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as any).__name = (value: unknown) => value;
  });
  await page.goto(server.resolvedUrls!.local[0]!);
  await page.getByRole("button", { name: "Open Inbox", exact: true }).click();
  const selected = page.getByRole("button", { name: "Navigation group 0", exact: true });
  await selected.click();
  await page.locator('.app-shell-master-detail[data-presentation="split"]').waitFor();
  assert.equal(await selected.getAttribute("aria-current"), "page");
  await page.waitForTimeout(180);
  const current = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
  await selected.hover();
  await page.waitForTimeout(180);
  assert.equal(
    await selected.evaluate((el) => getComputedStyle(el).backgroundColor),
    current,
    "current route selection survives hover",
  );
  const next = page.getByRole("button", { name: "Navigation group 1", exact: true });
  await page.mouse.move(1400, 0);
  await page.waitForTimeout(180);
  const nextRest = await next.evaluate((el) => getComputedStyle(el).backgroundColor);
  await next.hover();
  await page.waitForTimeout(180);
  const mouseHover = await next.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(mouseHover, nextRest, "real mouse still has hover feedback");
  await next.dispatchEvent("pointerdown", { pointerId: 76, pointerType: "touch", isPrimary: true, button: 0 });
  await next.dispatchEvent("pointercancel", { pointerId: 76, pointerType: "touch" });
  const desktopCdp = await context.newCDPSession(page);
  await desktopCdp.send("DOM.enable");
  await desktopCdp.send("CSS.enable");
  await next.evaluate((el) => (el.id = "hybrid-probe"));
  const desktopRoot = await desktopCdp.send("DOM.getDocument");
  const { nodeId: hybridId } = await desktopCdp.send("DOM.querySelector", {
    nodeId: desktopRoot.root.nodeId,
    selector: "#hybrid-probe",
  });
  await desktopCdp.send("CSS.forcePseudoState", { nodeId: hybridId, forcedPseudoClasses: ["hover"] });
  assert.equal(await page.evaluate(() => matchMedia("(any-hover: hover) and (any-pointer: fine)").matches), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.touchInteraction), "true");
  assert.equal(
    await next.evaluate((el) => getComputedStyle(el).backgroundColor),
    nextRest,
    "touch suppresses sticky hover even on hybrid hardware",
  );
  await page.waitForTimeout(180);
  assert.equal(await next.evaluate((el) => getComputedStyle(el).backgroundColor), nextRest);
  await desktopCdp.send("CSS.forcePseudoState", { nodeId: hybridId, forcedPseudoClasses: [] });
  const nextBox = (await next.boundingBox())!;
  await page.mouse.move(nextBox.x + 12, nextBox.y + 12);
  await page.waitForTimeout(180);
  assert.equal(
    await next.evaluate((el) => getComputedStyle(el).backgroundColor),
    mouseHover,
    "actual mouse movement restores hover",
  );
  await next.dispatchEvent("pointerdown", { pointerId: 77, pointerType: "touch", isPrimary: true, button: 0 });
  await next.dispatchEvent("pointercancel", { pointerId: 77, pointerType: "touch" });
  await next.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => (window as any).navigationProbe.getSnapshot().applicationRoute.resourceUri === "opencraft-channel:g1",
  );
  assert.equal(await next.getAttribute("aria-current"), "page");
  await page.screenshot({ path: resolve(output, "desktop-selection.png") });
  results.push({
    desktopSelection: true,
    hybridStickyHoverSuppressed: true,
    mouseHoverRestored: true,
    keyboardAfterTouchCancellation: true,
  });
  await context.close();
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: true, results, syntheticTransport: true, webkitStickyActiveModeled: true }));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
