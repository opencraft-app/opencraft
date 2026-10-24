import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { assertBrowserRuntimeDependencies } from "../../browser-smoke-preflight.mjs";
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const output = process.env.OPENCRAFT_NATIVE_ICON_REPORT ?? "/tmp/opencraft-native-action-icons";
await mkdir(output, { recursive: true });
// Build the Native fixture through the app's Metro/Expo platform resolution.
const webRoot = resolve(output, "metro-export");
const buildEnv = { ...process.env, CI: "1", EXPO_OFFLINE: "1", OPENCRAFT_EXPO_PRODUCT_ENTRY: resolve("tests/fixtures/native-action-icons.tsx") };
for (const key of ["OPENCRAFT_EXPO_WORKBENCH", "OPENCRAFT_EXPO_PRODUCT_CONFIG", "OPENCRAFT_EXPO_ROUTER_CONTEXT_ENTRY", "OPENCRAFT_EXPO_PRODUCT_STYLES"]) delete (buildEnv as Record<string, string | undefined>)[key];
const build = await promisify(execFile)(process.execPath, ["scripts/run-expo.cjs", "export", "--platform", "web", "--output-dir", webRoot], {
  cwd: resolve("apps/workbench-expo"), env: buildEnv, maxBuffer: 16 * 1024 * 1024,
});
await writeFile(join(output, "metro-build.log"), build.stdout + build.stderr);
const mime: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const file = resolve(webRoot, "." + (name === "/" ? "/index.html" : name));
  if (!file.startsWith(webRoot + sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream"); res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const cases: unknown[] = [];
try {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const theme of ["light", "dark"]) for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1024, height: 900 }, deviceScaleFactor: touch ? 2 : 1, isMobile: touch, hasTouch: touch,
      permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?theme=${theme}`);
    await page.locator('[data-native-icon="CheckIcon"] svg').first().waitFor();
    assert.equal(await page.locator("[data-native-icon]").count(), 52);
    assert.equal(await page.locator("[data-native-icon] svg").count(), 208);
    const gallery = await page.locator("main").evaluate(main => {
      const bounds = main.getBoundingClientRect();
      return {
        width: bounds.width, viewport: document.documentElement.clientWidth,
        background: getComputedStyle(main).backgroundColor,
        containsCards: [...main.querySelectorAll("[data-native-icon]")].every(card => card.getBoundingClientRect().bottom <= bounds.bottom),
      };
    });
    assert.equal(gallery.width, gallery.viewport);
    assert.ok(gallery.containsCards, "Theme background covers the complete icon gallery");
    assert.equal(gallery.background, theme === "dark" ? "rgb(20, 23, 28)" : "rgb(250, 251, 252)");
    for (const svg of await page.locator("[data-native-icon] svg").all()) {
      const shape = await svg.evaluate(element => {
        const node = element as SVGSVGElement;
        const view = node.viewBox.baseVal;
        const clipped = [...node.querySelectorAll<SVGGraphicsElement>("path,rect,circle,ellipse,line,polyline,polygon")].filter(child => {
          const box = child.getBBox(), style = getComputedStyle(child);
          const pad = style.stroke === "none" ? 0 : parseFloat(style.strokeWidth) / 2;
          return box.x - pad < view.x - 0.05 || box.y - pad < view.y - 0.05
            || box.x + box.width + pad > view.x + view.width + 0.05 || box.y + box.height + pad > view.y + view.height + 0.05;
        }).map(child => child.tagName);
        return { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
          children: node.children.length, stroke: getComputedStyle(node).stroke, visible: node.getBoundingClientRect().right <= document.documentElement.clientWidth, clipped };
      });
      assert.deepEqual(shape.clipped, [], "Shared strokes remain inside the SVG canvas");
      assert.ok([14, 16, 20, 24].includes(shape.width)); assert.equal(shape.width, shape.height);
      assert.ok(shape.children > 0); assert.ok(shape.visible); assert.notEqual(shape.stroke, "none");
    }
    const activate = async (locator: ReturnType<typeof page.locator>) => touch ? locator.tap() : locator.click();
    const show = page.getByRole("button", { name: "Show sidebar", exact: true });
    assert.equal(await show.locator("svg").count(), 1);
    assert.equal(await show.locator("svg").getAttribute("viewBox"), "0 0 20 20");
    await activate(show);
    const add = page.getByRole("button", { name: "New task", exact: true }); assert.equal(await add.count(), 2);
    await activate(add.first()); await page.getByText("Created: 1", { exact: true }).waitFor();
    const hide = page.getByRole("button", { name: "Hide sidebar", exact: true });
    await page.screenshot({ path: join(output, `${theme}-${touch ? "touch" : "mouse"}-sidebar.png`), fullPage: true });
    await activate(hide); await show.waitFor();
    if (!touch) { await show.focus(); assert.ok(await show.evaluate(node => document.activeElement === node)); await page.keyboard.press("Enter"); await hide.waitFor(); await activate(hide); }
    const wrap = page.getByRole("button", { name: /^(Enable|Disable) word wrap$/ });
    const oldWrap = await wrap.getAttribute("aria-label"); assert.equal(await wrap.locator("svg").count(), 1);
    await activate(wrap); assert.notEqual(await wrap.getAttribute("aria-label"), oldWrap);
    const copy = page.getByRole("button", { name: "Copy code", exact: true }); await activate(copy);
    await page.getByRole("button", { name: "Copied code", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "const synthetic = 42;");
    await activate(page.getByRole("button", { name: "Open synthetic gallery", exact: true }));
    const next = page.getByRole("button", { name: "Next image", exact: true }); await next.waitFor(); assert.equal(await next.locator("svg").count(), 1);
    await activate(next); await page.getByRole("button", { name: "Previous image", exact: true }).waitFor();
    const close = page.getByRole("button", { name: "Close image preview", exact: true }); assert.equal(await close.locator("svg").count(), 1);
    await activate(close); await close.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `${theme}-${touch ? "touch" : "mouse"}.png`), fullPage: true });
    cases.push({ theme, touch, glyphs: 52, paintSamples: 208, headerAndSidebar: true, keyboard: !touch, codeCopyAndWrap: true, imageGallery: true });
    await context.close();
  }
  const receipt = { passed: true, cases, scope: "Real Native controls with react-native-web and react-native-svg Web adapter; synthetic data, no OS device or paid inference acceptance." };
  await writeFile(join(output, "result.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} finally { await browser?.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
