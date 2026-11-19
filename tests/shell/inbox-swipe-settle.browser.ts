import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, type Page, type BrowserContext } from "playwright";
import { navigationLifecycleFixture } from "../fixtures/navigation-lifecycle";

// Actual Shell, Router, IM renderer and shared route-family retention. Only the
// account/channel transport is synthetic; no production data or inference.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/inbox-swipe-settle");
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
  cacheDir: ".local/inbox-swipe-vite",
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
      name: "inbox-swipe-fixture",
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
type Frame = { route: string; x: number; outgoing: boolean; departure: number };
async function drag(page: Page, context: BrowserContext, travel: number, label: string) {
  const live = page.locator(".page-stack > .page-stack__live");
  const box = (await live.boundingBox())!,
    x = box.x + box.width * 0.12,
    y = box.y + box.height * 0.48;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 10; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (box.width * travel * step) / 10, y }],
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(180); // Exercise distance, not the fast-flick policy.
  const held = await live.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
  assert.ok(Math.abs(held / box.width - travel) < 0.04, `drag follows finger: ${held}/${box.width}, ${travel}`);
  await page.screenshot({ path: resolve(output, label + "-held.png") });
  await page.evaluate(() => {
    (window as any).settleFrames = new Promise((resolve) => {
      const frames: Frame[] = [];
      const sample = () => {
        const live = document.querySelector(".page-stack > .page-stack__live")!,
          preview = document.querySelector(".page-stack > .page-stack__preview")!;
        frames.push({
          route: (window as any).navigationProbe.getSnapshot().applicationRoute.viewId,
          x: new DOMMatrixReadOnly(getComputedStyle(live).transform).m41,
          outgoing: preview.childElementCount > 0,
          departure: new DOMMatrixReadOnly(getComputedStyle(preview).transform).m41,
        });
        if (frames.length < 45) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(45);
  await page.screenshot({ path: resolve(output, label + "-settling.png") });
  const frames: Frame[] = await page.evaluate(() => (window as any).settleFrames);
  await writeFile(resolve(output, label + "-frames.json"), JSON.stringify({ width: box.width, held, frames }, null, 2));
  await cdp.detach();
  return { frames, held, width: box.width };
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    (window as any).__name = (value: unknown) => value;
  });
  await page.goto(server.resolvedUrls!.local[0]!);
  await page.getByRole("button", { name: "Open Inbox", exact: true }).tap();
  await page.getByRole("button", { name: "Navigation group 0", exact: true }).tap();
  const editor = page.locator('.im-channel-chat__conversation [contenteditable="true"]:visible');
  await editor.waitFor();
  await page.locator(".has-mobile-sidebar-gestures").waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLElement>(".page-stack > .page-stack__live")!.inert);
  await editor.fill("Keep the channel draft");
  await editor.blur();
  await page.locator(".page-stack > .page-stack__live .people-page--inbox").evaluate((el) => {
    (window as any).originalInbox = el;
  });
  const cancelled = await drag(page, context, 0.2, "cancel");
  assert.ok(cancelled.frames.every((frame) => frame.route === "opencraft.im.channel-chat"));
  assert.ok(
    cancelled.frames.some((frame) => frame.x > 1 && frame.x < cancelled.held - 1),
    "cancel needs intermediate frames",
  );
  assert.ok(Math.abs(cancelled.frames.at(-1)!.x) < 1);
  const returned = await drag(page, context, 0.65, "return");
  const departing = returned.frames.filter((frame) => frame.route === "opencraft.im.people" && frame.outgoing);
  assert.ok(departing.length >= 2, "accepted same-family return keeps inert outgoing pixels while settling");
  assert.ok(
    departing.some((frame) => frame.departure > returned.held + 1 && frame.departure < returned.width - 1),
    "return continues from held offset, not a snap",
  );
  assert.ok(Math.abs(returned.frames.at(-1)!.x) < 1 && !returned.frames.at(-1)!.outgoing);
  assert.equal(
    await page
      .locator(".page-stack > .page-stack__live .people-page--inbox")
      .evaluate((el) => el === (window as any).originalInbox),
    true,
  );
  await page.getByRole("button", { name: "Navigation group 0", exact: true }).tap();
  await editor.waitFor();
  assert.equal(await editor.innerText(), "Keep the channel draft");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(output, "restored.png") });
  await context.close();
  // Ordinary wide split selections remain in place: do not add page animations.
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktop = await desktopContext.newPage();
  await desktop.addInitScript(() => {
    (window as any).__name = (value: unknown) => value;
  });
  desktop.on("pageerror", (error) => errors.push(error.message));
  await desktop.goto(server.resolvedUrls!.local[0]!);
  await desktop.getByRole("button", { name: "Open Inbox", exact: true }).click();
  await desktop.getByRole("button", { name: "Navigation group 0", exact: true }).click();
  await desktop.locator('.app-shell-master-detail[data-presentation="split"]').waitFor();
  await desktop.getByRole("button", { name: "Navigation group 1", exact: true }).click();
  await desktop.waitForFunction(
    () => (window as any).navigationProbe.getSnapshot().applicationRoute.resourceUri === "opencraft-channel:g1",
  );
  assert.equal(await desktop.locator(".page-stack > .page-stack__live .people-page--inbox").count(), 1);
  const inPlace = await desktop.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        let count = 0;
        const sample = () => {
          const live = document.querySelector(".page-stack > .page-stack__live")!,
            preview = document.querySelector(".page-stack > .page-stack__preview")!;
          if (preview.childElementCount || Math.abs(new DOMMatrixReadOnly(getComputedStyle(live).transform).m41) > 1)
            return resolve(false);
          if (++count === 8) resolve(true);
          else requestAnimationFrame(sample);
        };
        sample();
      }),
  );
  assert.equal(inPlace, true);
  assert.deepEqual(errors, []);
  await desktop.screenshot({ path: resolve(output, "desktop-in-place.png") });
  await desktopContext.close();
  // A device starting with reduced motion still returns without an exit spring.
  const reducedContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const reducedPage = await reducedContext.newPage();
  await reducedPage.addInitScript(() => {
    (window as any).__name = (value: unknown) => value;
  });
  reducedPage.on("pageerror", (error) => errors.push(error.message));
  await reducedPage.goto(server.resolvedUrls!.local[0]!);
  await reducedPage.getByRole("button", { name: "Open Inbox", exact: true }).tap();
  await reducedPage.getByRole("button", { name: "Navigation group 0", exact: true }).tap();
  await reducedPage.locator('.im-channel-chat__conversation [contenteditable="true"]:visible').waitFor();
  const reduced = await reducedContext.newCDPSession(reducedPage);
  await reduced.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 45, y: 400 }] });
  await reduced.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300, y: 400 }] });
  await reduced.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await reducedPage.waitForFunction(
    () => (window as any).navigationProbe.getSnapshot().applicationRoute.viewId === "opencraft.im.people",
  );
  await reducedPage.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await reducedPage.locator(".page-stack__preview").evaluate((el) => el.childElementCount), 0);
  assert.deepEqual(errors, []);
  await reduced.detach();
  await reducedContext.close();
  console.log(
    JSON.stringify({
      passed: true,
      output,
      syntheticTransport: true,
      actualShellAndInbox: true,
      cancelFrames: cancelled.frames.length,
      returnFrames: departing.length,
      draftRetained: true,
      reducedMotion: true,
      desktopInPlace: true,
    }),
  );
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
