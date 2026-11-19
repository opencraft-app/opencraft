import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

// Real terminal renderer, application CSS and keyboard/IME handlers; only the
// PTY is a synthetic echo. Never attach to a user's terminal or execute commands.
const output = process.env.OPENCRAFT_TERMINAL_CURSOR_DIR ?? "/tmp/terminal-cursor";
await mkdir(output, { recursive: true });
const negative = process.env.OPENCRAFT_TERMINAL_CURSOR_NEGATIVE === "1";
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-terminal-cursor",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "terminal-cursor-fixture",
      enforce: "pre",
      transform(code, id) {
        if (!negative || !id.endsWith("/plugins/terminal/src/selection.scss")) return;
        assert.ok(code.includes("caret-color: transparent;"));
        return code.replace("caret-color: transparent;", "caret-color: auto;");
      },
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/terminal-cursor.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const reports: unknown[] = [];
try {
  await server.listen();
  const engine = process.env.OPENCRAFT_TERMINAL_ENGINE === "webkit" ? webkit : chromium;
  browser = await engine.launch({ headless: true });
  for (const { width, touch } of [
    { width: 320, touch: true },
    { width: 390, touch: true },
    { width: 1280, touch: true },
    { width: 390, touch: false },
    { width: 1280, touch: false },
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      hasTouch: touch,
      isMobile: touch && width < 1000,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(
      ({ touch }) => {
        (window as any).__name = (v: unknown) => v;
        document.addEventListener(
          "DOMContentLoaded",
          () => (document.documentElement.dataset.uiDensity = touch ? "touch" : "compact"),
        );
      },
      { touch },
    );
    await page.goto(server.resolvedUrls!.local[0] + "?touch=" + touch);
    await page.locator(touch ? ".terminal-native-text" : ".xterm-rows").waitFor();
    const helper = page.locator(".xterm-helper-textarea");
    assert.equal(
      await helper.evaluate((e) => getComputedStyle(e).caretColor),
      "rgba(0, 0, 0, 0)",
      "input helper must not paint a second browser caret",
    );
    const measure = async (text: string) => {
      // Narrow viewports wrap long ASCII output; match all rows, then locate
      // the actual cursor row instead of assuming it remains in row zero.
      await page.waitForFunction(
        ({ text, touch }) =>
          [...document.querySelectorAll(touch ? ".terminal-native-text>div" : ".xterm-rows>div")]
            .map((row) => row.textContent)
            .join("") ===
          text + " ",
        { text, touch },
      );
      const result = await page.evaluate(
        ({ touch }) => {
          const rows = [...document.querySelectorAll(".xterm-rows>div")];
          const cursor = document.querySelector(".xterm-rows .xterm-cursor")!;
          const row = cursor.parentElement!;
          const rowIndex = rows.indexOf(row);
          const index = [...row.children].indexOf(cursor);
          const mirror = touch
            ? document.querySelectorAll(".terminal-native-text>div")[rowIndex]!.children[index]!
            : cursor;
          const box = cursor.getBoundingClientRect(),
            clone = mirror.getBoundingClientRect();
          const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
          return {
            text: rows.map((row) => row.textContent).join(""),
            rowIndex,
            sourceX: box.x,
            cloneX: clone.x,
            width: box.width,
            helperWidth: textarea.getBoundingClientRect().width,
            helperFont: getComputedStyle(textarea).fontFamily,
            terminalFont: getComputedStyle(row).fontFamily,
          };
        },
        { touch },
      );
      assert.ok(
        Math.abs(result.sourceX - result.cloneX) <= 1 / 32,
        "native selection presentation retains xterm cursor geometry",
      );
      reports.push({ viewport: width, touch, ...result });
    };
    for (const text of [
      "bash-5.2$ aaaaa",
      "bash-5.2$ iiiii",
      "bash-5.2$ WWWWW",
      "bash-5.2$ 中文中文",
      "bash-5.2$ " + "a".repeat(30),
    ]) {
      await page.evaluate((t) => (window as any).fixture.emit("\x1b[2J\x1b[H" + t), text);
      await measure(text);
    }
    await page.evaluate(() => (window as any).fixture.emit("\x1b[2J\x1b[Hbash-5.2$ "));
    await measure("bash-5.2$ ");
    await helper.focus();
    const before = await page.evaluate(() => (window as any).fixture.writes.length);
    await page.keyboard.type("aaaaa");
    await measure("bash-5.2$ aaaaa");
    assert.equal(await page.evaluate((n) => (window as any).fixture.writes.slice(n).join(""), before), "aaaaa");
    await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      textarea.value += "中";
      textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中" }));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
    });
    await measure("bash-5.2$ aaaaa中");
    assert.equal(
      await page.evaluate((n) => (window as any).fixture.writes.slice(n).join(""), before),
      "aaaaa中",
      "IME commit stays single-owned",
    );
    await helper.blur();
    await page.screenshot({ path: `${output}/cursor-${width}-${touch}.png` });
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify(reports, null, 2));
  console.log(
    "PASS: helper caret suppressed; ASCII/wide text, native mirror, keyboard echo and IME commit retain xterm cursor geometry",
  );
} finally {
  await browser?.close();
  await server.close();
}
