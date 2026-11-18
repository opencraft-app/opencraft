import assert from "node:assert/strict";
import { createServer } from "vite";
import { _electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const vite = await createServer({ root: process.cwd(), configFile: false, logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] }, cacheDir: "node_modules/.vite-composer-acceptance",
  optimizeDeps: { entries: ["tests/fixtures/composer-acceptance-browser.tsx"] }, esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "acceptance", configureServer(server) {
    server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/composer-acceptance-browser.tsx"></script>'); });
  } }],
});
const output=resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/composer-acceptance");
await mkdir(output,{recursive:true});
await vite.listen();
const profile = await mkdtemp(join(tmpdir(), "composer-acceptance-"));
await writeFile(join(profile, "app.cjs"), 'const {app,BrowserWindow}=require("electron");app.setPath("userData",__dirname);app.whenReady().then(()=>new BrowserWindow({show:true,width:1100,height:840}).loadURL("about:blank"));');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.DISPLAY;
const browser = await _electron.launch({ executablePath: process.env.OPENCRAFT_ELECTRON_EXECUTABLE ?? "/opt/opencraft/runtime/browser/electron/electron",
  args: ["--ozone-platform=headless", "--ozone-override-screen-size=1600,1200", "--disable-dev-shm-usage", "--disable-gpu", join(profile, "app.cjs")], env });
try {
  for (const touch of [true, false]) for (const scenario of ["accept", "reserialize", "lost-receipt", "navigate", "reject"]) {
    const page = await browser.firstWindow();
    await page.setViewportSize({ width: touch ? 390 : 1100, height: 840 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touch });
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript("window.__name = value => value");
    await page.goto(vite.resolvedUrls!.local[0]!, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!(window as any).fixture);
    await page.evaluate(() => (window as any).fixture.addImages());
    const editor = page.locator(".opencraft-composer-editor");
    await editor.fill("sent text with two images");
    await page.evaluate(() => {
      (window as any).__composerFrames = [];
      const capture = () => {
        if ((window as any).fixture.snapshot().draft.lifecycle.phase === "submitting") {
          (window as any).__composerFrames.push({ timeline: document.querySelector('[data-testid="timeline"]')?.textContent ?? "",
            editor: document.querySelector('.opencraft-composer-editor')?.textContent ?? "",
            attachments: document.querySelectorAll('.opencraft-composer-image-attachment').length });
        }
        requestAnimationFrame(capture);
      };
      requestAnimationFrame(capture);
    });
    const send = page.locator("[data-composer-primary-action]");
    if (touch) {
      const box = (await send.boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else await send.click();
    await page.waitForFunction(() => (window as any).fixture.snapshot().draft.lifecycle.phase === "submitting");
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().draft.attachments.length), 2);
    // Hold the RPC. Every painted frame after optimistic publication must have
    // one visible input owner, while the original draft remains recoverable.
    const frames = await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
      return (window as any).__composerFrames as { timeline: string; editor: string; attachments: number }[];
    });
    assert(frames.length >= 10);
    assert(frames.every(frame => frame.timeline.includes("sent text with two images")), "optimistic timeline must already contain the input");
    assert(frames.every(frame => !frame.editor.includes("sent text with two images") && frame.attachments === 0), "pending input must never remain visible beside its optimistic message");
    if (scenario === "accept") await page.screenshot({path:join(output, touch ? "touch-pending.png" : "mouse-pending.png")});
    if (scenario === "reject") {
      await page.evaluate(() => (window as any).fixture.lateNativeInput());
      assert.equal(await page.evaluate(() => (window as any).fixture.text()), "sent text with two images");
      assert.equal((await editor.innerText()).trim(), "");
    }
    if (scenario === "reserialize") await page.evaluate(() => (window as any).fixture.reserialize());
    if (scenario === "navigate") {
      await page.evaluate(() => (window as any).fixture.switch("b"));
      await editor.fill("keep this new draft");
    }
    await page.evaluate(s => (window as any).fixture[s === "reject" ? "reject" : s === "lost-receipt" ? "confirmReplica" : "accept"](), scenario);
    if (scenario === "navigate") {
      await page.waitForFunction(() => (window as any).fixture.refresh());
      assert.equal((await editor.innerText()).trim(), "keep this new draft");
      await page.evaluate(() => (window as any).fixture.switch("a"));
    }
    await page.waitForFunction(s => (window as any).fixture.snapshot().draft.lifecycle.phase === (s === "reject" ? "failed" : "editing"), scenario);
    assert.equal(await page.evaluate(() => (window as any).fixture.text()), scenario === "reject" ? "sent text with two images" : "");
    assert.equal(await page.evaluate(() => (window as any).fixture.snapshot().draft.attachments.length), scenario === "reject" ? 2 : 0);
    assert.equal((await editor.innerText()).trim(), scenario === "reject" ? "sent text with two images" : "");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ touch, scenario, paintedFrames: frames.length, passed: true })); await cdp.detach();
  }
} finally { await browser.close(); await vite.close(); }
