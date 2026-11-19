import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { navigationLifecycleFixture } from "../fixtures/navigation-lifecycle";

const root = process.cwd();
const output = resolve(process.env.OPENCRAFT_CHROME_OUTPUT ?? ".local/route-chrome");
const baseline = process.env.OPENCRAFT_CHROME_BASELINE;
const baselineFiles = new Set([
  "apps/workbench-web/src/components/app-shell.tsx",
  "apps/workbench-web/src/components/app-shell-header.tsx",
  "apps/workbench-web/src/chrome-actions/sidebar-toggle-button.tsx",
  "apps/workbench-web/src/components/route-stack-motion.scss",
  "apps/workbench-web/src/styles/app.scss",
]);
const vite = await createServer({
  root,
  configFile: false,
  publicDir: root + "/apps/workbench-web/public",
  cacheDir: output + "/vite-cache",
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: {
    include: [
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
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "motion/react",
      "@tanstack/react-query",
      "react-intl",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-alert-dialog",
      "tslib",
    ],
  },
  plugins: [
    {
      name: "route-chrome-proof",
      resolveId: (id) => (id === "/navigation-probe.tsx" ? id : null),
      load(id) {
        if (id === "/navigation-probe.tsx") return navigationLifecycleFixture;
        const file = relative(root, id.split("?")[0]!);
        if (baseline && baselineFiles.has(file))
          return execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" });
        return null;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes("text/html")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/navigation-probe.tsx"></script>',
          );
        });
      },
    },
  ],
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let activePage: Page | undefined;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const scenario of [
    { name: "desktop", width: 1440, docked: true, touch: false, theme: "light", reduced: false },
    { name: "collapsed-dark", width: 1280, docked: false, touch: false, theme: "dark", reduced: false },
    { name: "wide-touch", width: 1280, docked: false, touch: true, theme: "light", reduced: false },
    { name: "mobile", width: 390, docked: false, touch: true, theme: "light", reduced: false },
    { name: "mobile-reduced", width: 390, docked: false, touch: true, theme: "dark", reduced: true },
  ].filter((item) => !process.env.OPENCRAFT_CHROME_CASE || item.name === process.env.OPENCRAFT_CHROME_CASE)) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: 844 },
      hasTouch: scenario.touch,
      isMobile: scenario.width < 640,
    });
    const page = await context.newPage(),
      errors: string[] = [];
    activePage = page;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
    });
    await page.emulateMedia({ reducedMotion: scenario.reduced ? "reduce" : "no-preference" });
    await page.goto(vite.resolvedUrls!.local[0]! + `?theme=${scenario.theme}${scenario.docked ? "&docked" : ""}`);
    await page.getByRole("button", { name: "Open Inbox", exact: true }).click();
    await page
      .getByRole("button", { name: /Navigation group 0\b/ })
      .first()
      .waitFor();
    if (scenario.touch)
      await page.evaluate(() => {
        document.documentElement.dataset.uiDensity = "touch";
      });
    const settle = async () => {
      await page.waitForFunction(() => {
        const live = document.querySelector<HTMLElement>(".page-stack > .page-stack__live");
        return live && !live.style.transform && !live.inert;
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    await settle();
    await page.evaluate(() => {
      const w = window as any;
      w.chromeFrames = [];
      w.chromeStage = "idle";
      w.chromeSampling = true;
      const rect = (node: Element | null) => {
        if (!node) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const sharedToggle = () =>
        document.querySelector(".shell-chrome [data-app-shell-sidebar-trigger], [data-sidebar-toggle-stationary]");
      w.originalToggle = sharedToggle();
      const sample = () => {
        const live = document.querySelector<HTMLElement>(".page-stack > .page-stack__live");
        const header = live?.querySelector(".app-shell-header") ?? null;
        const brand =
          document.querySelector(".shell-chrome .application-brand") ??
          live?.querySelector(".app-shell-header__window-controls .application-brand") ??
          null;
        const toggle = sharedToggle();
        w.chromeFrames.push({
          stage: w.chromeStage,
          page: rect(live),
          header: rect(header),
          brand: rect(brand),
          toggle: rect(toggle),
          sameToggle: toggle === w.originalToggle,
          transform: live?.style.transform,
          snapshotShellControls: document.querySelectorAll(
            ".page-stack__preview .application-brand, .page-stack__preview [data-sidebar-toggle-stationary]",
          ).length,
        });
        if (w.chromeSampling) requestAnimationFrame(sample);
      };
      sample();
    });
    await page.evaluate(() => {
      (window as any).chromeStage = "enter";
    });
    await page
      .getByRole("button", { name: /Navigation group 0\b/ })
      .first()
      .click();
    await page.locator(".im-channel-chat__conversation").waitFor();
    await settle();
    const editor = page.locator('.im-channel-chat__conversation [contenteditable="true"]').first();
    await editor.fill("Retained draft, not submitted");
    // The actual PageHeader and actual IM Composer are visible in these captures.
    await page.screenshot({ path: resolve(output, `${scenario.name}-chat.png`) });
    await page.evaluate(() => {
      (window as any).chromeStage = "return";
    });
    await page.locator(".page-stack > .page-stack__live [data-navigation-return] .history-button").click();
    await page.locator(".page-stack > .page-stack__live .people-page--inbox").waitFor();
    await settle();
    await page.screenshot({ path: resolve(output, `${scenario.name}-inbox.png`) });
    // Re-enter, then interrupt return with another child. No old snapshot or
    // late renderer may move Shell chrome or take back the accepted destination.
    await page.evaluate(() => {
      (window as any).chromeStage = "interrupt";
    });
    await page
      .getByRole("button", { name: /Navigation group 0\b/ })
      .first()
      .click();
    await settle();
    await editor.waitFor();
    assert.equal(await editor.innerText(), "Retained draft, not submitted");
    await page.locator(".page-stack > .page-stack__live [data-navigation-return] .history-button").click();
    await page.evaluate(() =>
      (window as any).navigationProbe.openExtensionView("opencraft.im.channel-chat", "opencraft-channel:g1"),
    );
    await settle();
    await page.waitForFunction(() =>
      document
        .querySelector(".page-stack > .page-stack__live .app-shell-header__route")
        ?.textContent?.includes("Navigation group 1"),
    );
    if (scenario.width >= 640) {
      await page.evaluate(() => {
        (window as any).chromeStage = "sidebar-resize";
        (window as any).setSidebarFixture(true);
      });
      await page.setViewportSize({ width: scenario.width - 80, height: 844 });
      await page.waitForTimeout(650); // Observe the real existing sidebar spring, not an application delay.
      await page.evaluate(() => {
        (window as any).setSidebarFixture(false);
      });
      await page.waitForTimeout(650);
      const shellSurvivesPageSuppression = await page.evaluate(() => {
        // Exercise the real eager Shell selector without another tool/session.
        // Full-width tool presentation may suppress page chrome, not Shell's
        // independent navigation home.
        const probe = document.createElement("div");
        probe.className = "right-panel-content";
        probe.dataset.mobilePanel = "true";
        document.querySelector(".app-shell-root")!.append(probe);
        const visible = document.querySelector(".shell-chrome")!.getBoundingClientRect().height > 0;
        probe.remove();
        return visible;
      });
      assert.ok(shellSurvivesPageSuppression, "page toolbar suppression cannot hide persistent Shell navigation");
    }
    const frames = await page.evaluate(() => {
      const w = window as any;
      w.chromeSampling = false;
      return w.chromeFrames;
    });
    await writeFile(
      resolve(output, `${scenario.name}-frames.json`),
      JSON.stringify({ scenario, errors, frames }, null, 2),
    );
    const valid = frames.filter((f: any) => f.page?.width > 0 && f.header?.width > 0);
    assert.ok(valid.length > 10);
    for (const f of valid) {
      assert.ok(
        Math.abs(f.header.x - f.page.x) <= 0.5 && Math.abs(f.header.width - f.page.width) <= 0.5,
        "PageHeader must keep its local coordinate frame: " + JSON.stringify(f),
      );
      assert.ok(
        Math.abs(f.header.y - f.page.y) <= 0.5,
        "safe top is allocated once for ordinary pages: " + JSON.stringify(f),
      );
      if (scenario.width >= 640) {
        const initial = valid[0]!;
        assert.ok(
          Math.abs(f.toggle.y + f.toggle.height / 2 - (f.header.y + f.header.height / 2)) <= 0.5,
          "Shell controls must stay in the top toolbar, not just at a stable wrong position: " + JSON.stringify(f),
        );
        assert.ok(f.sameToggle, "shared control must not remount during route or pane changes");
        assert.ok(
          Math.abs(f.toggle.x - initial.toggle.x) <= 0.5 && Math.abs(f.toggle.y - initial.toggle.y) <= 0.5,
          "Shell navigation must not follow route translation: " + JSON.stringify(f),
        );
        assert.equal(f.snapshotShellControls, 0, "outgoing page snapshot cannot contain Shell chrome");
        if (!scenario.touch) assert.ok(Math.abs(f.brand.x - initial.brand.x) <= 0.5, JSON.stringify(f));
      }
    }
    assert.deepEqual(errors, []);
    evidence.push({
      scenario: scenario.name,
      frames: valid.length,
      stablePageFrame: true,
      stableShellNavigation: scenario.width >= 640,
      retainedDraft: true,
      interruptedReturn: true,
      errors,
    });
    await context.close();
  }
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(output, "failure.png") });
    await writeFile(
      resolve(output, "failure.json"),
      JSON.stringify(
        await activePage.evaluate(() => ({
          route: (window as any).navigationProbe?.getSnapshot(),
          frames: (window as any).chromeFrames,
          text: document.body.innerText.slice(0, 4000),
        })),
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await vite.close();
}
