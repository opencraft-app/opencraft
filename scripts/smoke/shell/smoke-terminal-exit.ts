import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/terminal-exit";
await mkdir(output, { recursive: true });
const negative = process.env.OPENCRAFT_TERMINAL_EXIT_NEGATIVE === "1";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-terminal-exit",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "terminal-exit",
      enforce: "pre",
      transform(code, id) {
        if (!negative || !id.endsWith("/plugins/terminal/src/index.tsx")) return;
        const next = code
          .replace(
            'if (activeRef.current && session.getSnapshot().phase !== "exited") setPresentationError(error as Error);',
            "setPresentationError(error as Error);",
          )
          .replace('snapshot.phase === "exited" ? (', 'snapshot.phase === "exited" && error === null ? (');
        assert.notEqual(next, code, "negative control must restore stale input error precedence");
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
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const variant of [
    { width: 320, touch: true, theme: "light", locale: "zh-CN", code: 7, race: true },
    { width: 402, touch: true, theme: "dark", locale: "en-US", code: 0, race: false },
    { width: 1280, touch: false, theme: "dark", locale: "en-US", code: null, race: false },
  ]) {
    const context = await browser.newContext({
      viewport: { width: variant.width, height: 844 },
      hasTouch: variant.touch,
      isMobile: variant.touch,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((touch) => {
      (window as any).__name = (v: unknown) => v;
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.dataset.uiDensity = touch ? "touch" : "compact";
      });
    }, variant.touch);
    await page.goto(vite.resolvedUrls!.local[0] + "?gesture&locale=" + variant.locale);
    const host = page.locator(".terminal-panel__host");
    await host.locator(".xterm-rows").waitFor();
    await page.evaluate((theme) => (window as any).fixture.setThemePreference(theme), variant.theme);
    const terminal = await host.locator(".xterm").elementHandle();
    const textarea = host.locator(".xterm-helper-textarea");
    await textarea.focus();
    await page.keyboard.type("echo before");
    assert((await page.evaluate(() => (window as any).fixture.writes.join(""))).includes("echo before"));
    if (variant.race) {
      await page.evaluate(() => (window as any).fixture.exitDuringNextWrite());
      await page.keyboard.type("x");
    } else await page.evaluate((code) => (window as any).fixture.exit(code), variant.code);
    const status = page.locator('[data-terminal-status="exited"]');
    await status.waitFor({ timeout: 5000 });
    const expectedCode = variant.race ? 7 : variant.code;
    if (expectedCode !== null) assert((await status.innerText()).includes(String(expectedCode)));
    assert(
      !(await page.locator(".terminal-panel").innerText()).includes("Terminal is not accepting input"),
      "exit status supersedes rejected input",
    );
    const count = await page.evaluate(() => (window as any).fixture.writes.length);
    await textarea.focus();
    await page.keyboard.type("no-input-after-exit");
    await page.keyboard.press("Enter");
    assert.equal(
      await page.evaluate(() => (window as any).fixture.writes.length),
      count,
      "exited terminal never forwards stale keyboard input",
    );
    await page
      .getByRole("button", { name: variant.locale === "zh-CN" ? "显示键盘" : "Show keyboard", exact: true })
      .isDisabled()
      .then((value) => assert(value));
    assert(
      await page.getByRole("button", { name: variant.locale === "zh-CN" ? "粘贴" : "Paste", exact: true }).isDisabled(),
    );
    assert(
      await host.locator(".xterm").evaluate((node, old) => node === old, terminal),
      "exit preserves original terminal and transcript",
    );
    assert((await host.locator(".xterm-rows").innerText()).includes("Terminal output 79"));
    assert(
      await status.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return (
          r.left >= 0 &&
          r.right <= innerWidth &&
          r.top >= 0 &&
          r.bottom <= innerHeight &&
          node.scrollWidth <= node.clientWidth
        );
      }),
      "exit status is readable inside narrow viewport",
    );
    await page.screenshot({ path: output + "/" + variant.width + "-" + variant.theme + ".png" });
    // Touch keeps native ranges; a mouse retains xterm's existing word copy.
    if (variant.touch) {
      await page.evaluate(async () => {
        (document.activeElement as HTMLElement)?.blur();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      await host.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node.querySelector("[data-terminal-native-text] > :first-child")!);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
      });
      assert((await page.evaluate(() => getSelection()?.toString()))?.includes("Terminal output"));
    } else {
      const box = await host.locator(".xterm-rows > :first-child").boundingBox();
      assert(box);
      await page.mouse.dblclick(box.x + 20, box.y + 8);
      await page.keyboard.press("Control+Insert");
      assert((await page.evaluate(() => navigator.clipboard.readText())).includes("Terminal"));
    }
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).fixture.writes.length), count);
    assert.deepEqual(errors, []);
    reports.push({
      ...variant,
      exitedStatus: true,
      inputBlocked: true,
      transcriptPreserved: true,
      copyAvailable: true,
    });
    await context.close();
  }
  await writeFile(output + "/report.json", JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ ok: true, reports }));
} finally {
  await browser?.close();
  await vite.close();
}
