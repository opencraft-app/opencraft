import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { appearanceBootstrap } from "../../../apps/workbench-web/appearance-bootstrap.vite";
import { resolveWorkbenchPresentation } from "../../../apps/workbench-web/src/workbench-presentation";

const engines = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const engine = process.env.OPENCRAFT_BROWSER_ENGINE === "webkit" ? engines.webkit : engines.chromium;
const output = process.env.OPENCRAFT_PWA_APPEARANCE_OUTPUT ?? "/tmp/opencraft-pwa-appearance";
const runtime = `import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
window.pwaAppearance={setThemePreference,setAppearanceThemeId};
document.getElementById('opencraft-bootstrap')?.remove();
document.getElementById('root').innerHTML='<input aria-label="Draft" value="Keep this draft">';`;
const html = (await readFile("apps/workbench-web/index.html", "utf8"))
  .replace('import("/src/main-bootstrap.ts?opencraft-entry=1")', 'import("/pwa-runtime.ts")');
assert.ok(html.includes('import("/pwa-runtime.ts")'));
// Exercise the actual head and generated catalog while independently delaying
// the application module. A slow bundle must not own the first paint.
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-pwa-appearance",
  plugins: [appearanceBootstrap(resolveWorkbenchPresentation({})), {
    name: "pwa-appearance-fixture",
    resolveId: id => id === "/pwa-runtime.ts" ? id : null,
    load: id => id === "/pwa-runtime.ts" ? runtime : null,
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end(await vite.transformIndexHtml("/", html));
    }); },
  }], server: { host: "127.0.0.1", port: 0, hmr: false },
});
let browser: any;
const evidence: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await server.listen();
  browser = await engine.launch(process.env.OPENCRAFT_BROWSER_ENGINE === "webkit" ? { headless: true } : { headless: true, args: ["--no-sandbox"] });
  for (const standalone of [false, true]) for (const width of [390, 402]) for (const inset of [0, 34])
    for (const [preference, systemDark] of [["light", true], ["dark", false], ["system", false], ["system", true]] as const) {
      const page = await browser.newPage({ viewport: { width, height: 874 }, hasTouch: true, isMobile: true,
        colorScheme: systemDark ? "dark" : "light" });
      await page.addInitScript(({ standalone, preference, inset }) => {
        Object.defineProperty(navigator, "standalone", { value: standalone });
        localStorage.setItem("opencraft.appearance-theme", preference);
        localStorage.setItem("opencraft.appearance-theme-id", "opencraft.core.lavender");

      }, { standalone, preference, inset });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/pwa-runtime.ts*", async route => { await gate; await route.continue(); });
      await page.goto(server.resolvedUrls!.local[0], { waitUntil: "domcontentloaded" });
      await page.evaluate(inset => document.documentElement.style.setProperty("--safe-layout-inset-bottom", `${inset}px`), inset);
      const read = () => page.evaluate(() => {
        const root = document.documentElement, body = document.body;
        return { mode: root.dataset.theme, phase: root.dataset.windowAppearancePhase,
          stored:localStorage.getItem("opencraft.appearance-theme"),runtime:!!(window as any).pwaAppearance,preference: root.dataset.themePreference, display: root.dataset.windowDisplayMode,
          root: getComputedStyle(root).backgroundColor, body: getComputedStyle(body).backgroundColor,
          edge: root.style.getPropertyValue("--shell-window-edge-background"),
          meta: document.querySelector('meta[name="theme-color"]')!.getAttribute("content"),
          scheme: document.querySelector('meta[name="color-scheme"]')!.getAttribute("content"),
          status: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')!.getAttribute("content") };
      });
      const before = await read();
      const expected = preference === "system" ? systemDark ? "dark" : "light" : preference;
      await writeFile(`${output}/before-debug.json`,JSON.stringify({standalone,width,inset,preference,systemDark,before},null,2));assert.equal(before.mode, expected,JSON.stringify({preference,systemDark,before})); assert.equal(before.phase, "bootstrap");
      assert.equal(before.scheme, expected); assert.equal(before.meta, before.edge);
      assert.equal(before.root, before.body, "body is opaque in the same color before app JS");
      assert.notEqual(before.body, "rgba(0, 0, 0, 0)");
      assert.equal(before.display, standalone ? "standalone" : "tab");
      assert.equal(before.status, "black-translucent");
      release(); await page.waitForFunction(() => !!(window as any).pwaAppearance);
      const resolved = await read();
      assert.equal(resolved.root, before.root, "runtime does not flash a different initial palette");
      assert.equal(resolved.body, before.body); assert.equal(resolved.meta, before.meta);
      const input = page.getByRole("textbox", { name: "Draft" }); await input.fill("Preserve draft and focus");
      await input.evaluate(e => { (window as any).keptPwaDraft = e; (e as HTMLInputElement).setSelectionRange(2, 7); });
      const transitions = [];
      for (const mode of ["dark", "light", "system"]) {
        await page.evaluate(mode => (window as any).pwaAppearance.setThemePreference(mode), mode);
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForFunction(mode => document.documentElement.dataset.theme === (mode === "system" ? "dark" : mode), mode);
        const darkSystem = await read();
        await page.emulateMedia({ colorScheme: "light" });
        await page.waitForFunction(mode => document.documentElement.dataset.theme === (mode === "system" ? "light" : mode), mode);
        const lightSystem = await read();
        for (const state of [darkSystem, lightSystem]) {
          assert.equal(state.root, state.body); assert.equal(state.meta, state.edge);
          assert.equal(state.scheme, state.mode); assert.equal(state.status, before.status);
        }
        assert.equal(darkSystem.mode, mode === "system" ? "dark" : mode);
        assert.equal(lightSystem.mode, mode === "system" ? "light" : mode);
        transitions.push({ mode, darkSystem, lightSystem });
      }
      await page.evaluate(() => (window as any).pwaAppearance.setAppearanceThemeId("opencraft.core.longing"));
      const changedPalette = await read(); assert.notEqual(changedPalette.meta, before.meta);
      assert.equal(changedPalette.body, changedPalette.root); assert.equal(changedPalette.meta, changedPalette.edge);
      assert.ok(await input.evaluate(e => e === (window as any).keptPwaDraft && document.activeElement === e));
      assert.equal(await input.inputValue(), "Preserve draft and focus");
      assert.deepEqual(await input.evaluate(e => [(e as HTMLInputElement).selectionStart, (e as HTMLInputElement).selectionEnd]), [2, 7]);
      await page.screenshot({ path: `${output}/${standalone ? "pwa" : "safari"}-${width}-${inset}-${preference}-${systemDark}.png` });
      evidence.push({ standalone, width, inset, preference, systemDark, before, resolved, transitions, changedPalette });
      await page.close();
    }
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, boundary: "Actual generated head and theme runtime in a browser engine; native iPhone system pixels require device acceptance", evidence }, null, 2));
  console.log(`PASS PWA/Safari pre-paint and live theme projection: ${evidence.length} cases`);
} finally { await browser?.close(); await server.close(); }
