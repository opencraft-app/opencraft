import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_TOUCH_TITLE_OUTPUT ?? ".local/touch-title";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-touch-title",
  esbuild: { jsx: "automatic", target: "esnext" },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react-intl",
      "@tanstack/react-query",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-alert-dialog",
      "@deepseek-ai/cordis",
      "@radix-ui/react-context-menu",
      "marked",
      "mermaid",
      "motion/react",
      "react-dom",
      "sonner",
      "tslib",
    ],
  },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "touch-title-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-conversation-title.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const scenario of [
    { width: 320, touch: true, density: "auto", theme: "light" },
    { width: 390, touch: true, density: "auto", theme: "dark" },
    { width: 820, touch: true, density: "on", theme: "light" },
    { width: 1440, touch: false, density: "on", theme: "dark" },
    { width: 390, touch: true, density: "off", theme: "light" },
    { width: 1440, touch: false, density: "off", theme: "dark" },
  ]) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: 844 },
      hasTouch: scenario.touch,
      isMobile: scenario.width < 600,
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
    });
    try {
      await page.goto(vite.resolvedUrls!.local[0]!);
      await page.getByLabel("Draft").waitFor({ timeout: 60000 });
      await page.evaluate(({ density, theme }) => {
        const fixture = (window as any).fixture;
        fixture.setDensity(density);
        fixture.setThemePreference(theme);
      }, scenario);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(
        (density) => document.documentElement.dataset.uiDensity === density,
        scenario.density === "off" ? "compact" : "touch",
      );
      const title = page.locator(".thread-header-title");
      assert.equal(
        await title.isVisible(),
        true,
        `conversation title must remain visible: ${JSON.stringify(scenario)}`,
      );
      if (scenario.width === 320) {
        const suppression = await page.addStyleTag({
          content:
            'html:root[data-ui-density="touch"] .app-shell-root .app-shell-header[data-app-shell-conversation-header="true"] .thread-header-title { display: none; }',
        });
        assert.equal(await title.isVisible(), false, "negative control reproduces retired touch-title suppression");
        await suppression.evaluate((element) => element.remove());
        await title.waitFor({ state: "visible" });
      }
      await page.getByLabel("Draft").fill("Retained across title and density changes");
      await page.evaluate(() => {
        (window as any).editor = document.querySelector('[aria-label="Draft"]');
        (window as any).fixture.setTitle("A long conversation title / 很长的会话标题 / ".repeat(12));
        (window as any).fixture.setProject("workspace/path/".repeat(12));
      });
      await page.waitForFunction(() =>
        document.querySelector(".thread-header-copy strong")!.textContent!.startsWith("A long"),
      );
      const geometry = await page.evaluate(() => {
        const heading = document.querySelector<HTMLElement>(".thread-header-copy strong")!;
        const title = document.querySelector(".thread-header-title")!.getBoundingClientRect();
        const controls = [...document.querySelectorAll<HTMLElement>(".app-shell-header button, .shell-chrome button")]
          .filter((button) => button.getBoundingClientRect().width > 0 && !button.closest(".thread-header-title"))
          .map((button) => {
            const r = button.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          });
        return {
          title: { left: title.left, right: title.right, top: title.top, bottom: title.bottom },
          clientWidth: heading.clientWidth,
          scrollWidth: heading.scrollWidth,
          overflow: getComputedStyle(heading).textOverflow,
          controls,
        };
      });
      assert.ok(geometry.clientWidth > 0 && geometry.scrollWidth > geometry.clientWidth, JSON.stringify(geometry));
      assert.equal(geometry.overflow, "ellipsis");
      assert.ok(geometry.title.left >= 0 && geometry.title.right <= scenario.width + 1, JSON.stringify(geometry));
      for (const button of geometry.controls) {
        if (button.bottom <= geometry.title.top || button.top >= geometry.title.bottom) continue;
        assert.ok(
          button.right <= geometry.title.left + 1 || button.left >= geometry.title.right - 1,
          JSON.stringify(geometry),
        );
      }
      await page.locator("[data-scroll]").evaluate((element) => {
        element.scrollTop = 240;
      });
      assert.equal(await title.isVisible(), true);
      if (scenario.density !== "off") {
        // A device top inset (iOS PWA / full-screen WebView) moves the header
        // below the status area while the transcript bleeds under it. The
        // reading band must start at the physical top so text never meets it.
        const inset = await page.addStyleTag({ content: ":root { --safe-layout-inset-top: 47px; }" });
        const band = await page.evaluate(() => {
          const header = document.querySelector<HTMLElement>('.app-shell-header[data-app-shell-conversation-header="true"]')!;
          const before = getComputedStyle(header, "::before");
          const top = header.getBoundingClientRect().top;
          return { headerTop: top, bandTop: top + parseFloat(before.top), bandBottom: top + parseFloat(before.top) + parseFloat(before.height) };
        });
        assert.equal(band.headerTop, 47, JSON.stringify(band));
        assert.ok(Math.abs(band.bandTop) < 0.5, `reading band must cover the status area: ${JSON.stringify(band)}`);
        assert.ok(band.bandBottom > band.headerTop + 47, JSON.stringify(band));
        await inset.evaluate((element) => element.remove());
      }
      await page.screenshot({ path: `${output}/${scenario.width}-${scenario.density}-${scenario.theme}.png` });
      await page.evaluate(() => {
        (window as any).fixture.setFull(true);
        (window as any).fixture.setPreview(true);
      });
      await page.waitForFunction(() =>
        document.querySelector("[data-app-shell-primary-header]")!.hasAttribute("inert"),
      );
      assert.equal(await title.isVisible(), false, "a foreground tool must not show the covered conversation's title");
      await page.evaluate(() => {
        (window as any).fixture.setFull(false);
        (window as any).fixture.setPreview(false);
      });
      await title.waitFor({ state: "visible" });
      assert.equal(await page.getByLabel("Draft").inputValue(), "Retained across title and density changes");
      assert.equal(await page.getByLabel("Draft").evaluate((element) => element === (window as any).editor), true);
      assert.deepEqual(errors, []);
      evidence.push({ ...scenario, geometry, retainedDraft: true, errors });
    } finally {
      await context.close();
    }
  }
  await writeFile(output + "/result.json", JSON.stringify(evidence, null, 2));
  console.log("PASS touch/compact conversation titles, long-text geometry, tool foreground and retained drafts");
} finally {
  await browser?.close();
  await vite.close();
}
