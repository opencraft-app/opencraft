import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const root = await mkdtemp(join(tmpdir(), "annotation-crop-"));
for (const [entry, out] of [
  ["screenshot.ts", "screenshot.js"],
  ["screenshot.worker.ts", "screenshot.worker.ts"],
])
  await build({
    entryPoints: ["apps/workbench-web/src/browser-annotation/" + entry],
    outfile: join(root, out),
    bundle: true,
    format: "esm",
    platform: "browser",
  });
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "text/javascript");
  try {
    res.end(
      await readFile(
        join(
          root,
          req.url === "/worker"
            ? "screenshot.worker.ts"
            : req.url === "/screenshot.js"
              ? "screenshot.js"
              : "screenshot.worker.ts",
        ),
      ),
    );
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(origin + "/screenshot.js");
  const result = await page.evaluate(async (origin) => {
    const { cropAnnotationScreenshot } = await import(origin + "/screenshot.js");
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = "blue";
    ctx.fillRect(100, 0, 200, 200);
    const blob = await new Promise((r) => canvas.toBlob(r));
    const raw = await new Promise((r) => {
      const f = new FileReader();
      f.onload = () => r(f.result);
      f.readAsDataURL(blob);
    });
    HTMLCanvasElement.prototype.toDataURL = () => {
      throw Error("synchronous encoding forbidden");
    };
    const NativeWorker = Worker;
    let created = 0,
      terminated = 0;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        created++;
      }
      terminate() {
        terminated++;
        super.terminate();
      }
    };
    const region = { left: 0.25, right: 0.75, top: 0, bottom: 1 };
    const workerImage = await cropAnnotationScreenshot(raw, region, new AbortController().signal);
    const offscreen = window.OffscreenCanvas;
    window.OffscreenCanvas = undefined;
    const fallbackImage = await cropAnnotationScreenshot(raw, region, new AbortController().signal);
    window.OffscreenCanvas = offscreen;
    const check = async (image) => {
      const bitmap = await createImageBitmap(await (await fetch(image)).blob());
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      const x = c.getContext("2d");
      x.drawImage(bitmap, 0, 0);
      const p = x.getImageData(0, 0, c.width, c.height).data;
      let blue = true;
      for (let i = 0; i < p.length; i += 4) if (p[i] > 20 || p[i + 2] < 230) blue = false;
      return { width: c.width, height: c.height, blue };
    };
    const aborted = new AbortController();
    aborted.abort();
    let cancelled = false;
    try {
      await cropAnnotationScreenshot(raw, region, aborted.signal);
    } catch {
      cancelled = true;
    }
    return { worker: await check(workerImage), fallback: await check(fallbackImage), created, terminated, cancelled };
  }, origin);
  assert.deepEqual(result.worker, { width: 200, height: 200, blue: true });
  assert.deepEqual(result.fallback, result.worker);
  assert.equal(result.created, 1);
  assert.equal(result.terminated, 1);
  assert.equal(result.cancelled, true);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
