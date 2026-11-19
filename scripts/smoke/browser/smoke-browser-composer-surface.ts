import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { _electron } from "playwright";
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/browser-composer");
await mkdir(output, { recursive: true });
const original = await readFile("scripts/smoke/shell/smoke-composer-panel.ts", "utf8");
const source = original
  .split("const source = `")[1]!
  .split("`;")[0]!
  .replace(
    "const shell=useShellPresentation();return",
    "const shell=useShellPresentation();window.fixtureScene=shell;return",
  )
  .replace("entryActions={<ComposerPanelToggle/>}", "navigationActions={<ComposerPanelToggle/>}")
  .replace(
    "<AppShell navigation=",
    "<AppShell sceneOwnerId='scope' foreground={state.foreground} onForegroundChange={foreground=>panels.dispatch('scope',{type:'select-foreground',foreground})} navigation=",
  )
  .replace("User intro must not be duplicated", "这个页面底部太拥挤了，帮我调整一下。")
  .replace(
    "Latest answer preview\\\\n\\\\n'+('A bounded response paragraph.\\\\n\\\\n'.repeat(40))",
    "我会保留网页操作，把聊天记录和输入区域整合在一起。\\\\n\\\\n'+('继续查看页面，或通过更多菜单操作网页。\\\\n\\\\n'.repeat(5))",
  );
