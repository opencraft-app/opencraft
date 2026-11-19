import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium, type Page, type BrowserContext } from "playwright";
import { navigationLifecycleFixture } from "../fixtures/navigation-lifecycle";

// Actual Shell, Router, IM renderer and shared route-family retention. Only the
// account/channel transport is synthetic; no production data or inference.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/inbox-page-transition");
const source = navigationLifecycleFixture
  .replace("canManageMembers:false", "canManageMembers:true,canRename:true")
  .replace(
    "return{members:[]}",
    "return{members:Array.from({length:18},(_,i)=>({actorId:'person'+i,actorKind:'human',displayName:'Member '+i,role:i===0?'owner':'member'}))}",
  )
  .replace(
    "if(method==='opencraft/channels/list')",
    "if(method==='opencraft/channels/group/rename')return await new Promise(resolve=>{window.finishRename=()=>resolve({...groups[2],title:p.title})});if(method==='opencraft/channels/group/candidates/search')return{candidates:[]};if(method==='opencraft/channels/list')",
  )
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
  cacheDir: ".local/inbox-inspector-vite",
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
const nestedLive = ".nested-navigation > .page-stack > .page-stack__live";
async function settled(page: Page) {
  await page.waitForFunction((selector) => {
    const live = document.querySelector<HTMLElement>(selector);
    return live && !live.inert && !live.previousElementSibling?.childElementCount;
  }, nestedLive);
}
async function capture(page: Page) {
  await page.evaluate((selector) => {
    (window as any).frames = new Promise((resolve) => {
      const frames: number[] = [];
      const next = () => {
        const node = document.querySelector(selector)!;
        frames.push(new DOMMatrixReadOnly(getComputedStyle(node).transform).m41);
        if (frames.length < 70) requestAnimationFrame(next);
        else resolve(frames);
      };
      requestAnimationFrame(next);
    });
  }, nestedLive);
}
async function drag(page: Page, context: BrowserContext, travel: number, label: string) {
  const live = page.locator(nestedLive),
    box = (await live.boundingBox())!;
  const x = box.x + box.width * 0.12,
    y = box.y + box.height * 0.5;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (box.width * travel * i) / 10, y }],
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(160);
  const held = await live.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
  assert.ok(Math.abs(held / box.width - travel) < 0.05, `nested gesture tracks finger ${held}/${box.width}`);
  assert.equal(
    await page.evaluate(() => (window as any).navigationProbe.getSnapshot().applicationRoute.resourceUri),
    "opencraft-channel:g2",
    "modal does not navigate background",
  );
  await page.screenshot({ path: resolve(output, label + "-held.png") });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await settled(page);
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const variant of [
    { width: 390, theme: "light", reduced: false },
    { width: 390, theme: "dark", reduced: false },
    { width: 1440, theme: "light", reduced: true },
  ]) {
    const { width, theme, reduced } = variant;
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: true,
      isMobile: width === 390,
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      (window as any).__name = (v: unknown) => v;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?theme=" + theme);
    await page.getByRole("button", { name: "Open Inbox", exact: true }).click();
    const row = page.getByRole("button", { name: "Navigation group 2", exact: true });
    await row.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector(".im-channel-chat__conversation") &&
        !document.querySelector<HTMLElement>(".page-stack > .page-stack__live")!.inert,
    );
    if (width === 390)
      assert.equal(
        await page.evaluate(() => document.activeElement?.className),
        "app-shell-master-detail__detail",
        "entry focus is restored after motion",
      );
    assert.equal(
      await page.getByRole("button", { name: "More options", exact: true }).count(),
      0,
      "group header has no unrelated assistant menu",
    );
    const editor = page.locator(".im-channel-chat__conversation [contenteditable=true]:visible");
    await editor.fill("Preserve chat draft");
    await page.getByRole("button", { name: "Group settings", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Group details", exact: true });
    await modal.waitFor();
    const all = modal.getByRole("button", { name: /View all members/ });
    await all.waitFor();
    const infoScroll = page.locator(".nested-navigation .im-channel-group-dialog__page:visible .settings-panel__body");
    await infoScroll.evaluate((el) => {
      (window as any).infoScroll = el;
      el.scrollTop = 40;
      (window as any).infoTop = el.scrollTop;
    });
    await capture(page);
    await all.click();
    const frames: number[] = await page.evaluate(() => (window as any).frames);
    if (reduced) assert.ok(frames.every((x) => Math.abs(x) < 1));
    else
      assert.ok(
        frames.filter((x) => x > 1 && x < width - 1).length > 1,
        "shared forward motion has intermediate frames",
      );
    await page.getByRole("dialog", { name: "Members", exact: true }).waitFor();
    await settled(page);
    await page.keyboard.press("Escape");
    await settled(page);
    await modal.waitFor();
    assert.equal(
      await infoScroll.evaluate((el) => el === (window as any).infoScroll && el.scrollTop === (window as any).infoTop),
      true,
      "parent DOM/scroll retained",
    );
    assert.equal(
      await all.evaluate((el) => el === document.activeElement),
      true,
      "return focus restores activating row",
    );
    if (!reduced) {
      await all.click();
      await settled(page);
      await drag(page, context, 0.2, theme + "-cancel");
      await page.getByRole("dialog", { name: "Members", exact: true }).waitFor();
      await drag(page, context, 0.65, theme + "-back");
      await modal.waitFor();
    }
    await modal.getByRole("button", { name: /Group name/ }).click();
    await settled(page);
    const name = page
      .getByRole("dialog", { name: "Edit name", exact: true })
      .getByRole("textbox", { name: "Group name", exact: true });
    assert.equal(await name.evaluate((el) => el === document.activeElement), true, "edit focus waits for motion");
    await name.fill("Changed name");
    // Explicit cancel abandons the edit without closing the inspector.
    await name.press("Escape");
    await settled(page);
    await modal.waitFor();
    await modal.getByRole("button", { name: /Group name/ }).click();
    await settled(page);
    await name.fill("Saved name");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).finishRename === "function");
    await page.keyboard.press("Escape");
    assert.equal(
      await page.getByRole("dialog", { name: "Edit name", exact: true }).count(),
      1,
      "pending write blocks dismissal",
    );
    await page.evaluate(() => (window as any).finishRename());
    await modal.waitFor();
    await settled(page);
    await page.screenshot({ path: resolve(output, theme + "-" + width + ".png") });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await editor.innerText(), "Preserve chat draft");
    assert.equal(
      await page
        .getByRole("button", { name: "Group settings", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
      "close restores trigger",
    );
    if (width === 390) {
      await page.evaluate(() => (window as any).navigationProbe.returnToParent());
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Navigation group 2");
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, ...variant }));
    await context.close();
  }
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
