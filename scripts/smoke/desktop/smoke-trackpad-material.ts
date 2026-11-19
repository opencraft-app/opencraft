import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

// Isolate the real input owner from the external desktop connection. The full
// App is validated separately; this fixture checks material and held gestures.
const source = `
import {bindDesktopTrackpad} from '/plugins/cloud-desktop/src/trackpad-input.ts';
import {buildOpenCraftThemeCssProperties,seeThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '/packages/design-system/src/desktop-trackpad.web.scss';
const pad=document.querySelector('#pad'),events=[];
const binding=bindDesktopTrackpad(pad,{allowed:()=>true,begin(){},move:p=>events.push(['move',p]),press:m=>events.push(['press',m]),release:()=>events.push(['release']),scroll:p=>events.push(['scroll',p])});
window.fixture={events,theme(mode){document.documentElement.dataset.theme=mode;for(const[k,v]of Object.entries(buildOpenCraftThemeCssProperties(mode,seeThemePalette[mode])))document.documentElement.style.setProperty(k,v)}};
window.fixture.theme('light');`;
const output = process.env.OPENCRAFT_TRACKPAD_MATERIAL_OUTPUT ?? "/tmp/opencraft-trackpad-material";
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "trackpad-material",
      resolveId: (id) => (id === "/trackpad-material.ts" ? id : null),
      load: (id) => (id === "/trackpad-material.ts" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--material-optics-canvas);height:100vh;padding:24px;box-sizing:border-box}#pad{height:180px}</style><div id="pad" class="ui-desktop-trackpad__surface"><span class="ui-desktop-trackpad__title">Trackpad</span><span class="ui-desktop-trackpad__hint">Move · Scroll · Hold to drag</span></div><script type="module" src="/trackpad-material.ts"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const results = [];
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 640 }, hasTouch: true, isMobile: true });
  await page.goto(server.resolvedUrls!.local[0]!);
  await page.waitForFunction(() => !!(window as any).fixture);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, points: any[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => (window as any).fixture.theme(mode), mode);
    const pad = page.locator("#pad");
    const normal = await pad.evaluate((el) => getComputedStyle(el).boxShadow);
    await touch("touchStart", [{ x: 120, y: 100, id: 1 }]);
    await page.waitForTimeout(350);
    await page.waitForFunction(() => document.querySelector("#pad")?.getAttribute("data-pressed") === "true");
    assert.notEqual(await pad.evaluate((el) => getComputedStyle(el).boxShadow), normal);
    await page.screenshot({ path: output + "/" + mode + "-held.png" });
    await touch("touchMove", [{ x: 160, y: 110, id: 1 }]);
    await touch("touchEnd", []);
    await page.waitForFunction(() => document.querySelector("#pad")?.getAttribute("data-pressed") === "false");
    await touch("touchStart", [
      { x: 100, y: 100, id: 1 },
      { x: 180, y: 100, id: 2 },
    ]);
    await touch("touchMove", [
      { x: 125, y: 100, id: 1 },
      { x: 205, y: 100, id: 2 },
    ]);
    await page.waitForTimeout(50);
    await touch("touchEnd", []);
    const events = await page.evaluate(() => (window as any).fixture.events.splice(0));
    assert(events.some((e: any) => e[0] === "press"));
    assert(events.some((e: any) => e[0] === "release"));
    assert(events.some((e: any) => e[0] === "scroll"));
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    assert.equal(await pad.evaluate((el) => getComputedStyle(el).backdropFilter), "none");
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    assert.equal(await pad.evaluate((el) => getComputedStyle(el).backdropFilter), "none");
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    results.push({ mode, events });
  }
  await writeFile(
    output + "/report.json",
    JSON.stringify(
      { scope: "Real trackpad input owner and CSS, synthetic remote pointer port; CDP touch", results },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