const fixtureSource = source.replaceAll("\\\\n", "\\n");
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: output + "/vite-cache",
  resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "fixture",
      resolveId: (id) => (id === "/fixture.tsx" ? id : null),
      load: (id) => (id === "/fixture.tsx" ? fixtureSource : null),
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === "/browser-fixture") {
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(
              '<style>body{font:16px system-ui;margin:24px;color:#162b43;background:#fcfcfc}h1{font-size:30px}.photo{height:160px;background:linear-gradient(135deg,#d8e5eb,#869ca7);border-radius:12px}button{padding:12px;border-radius:8px;border:1px solid #ccd4dc;background:white}</style><header>STUDIO · 设计参考</header><h1>让空间更简单</h1><p>清晰的层次，让内容更容易被看见。</p><div class=photo></div><p><button onclick="this.textContent=++window.count">查看案例</button></p><script>window.count=0</script>',
            );
            return;
          }
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id=root></div><script type=module src=/fixture.tsx></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await vite.listen();
  await writeFile(
    output + "/app.cjs",
    "const{app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(()=>new BrowserWindow({width:390,height:844}).loadURL('about:blank'))",
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.DISPLAY;
  browser = await _electron.launch({
    executablePath: "/opt/opencraft/runtime/browser/electron/electron",
    args: [
      "--ozone-platform=headless",
      "--ozone-override-screen-size=1600,1200",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      output + "/app.cjs",
    ],
    env,
  });
  const page = await browser.firstWindow();
  page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  if (process.env.OPENCRAFT_CHROME_FALLBACK) await page.addInitScript("delete Element.prototype.moveBefore");
  await page.addInitScript("window.__name=value=>value");
  await page.goto(vite.resolvedUrls!.local[0]! + "?mobile=1&locale=zh-CN", { waitUntil: "commit" });
  await page.waitForFunction(() => !!(window as any).fixture, null, { timeout: 120000 });
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.openBrowser();
    f.panels.dispatch("scope", { type: "set-region-open", region: "right", open: true });
    if (!f.panels.getOwnerSnapshot("scope").rightPanelFullWidth)
      f.panels.dispatch("scope", { type: "toggle-right-full-width" });
  });
  await page.evaluate(() => (window as any).fixtureScene.selectTools());
  await page.locator(".browser-panel[data-mobile-browser=true]").waitFor();
  const toggle = () => page.locator(".panel-mobile-dock__address button[aria-pressed]");
  await toggle().waitFor();
  if ((await toggle().getAttribute("aria-pressed")) === "true") await toggle().click();
  await page.waitForFunction(() => !document.querySelector(".panel-mobile-dock[data-composer-integrated=true]"));
  await page.screenshot({ path: output + "/collapsed.png" });
  const before = await page.locator(".panel-mobile-dock__tabs").boundingBox();
  assert.ok(before);
  await page.evaluate(() => {
    (window as any).originalBrowserToolbar = document.querySelector(".panel-mobile-dock__address");
    (window as any).originalBrowserAddress = document.querySelector(".panel-mobile-dock__location input");
  });
  const frames = await page.evaluate(async () => {
    const frames = [];
    (document.querySelector(".panel-mobile-dock__address button[aria-pressed]") as HTMLButtonElement).click();
    for (let i = 0; i < 36; i++) {
      await new Promise(requestAnimationFrame);
      const bar = document.querySelector(".panel-mobile-dock__address")!;
      const rect = bar.getBoundingClientRect();
      frames.push({
        y: rect.y,
        width: rect.width,
        same: bar === (window as any).originalBrowserToolbar,
        address:
          document.querySelector(".panel-mobile-dock__location input") === (window as any).originalBrowserAddress,
      });
    }
    return frames;
  });
  assert.ok(
    frames.every((f) => f.same && f.address),
    "toolbar and native address input retain DOM identity",
  );
  assert.ok(frames[0]!.y - frames.at(-1)!.y > 40, "header travels from dock to conversation");
  assert.ok(
    frames.some((f, i) => i > 0 && Math.abs(f.y - frames[i - 1]!.y) > 0.2 && Math.abs(f.y - frames[i - 1]!.y) < 80),
    "toolbar has intermediate positions",
  );
  await writeFile(output + "/motion-frames.json", JSON.stringify(frames, null, 2));
  await page.waitForTimeout(400);
  await page.screenshot({ path: output + "/expanded.png" });
  const after = await page.locator(".panel-mobile-dock__tabs").boundingBox();
  assert.ok(after);
  assert.ok(Math.abs(before.y - after.y) < 1 && Math.abs(before.x - after.x) < 1, "overview stays anchored");
  assert.equal(await page.locator(".panel-mobile-dock__address").count(), 1, "one browser toolbar owner");
  assert.equal(
    await page.locator(".thread-composer-overlay__switcher-slot .panel-mobile-dock__tabs").count(),
    1,
    "one overview in integrated footer",
  );
  const editorBox = await page.locator(".thread-composer-overlay__editor-slot").boundingBox();
  assert.ok(editorBox);
  assert.ok(
    Math.abs(editorBox.y + editorBox.height - after.y - after.height) < 2,
    "composer and overview share bottom baseline",
  );
  assert.equal(
    await page.locator(".thread-composer-overlay__summary:visible").count(),
    0,
    "no tall conversation heading",
  );
  const editor = page.locator(".thread-composer-overlay-host .opencraft-composer-editor");
  await editor.fill("保留这个草稿");
  await page
    .locator(".thread-composer-overlay__browser-controls button")
    .filter({ has: page.locator("svg") })
    .count();
  const overviewHit = await page.locator(".panel-mobile-dock__tabs").evaluate((e) => {
    const r = e.getBoundingClientRect();
    return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  assert.ok(overviewHit, "overview is not covered by composer surface");
  const address = page.locator(".panel-mobile-dock__location input");
  await address.click();
  await address.fill("https://example.com/");
  assert.equal(
    await page.locator(".thread-composer-overlay__browser-controls:visible").count(),
    1,
    "editing address keeps conversation",
  );
  await page.keyboard.press("Escape");
  const more = page.locator(".panel-mobile-dock__address button[aria-haspopup=dialog]");
  await more.click();
  await page.locator(".panel-mobile-sheet").waitFor();
  assert.equal(await editor.textContent(), "保留这个草稿");
  await page.keyboard.press("Escape");
  for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 430 },
    { width: 390, height: 844 },
  ]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: true });
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    const bounds = await page.locator(".thread-composer-overlay__interactive").boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= size.height, "panel fits available viewport");
    const hit = await page.locator(".panel-mobile-dock__tabs").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    assert.ok(hit, "overview remains reachable in short/narrow viewport");
  }
  const reversal = await toggle().evaluate(async (e) => {
    (e as HTMLButtonElement).click();
    let intermediate = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(requestAnimationFrame);
      const panel = document.querySelector(".thread-composer-overlay__interactive");
      const p = Number(panel && getComputedStyle(panel).getPropertyValue("--browser-composer-progress"));
      if (p > 0.2 && p < 0.8) {
        intermediate = true;
        break;
      }
    }
    const info = () => {
      const panel = document.querySelector(".thread-composer-overlay__interactive")!;
      const header = document.querySelector(".thread-composer-overlay__browser-controls")!;
      return {
        p: getComputedStyle(panel).getPropertyValue("--browser-composer-progress"),
        panel: panel.getBoundingClientRect().toJSON(),
        header: header.getBoundingClientRect().toJSON(),
        bar: document.querySelector(".panel-mobile-dock__address")!.getBoundingClientRect().toJSON(),
      };
    };
    const before = e.getBoundingClientRect().y;
    const a = info();
    (e as HTMLButtonElement).click();
    await Promise.resolve();
    return { intermediate, before, after: e.getBoundingClientRect().y, a, b: info() };
  });
  console.log("REVERSAL", reversal);
  assert.ok(
    reversal.intermediate && Math.abs(reversal.before - reversal.after) < 2,
    "reversal continues at current geometry",
  );
  await page.waitForTimeout(700);
  await editor.waitFor();
  assert.ok(
    await page.locator(".panel-mobile-dock__address").evaluate((e) => e === (window as any).originalBrowserToolbar),
    "reversal retains toolbar",
  );
  await toggle().click();
  await page.waitForTimeout(700);
  assert.ok(
    await page.locator(".panel-mobile-dock__address").evaluate((e) => e === (window as any).originalBrowserToolbar),
    "collapse retains toolbar",
  );
  await toggle().click();
  await page.waitForTimeout(700);
  await editor.waitFor();
  assert.equal(await editor.textContent(), "保留这个草稿");
  await page.evaluate(() => (window as any).fixture.setThemePreference("dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: output + "/expanded-dark.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await toggle().evaluate((e) => (e as HTMLButtonElement).click());
  await page.waitForFunction(() => !document.querySelector(".panel-mobile-dock[data-composer-integrated=true]"));
  await toggle().evaluate((e) => (e as HTMLButtonElement).click());
  await editor.waitFor();
  await page.waitForTimeout(50);
  assert.equal(
    await page.locator(".panel-mobile-dock__address").getAttribute("data-composer-moving"),
    "false",
    "reduced motion settles without flight",
  );
  await page.locator(".panel-mobile-dock__tabs").click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser composer: one toolbar, fixed overview, reachable controls, draft retention, theme, overview round trip",
  );
} catch (e) {
  if (browser) {
    const p = await browser.firstWindow();
    console.error(await p.locator("body").innerText());
    await p.screenshot({ path: output + "/failed.png" }).catch(() => {});
  }
  throw e;
} finally {
  await browser?.close();
  await vite.close();
}
