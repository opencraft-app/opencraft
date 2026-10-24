import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/composer-corners";
await mkdir(output, { recursive: true });
const css = process.env.OPENCRAFT_SMOKE_CSS ? await readFile(process.env.OPENCRAFT_SMOKE_CSS, "utf8") : null;
const server = await createServer({ root: process.cwd(), configFile: false, cacheDir: "node_modules/.vite-composer-corners", logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "composer-corners", resolveId: id => id === "/corner.css" ? id : null, load: id => id === "/corner.css" ? css : null,
 transform(code, id) { return css !== null && id.endsWith("/tests/fixtures/touch-newera.tsx") ? code.replace('import "../../apps/workbench-web/src/styles/app.scss";', 'import "/corner.css";') : null; },
 configureServer(vite) { vite.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/?")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>'); }); }
}] });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const results: unknown[] = [];
try {
 for (const width of [1280, 320, 390]) for (const mode of ["light", "dark"]) for (const newera of [false, true]) {
  const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width < 768 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`${server.resolvedUrls!.local[0]}?palette=neutral&mode=${mode}&pickerFocus&corners`);
  const editor = page.locator(".opencraft-composer-editor"); await editor.waitFor();
  await page.evaluate(({ width, newera }) => { (window as any).setTouch(width < 768); (window as any).setNewera(newera); }, { width, newera });
  await editor.fill("保留草稿与焦点"); await page.waitForTimeout(180);
  await editor.evaluate(node => { (window as any).keptEditor = node; });
  const initial = await page.locator(".opencraft-composer-stack").boundingBox();
  // Desktop cuts off transcript before the lower rounded corners.
  // Touch keeps the lower corners and safe-area gutter floating.
  await page.locator(".thread-scroll-footer").evaluate(node => {
   const marker = document.createElement("div"); marker.id = "corner-activity-probe";
   marker.setAttribute("aria-hidden", "true"); marker.style.cssText = "position:absolute;inset:0;z-index:0;pointer-events:none;background:#ff00ff";
   node.prepend(marker);
  });
  const shell = page.locator(".opencraft-composer-shell"); const bounds = (await shell.boundingBox())!;
  for (const side of ["left", "right"] as const) {
   const clip = { x: Math.round(side === "left" ? bounds.x + 1 : bounds.x + bounds.width - 5), y: Math.round(bounds.y + bounds.height - 5), width: 3, height: 3 };
   const before = await page.screenshot({ clip });
   await page.locator("#corner-activity-probe").evaluate(node => { (node as HTMLElement).style.background = "#00ff00"; });
   const after = await page.screenshot({ clip });
   assert.equal(before.equals(after), width >= 768, `${width}/${mode}/${newera}/${side}: desktop hides transcript outside lower corners; touch floats`);
   await page.locator("#corner-activity-probe").evaluate(node => { (node as HTMLElement).style.background = "#ff00ff"; });
  }
  // Change input density on the SAME editor; width must not choose the paint.
  await editor.click();
  for (const touch of [false, true]) {
   await page.evaluate(touch => (window as any).setTouch(touch), touch);
   await page.waitForTimeout(60);
   const footerNode = page.locator(".thread-scroll-footer");
   const footer = (await footerNode.boundingBox())!;
   if (!touch) {
    const shellBounds = (await shell.boundingBox())!;
    const radius = await shell.evaluate(node => parseFloat(getComputedStyle(node).borderBottomLeftRadius));
    const coverHeight = await footerNode.evaluate(node => parseFloat(getComputedStyle(node, "::after").height));
    const cutoff = footer.y + footer.height - coverHeight;
    assert(cutoff <= shellBounds.y + shellBounds.height - radius + 1, "desktop cutoff starts before the lower corner arc");
    for (const x of [footer.x + 2, footer.x + footer.width / 2, footer.x + footer.width - 5]) {
     const clip = { x: Math.round(x), y: Math.ceil(cutoff + 2), width: 3, height: 3 };
     const before = await page.screenshot({ clip });
     await page.locator("#corner-activity-probe").evaluate(node => { (node as HTMLElement).style.background = "#00ff00"; });
     assert(before.equals(await page.screenshot({ clip })), "desktop cutoff is opaque across the full footer width");
     await page.locator("#corner-activity-probe").evaluate(node => { (node as HTMLElement).style.background = "#ff00ff"; });
    }
   }
   const gutter = { x: Math.round(footer.x + footer.width / 2), y: Math.floor(footer.y + footer.height - 5), width: 3, height: 3 };
   const before = await page.screenshot({ clip: gutter });
   await page.locator("#corner-activity-probe").evaluate(node => { (node as HTMLElement).style.background = "#00ff00"; });
   const after = await page.screenshot({ clip: gutter });
   assert.equal(before.equals(after), !touch, `${width}/${mode}/${newera}: desktop clips straight; touch gutter floats`);
   assert(await editor.evaluate(node => node === (window as any).keptEditor && node.contains(document.activeElement)), "density switch retains editor and focus");
   assert.equal(await editor.innerText(), "保留草稿与焦点");
   await page.locator("#corner-activity-probe").evaluate(node => { (node as HTMLElement).style.background = "#ff00ff"; });
  }
  await page.evaluate(touch => (window as any).setTouch(touch), width < 768);
  await page.waitForTimeout(60);
  assert.deepEqual(await page.locator(".opencraft-composer-stack").boundingBox(), initial, "exterior material adds no height");
  await page.locator("#corner-activity-probe").evaluate(node => node.remove());
  await editor.click();
  assert(await editor.evaluate(node => node === (window as any).keptEditor && node.contains(document.activeElement)), "same editor retains focus");
  assert.equal(await editor.innerText(), "保留草稿与焦点");
  const modelTrigger = page.locator(".opencraft-composer-mode--intelligence");
  await modelTrigger.focus(); await modelTrigger.press("Enter");
  await page.locator(".opencraft-composer-model-quick[data-state=open], .opencraft-composer-selection-menu--intelligence[data-state=open]").waitFor(); await page.keyboard.press("Escape");
  await page.evaluate(() => (window as any).setQueue(true)); await page.waitForTimeout(60);
  assert.equal(await shell.evaluate(node => getComputedStyle(node).overflow), "visible", "menus are not clipped");
  if (width === 390 || width === 1280) await page.screenshot({ path: `${output}/${width}-${mode}-${newera}.png` });
  assert.deepEqual(errors, []); results.push({ width, mode, newera, bounds }); console.log(`PASS ${width}/${mode}/${newera}`); await page.close();
 }
 await writeFile(`${output}/geometry.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); await server.close(); }
