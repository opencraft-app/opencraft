import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { navigationLifecycleFixture } from "../fixtures/navigation-lifecycle";

// Actual Shell, Router, IM renderer and shared route-family retention. Only the
// account/channel transport is synthetic; no production data or inference.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/inbox-page-transition");
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
  cacheDir: ".local/inbox-page-transition-vite",
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
type Sample = { x: number; preview: boolean; previewX: number; route: string; inert: boolean };
async function record(page: Page) {
  await page.evaluate(() => {
    (window as any).transitionFrames = new Promise((resolve) => {
      const frames: Sample[] = [];
      const sample = () => {
        const live = document.querySelector(".page-stack > .page-stack__live")! as HTMLElement;
        const preview = document.querySelector(".page-stack > .page-stack__preview")!;
        frames.push({
          x: new DOMMatrixReadOnly(getComputedStyle(live).transform).m41,
          preview: !!preview.childElementCount,
          previewX: new DOMMatrixReadOnly(getComputedStyle(preview).transform).m41,
          inert: live.inert,
          route: (window as any).navigationProbe.getSnapshot().applicationRoute.viewId,
        });
        if (frames.length < 120) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
  });
}
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
  for (const width of [390, 700, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: width < 800,
      isMobile: width < 800,
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
    });
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.getByRole("button", { name: "Open Inbox", exact: true }).click();
    await page.locator(".app-shell-master-detail").waitFor();
    await page.locator(".people-stream").evaluate((el) => {
      el.scrollTop = 70;
      (window as any).originalList = el;
    });
    const split = (await page.locator(".app-shell-master-detail").getAttribute("data-presentation")) === "split";
    await record(page);
    await page.getByRole("button", { name: "Navigation group 2", exact: true }).click();
    const frames: Sample[] = await page.evaluate(() => (window as any).transitionFrames);
    await writeFile(resolve(output, width + "-enter-frames.json"), JSON.stringify(frames));
    const moving = frames.filter(
      (f) => f.route === "opencraft.im.channel-chat" && f.preview && f.x > 1 && f.x < width - 1,
    );
    if (split)
      assert.equal(
        frames.some((f) => f.preview || Math.abs(f.x) > 1),
        false,
        "wide selection remains in place",
      );
    else assert.ok(moving.length >= 2, "narrow forward navigation uses shared page motion");
    assert.ok(!frames.at(-1)!.inert && !frames.at(-1)!.preview && Math.abs(frames.at(-1)!.x) < 1);
    const editor = page.locator('.im-channel-chat__conversation [contenteditable="true"]:visible');
    await editor.waitFor();
    await editor.fill("Retain group draft");
    await editor.blur();
    if (!split) {
      await record(page);
      await page.evaluate(() => (window as any).navigationProbe.returnToParent());
      const back: Sample[] = await page.evaluate(() => (window as any).transitionFrames);
      await writeFile(resolve(output, width + "-return-frames.json"), JSON.stringify(back));
      assert.ok(
        back.some((f) => f.route === "opencraft.im.people" && f.preview && f.previewX > 1 && f.previewX < width - 1),
        "button/router return also animates",
      );
      assert.equal(
        await page.locator(".people-stream").evaluate((el) => el === (window as any).originalList),
        true,
        "do not remount the collection",
      );
      assert.equal(await page.locator(".people-stream").evaluate((el) => el.scrollTop), 70, "list scroll preserved");
      await page.getByRole("button", { name: "Navigation group 2", exact: true }).click();
      await editor.waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLElement>(".page-stack > .page-stack__live")!.inert);
      assert.equal(await editor.innerText(), "Retain group draft");
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(output, width + "-settled.png") });
    results.push({ width, split, enterFrames: moving.length, draftAndScroll: !split });
    await context.close();
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as any).__name = (value: unknown) => value;
  });
  await page.goto(server.resolvedUrls!.local[0]!);
  await page.getByRole("button", { name: "Open Inbox", exact: true }).tap();
  await record(page);
  await page.getByRole("button", { name: "Navigation group 0", exact: true }).tap();
  const reduced: Sample[] = await page.evaluate(() => (window as any).transitionFrames);
  assert.ok(
    reduced.every((f) => !f.preview && Math.abs(f.x) < 1),
    "respect reduced motion",
  );
  await context.close();
  console.log(
    JSON.stringify({ passed: true, results, reducedMotion: true, sharedRouteStack: true, syntheticTransport: true }),
  );
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
