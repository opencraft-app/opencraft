import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const assets = resolve("apps/workbench-web/dist/assets");
const css = (await Promise.all((await readdir(assets)).filter(name => name.endsWith(".css"))
  .map(name => readFile(join(assets, name), "utf8")))).join("\n");
assert.ok(css.includes(".cloud-desktop-panel__feedback"), "Build current production CSS first");
const bundle = await build({ entryPoints: ["tests/fixtures/cloud-desktop-panel-ui.tsx"],
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic" });
const directory = await mkdtemp(join(tmpdir(), "opencraft-desktop-ui-"));
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0]!.contents); }
  else if (request.url === "/fixture.css") { response.setHeader("Content-Type", "text/css"); response.end(css); }
  else { response.setHeader("Content-Type", "text/html"); response.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root" style="width:100vw;height:100dvh"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
let browser: any;
const receipts: unknown[] = [];
try {
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const theme of ["light", "dark", "custom"]) for (const width of [720, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 480 }, hasTouch: width === 320,
      reducedMotion: theme === "light" ? "no-preference" : "reduce" });
    const activate = (button: any) => width === 320 ? button.tap() : button.click();
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.locator('[data-phase="connecting"]').waitFor();
    await page.evaluate(theme => {
      (window as any).__desktopUi.theme(theme);
      (window as any).__surfaceBefore = document.querySelector(".cloud-desktop-panel__surface");
    }, theme);
    const title = page.getByRole("heading", { name: "Connecting to desktop…" });
    await title.waitFor();
    const feedbackStyle = await title.evaluate(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight,
        center: rect.x + rect.width / 2, width: rect.width };
    });
    assert.equal(feedbackStyle.size, "18px"); assert.equal(feedbackStyle.line, "24px");
    assert.equal(feedbackStyle.weight, "500"); assert.ok(Math.abs(feedbackStyle.center - width / 2) <= 1);
    const background = await page.locator(".cloud-desktop-panel__feedback").evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(background, theme === "light" ? "rgb(255, 255, 255)" : theme === "dark" ? "rgb(24, 24, 24)" : "rgb(23, 35, 47)");
    const outline = await page.getByRole("button", { name: "Take control", exact: true }).evaluate(element => {
      const style = getComputedStyle(element); return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor };
    });
    assert.equal(outline.width, "1px"); assert.equal(outline.style, "solid"); assert.notEqual(outline.color, "rgba(0, 0, 0, 0)");
    const ring = await page.locator(".ui-progress-ring").evaluate(element => getComputedStyle(element).animationName);
    assert.equal(ring, theme === "light" ? "ui-progress-rotate" : "none");
    const buttonStyle = await page.getByRole("button", { name: "Take control", exact: true }).evaluate(element => {
      const style = getComputedStyle(element); return { size: style.fontSize, line: style.lineHeight,
        weight: style.fontWeight, radius: style.borderRadius, height: element.getBoundingClientRect().height };
    });
    assert.equal(buttonStyle.size, "14px"); assert.equal(buttonStyle.weight, "400");
    assert.equal(buttonStyle.radius, "999px"); assert.ok(buttonStyle.height >= (width === 320 ? 44 : 24));
    // The shared React Button always projects a size (md by default). Density
    // must beat every legacy size, not only raw plugin buttons without a size.
    for (const size of ["sm", "md", "lg", "toolbar"]) {
      const style = await page.getByRole("button", { name: "Take control", exact: true }).evaluate((element, size) => {
        (element as HTMLElement).dataset.size = size;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return { size: style.fontSize, line: style.lineHeight, radius: style.borderRadius, height: rect.height };
      }, size);
      assert.deepEqual(style, { size: "14px", line: "18px", radius: "999px", height: width === 320 ? 44 : 24 },
        `compact density must override ${size} size`);
    }
    await page.getByRole("button", { name: "Take control", exact: true }).evaluate(element => delete (element as HTMLElement).dataset.size);
    if (width === 320) {
      const pasteBounds = await page.getByRole("button", { name: "Paste", exact: true }).boundingBox();
      assert.ok(pasteBounds && pasteBounds.width >= 44 && pasteBounds.height >= 44,
        "icon-only touch actions also need a two-dimensional 44px hit target");
    }
    await page.screenshot({ path: join(directory, `${theme}-${width}-connecting.png`) });
    await page.evaluate(() => (window as any).__desktopUi.ready());
    await page.locator('[data-phase="ready"]').waitFor();
    const surfaceBefore = await page.locator(".cloud-desktop-panel__surface").boundingBox();
    const toolbarBefore = await page.locator(".cloud-desktop-panel__toolbar").boundingBox();
    await activate(page.getByRole("button", { name: "Take control", exact: true }));
    const cancel = page.getByRole("button", { name: "Cancel", exact: true }); await cancel.waitFor();
    assert.equal(await cancel.locator(".ui-button__label").evaluate(element => getComputedStyle(element).opacity), "1");
    assert.deepEqual(await page.locator(".cloud-desktop-panel__surface").boundingBox(), surfaceBefore,
      "pending control cannot move the desktop");
    await activate(cancel);
    await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
    await activate(page.getByRole("button", { name: "Take control", exact: true }));
    await page.evaluate(() => (window as any).__desktopUi.grant());
    await page.getByRole("button", { name: "Stop controlling", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "CANVAS");
    assert.deepEqual(await page.locator(".cloud-desktop-panel__toolbar").boundingBox(), toolbarBefore);
    await page.screenshot({ path: join(directory, `${theme}-${width}-ready.png`) });
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
    await page.evaluate(() => (window as any).__desktopUi.ready(false));
    assert.equal(await page.getByRole("button", { name: "Take control", exact: true }).isDisabled(), true);
    await page.evaluate(() => (window as any).__desktopUi.fail());
    await page.getByRole("heading", { name: "Desktop unavailable" }).waitFor();
    await page.screenshot({ path: join(directory, `${theme}-${width}-failed.png`) });
    await page.evaluate(() => (window as any).__desktopUi.connecting());
    await activate(page.getByRole("button", { name: "Reconnect", exact: true }));
    await title.waitFor();
    await page.evaluate(() => (window as any).__desktopUi.ready());
    await page.locator('[data-phase="ready"]').waitFor();
    const counts = await page.evaluate(() => (window as any).__desktopUi.counts());
    assert.equal(counts.preparations, 2); assert.equal(counts.mounts, 2);
    assert.equal(await page.evaluate(() => (window as any).__surfaceBefore === document.querySelector(".cloud-desktop-panel__surface")), true);
    await page.evaluate(() => (window as any).__desktopUi.unavailable());
    await page.getByRole("heading", { name: "Desktop unavailable" }).waitFor();
    await page.screenshot({ path: join(directory, `${theme}-${width}-unavailable.png`) });
    await page.evaluate(() => (window as any).__desktopUi.locale("zh-CN"));
    await page.getByRole("heading", { name: "桌面暂不可用" }).waitFor();
    await page.screenshot({ path: join(directory, `${theme}-${width}-zh-unavailable.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    receipts.push({ theme, width, feedbackStyle, counts });
    await page.evaluate(() => (window as any).__desktopUi.dispose()); await page.close();
  }
  console.log(JSON.stringify({ passed: true, directory, receipts,
    scope: "Real panel/controller/current production CSS; only backend/media boundaries synthetic. Not native-control or production authorization acceptance." }, null, 2));
} finally {
  await browser?.close(); await new Promise<void>(yes => server.close(() => yes()));
}
