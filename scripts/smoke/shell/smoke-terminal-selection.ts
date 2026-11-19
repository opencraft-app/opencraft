import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/terminal-selection";
await mkdir(output, { recursive: true });
const negative = process.env.OPENCRAFT_TERMINAL_SELECTION_NEGATIVE === "1";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-terminal-selection",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "terminal-selection",
      enforce: "pre",
      transform(code, id) {
        if (!negative || !id.endsWith("/plugins/terminal/src/selection.ts")) return;
        const next = code.replace(
          "if (!enabled || contact || selectedHere()) return;",
          "if (!enabled || contact) return;",
        );
        assert.notEqual(next, code, "negative control must restore output rewriting selected nodes");
        return next;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/?")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-keyboard.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const reports = [];
async function copiedText(page: import("playwright").Page, expected: string) {
  let actual = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    actual = await page.evaluate(() => navigator.clipboard.readText());
    if (actual === expected) return actual;
    await page.waitForTimeout(25);
  }
  assert.equal(actual, expected, "native clipboard write completes");
  return actual;
}
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [320, 402, 1280])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: true,
        isMobile: width < 1000,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        (window as any).__name = (value: unknown) => value;
        document.addEventListener("DOMContentLoaded", () => (document.documentElement.dataset.uiDensity = "touch"));
      });
      await page.goto(vite.resolvedUrls!.local[0] + "?gesture");
      const host = page.locator(".terminal-panel__host");
      await host.locator(".xterm-rows").waitFor();
      await page.evaluate((theme) => (window as any).fixture.setThemePreference(theme), theme);
      await page.waitForFunction(
        () => document.querySelector(".terminal-panel__host")?.getAttribute("data-native-selection") === "true",
      );
      const original = await host.locator(".xterm").elementHandle();
      const writes = await page.evaluate(() => (window as any).fixture.writes.length);
      const row = host.locator("[data-terminal-native-text] > :first-child"),
        bounds = await row.boundingBox();
      assert(bounds);
      const geometry = await host.evaluate((node) => {
        const source = node.querySelector(".xterm-rows")!,
          native = node.querySelector("[data-terminal-native-text]")!;
        let worst = 0;
        for (let index = 0; index < source.children.length; index++) {
          const pairs = [
            [source.children[index]!, native.children[index]!],
            ...[...source.children[index]!.children].map((child, at) => [child, native.children[index]!.children[at]!]),
          ];
          for (const [a, b] of pairs) {
            const x = a!.getBoundingClientRect(),
              y = b!.getBoundingClientRect();
            worst = Math.max(
              worst,
              ...(["left", "top", "width", "height"] as const).map((key) => Math.abs(x[key] - y[key])),
            );
          }
        }
        return { worst, terminalCount: node.querySelectorAll(".xterm").length };
      });
      assert(geometry.worst < 1, "native text preserves xterm glyph geometry: " + JSON.stringify(geometry));
      assert.equal(geometry.terminalCount, 1);
      assert.equal(await row.evaluate((node) => getComputedStyle(node).userSelect), "text");
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: bounds.x + 15, y: bounds.y + 8, id: 1 }],
      });
      // Linux headless has no iOS/Android native selection UI. Verify that the
      // physical hold and native contextmenu default are unclaimed, then exercise
      // the same browser Selection/Range used by native handles (not a fake menu).
      await page.waitForTimeout(600);
      assert.equal(await page.getByRole("menu").count(), 0);
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert(
        await row.evaluate((node) =>
          node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
        ),
      );
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      // Let pending font/layout work settle before establishing a native range.
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        (document.activeElement as HTMLElement)?.blur();
      });
      await page.waitForTimeout(30);
      const selected = await host.evaluate((node) => {
        const rows = node.querySelector("[data-terminal-native-text]")!;
        const first = rows.children[0]!.firstChild!.firstChild!,
          second = rows.children[1]!.firstChild!.firstChild!;
        const selection = getSelection()!;
        selection.setBaseAndExtent(first, 0, second, Math.min(12, second.textContent!.length));
        return selection.toString();
      });
      assert(selected.includes("Terminal output"));
      await page.waitForFunction(
        () => document.querySelector(".terminal-panel__host")?.getAttribute("data-sidebar-gesture") === "ignore",
      );
      const anchor = await page.evaluateHandle(() => getSelection()!.anchorNode);
      await page.evaluate(() => (window as any).fixture.emit("\r\nOUTPUT_DURING_NATIVE_SELECTION\r\n"));
      await page.evaluate(() => (window as any).fixture.emit("\x1b[6n"));
      await page.waitForFunction(() =>
        (window as any).fixture.writes.some((value: string) => /^\x1b\[\d+;\d+R$/.test(value)),
      );
      await page.screenshot({ path: output + "/" + width + "-" + theme + ".png" });
      await page.evaluate(
        (theme) => (window as any).fixture.setThemePreference(theme === "light" ? "dark" : "light"),
        theme,
      );
      await page.waitForTimeout(80);
      assert.equal(
        await page.evaluate(() => getSelection()?.toString()),
        selected,
        "incoming output and theme cannot replace selected text nodes",
      );
      assert(await page.evaluate((old) => getSelection()?.anchorNode === old, anchor));
      assert(
        !(await host.locator("[data-terminal-native-text]").innerText()).includes("OUTPUT_DURING_NATIVE_SELECTION"),
      );
      assert(
        (await host.locator(".xterm-rows").innerText()).includes("OUTPUT_DURING_NATIVE_SELECTION"),
        "the original terminal keeps processing output behind the held native text",
      );
      await page.keyboard.press("Control+c");
      assert.equal(await copiedText(page, selected), selected, "browser copy uses the native DOM range");
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await page.waitForFunction(() =>
        document.querySelector("[data-terminal-native-text]")?.textContent?.includes("OUTPUT_DURING_NATIVE_SELECTION"),
      );
      assert.equal(await host.getAttribute("data-sidebar-gesture"), "vertical-pan");
      assert(await host.locator(".xterm").evaluate((node, old) => node === old, original));
      assert.equal(
        await page.evaluate(() => (window as any).fixture.writes.length),
        writes + 1,
        "selection sends no input; the terminal still answers the application cursor query",
      );
      await page.evaluate(() => (window as any).fixture.emit("\r\n中文 é 😀\r\n"));
      await page.waitForFunction(() =>
        document.querySelector("[data-terminal-native-text]")?.textContent?.includes("中文 é 😀"),
      );
      const unicode = await host.evaluate((node) => {
        const row = [...node.querySelectorAll("[data-terminal-native-text] > div")].find((row) =>
          row.textContent?.includes("中文 é 😀"),
        )!;
        const range = document.createRange();
        range.selectNodeContents(row);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        return getSelection()!.toString();
      });
      assert(unicode.includes("中文 é 😀"));
      await page.keyboard.press("Control+c");
      assert.equal(
        await copiedText(page, unicode),
        unicode,
        "native copy preserves wide, combined and supplementary characters",
      );
      await page.getByRole("button", { name: "Show keyboard", exact: true }).tap();
      assert.equal(
        await page.evaluate(() => getSelection()?.toString() ?? ""),
        "",
        "explicit input ends native selection",
      );
      await page.waitForFunction(() => {
        const rows = document.querySelector(".xterm-rows")!,
          source = rows.querySelector(".xterm-cursor");
        if (!source?.parentElement) return false;
        const row = [...rows.children].indexOf(source.parentElement),
          cell = [...source.parentElement.children].indexOf(source);
        const cursor = document.querySelector("[data-terminal-native-text]")?.children[row]?.children[cell] as
          HTMLElement | undefined;
        return !!cursor?.style.boxShadow.includes("inset");
      });
      await page.keyboard.type("pwd");
      assert.equal(
        await page.evaluate((count) => (window as any).fixture.writes.slice(count).join(""), writes + 1),
        "pwd",
      );
      // Mouse-reporting applications retain xterm's own input/selection rules.
      await page.evaluate(() => (window as any).fixture.emit("\x1b[?1049h\x1b[?1000h\x1b[2J\x1b[HMouse application"));
      await page.waitForFunction(
        () => document.querySelector(".terminal-panel__host")?.getAttribute("data-native-selection") === "false",
      );
      assert.equal(await host.getAttribute("data-sidebar-gesture"), "ignore");
      await page.evaluate(() => (window as any).fixture.emit("\x1b[?1000l\x1b[?1049l"));
      await page.waitForFunction(
        () => document.querySelector(".terminal-panel__host")?.getAttribute("data-native-selection") === "true",
      );
      assert.deepEqual(errors, []);
      reports.push({
        width,
        theme,
        nativeRange: true,
        browserCopy: true,
        noCustomMenuOrDialog: true,
        nativeTextStable: true,
        terminalContinuesParsing: true,
        terminalRetained: true,
        mouseApplicationPreserved: true,
        physicalMobileUiVerified: false,
      });
      await context.close();
    }
  await writeFile(output + "/report.json", JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ ok: true, reports }));
} finally {
  await browser?.close();
  await vite.close();
}
