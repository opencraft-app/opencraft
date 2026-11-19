import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { _electron } from "playwright";

// A checkpoint is an initial seed, not a command to reposition a mounted View.
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/restore-audit");
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: resolve(output, "vite-cache"),
  optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react-intl"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "restore-fixture",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-reading-position.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  await server.listen();
  await writeFile(
    `${output}/app.cjs`,
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(()=>new BrowserWindow({show:true}).loadURL('about:blank'));`,
  );
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "DISPLAY", "WAYLAND_DISPLAY"]) delete env[key];
  browser = await _electron.launch({
    executablePath: process.env.OPENCRAFT_ELECTRON_EXECUTABLE ?? "/opt/opencraft/runtime/browser/electron/electron",
    args: [
      "--ozone-platform=headless",
      "--ozone-override-screen-size=1600,1200",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `${output}/app.cjs`,
    ],
    env,
  });
  const page = await browser.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.addInitScript("window.__name = value => value");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  for (const width of [390, 1200]) {
    await page.setViewportSize({ width, height: 320 });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: width === 390 });
    if (width === 390) await page.goto(server.resolvedUrls!.local[0]!);
    await page.waitForFunction(
      () => !!(window as any).readerFixture && document.querySelectorAll(".chat-code-block__scroller").length === 2,
    );
    await page.evaluate(() => (window as any).readerFixture.hide());
    await page.locator(".thread-scroll").waitFor({ state: "detached" });
    await page.evaluate(() => (window as any).readerFixture.show());
    await page.locator(".thread-scroll").waitFor();
    await page.waitForTimeout(250);
    const before = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>(".thread-scroll")!;
      if (el.scrollHeight - el.clientHeight < 120) throw Error("Fixture must be scrollable");
      el.scrollTop = -50;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return el.scrollTop;
    });
    await page.evaluate(() => (window as any).readerFixture.checkpoint(1));
    await page.waitForTimeout(150);
    const after = await page.locator(".thread-scroll").evaluate((el) => el.scrollTop);
    console.log(JSON.stringify({ width, before, after }));
    assert.ok(Math.abs(after - before) < 2, "updating a saved checkpoint must not move a mounted reader");
    // The new checkpoint does apply to a genuinely new View.
    await page.evaluate(() => (window as any).readerFixture.hide());
    await page.locator(".thread-scroll").waitFor({ state: "detached" });
    await page.evaluate(() => {
      (window as any).readerFixture.checkpoint(0);
      (window as any).readerFixture.show();
    });
    await page.locator(".thread-scroll").waitFor();
    await page.waitForTimeout(250);
    assert.ok(await page.locator(".thread-scroll").evaluate((el) => Math.abs(el.scrollTop) < 2));
    await page.screenshot({ path: `${output}/${width}.png` });
  }
  assert.deepEqual(errors, []);
  console.log("Initial restore ownership: desktop and touch passed");
} finally {
  await browser?.close();
  await server.close();
}
