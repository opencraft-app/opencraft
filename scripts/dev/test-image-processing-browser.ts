import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, preview } from "vite";
const outDir = await mkdtemp(join(tmpdir(), "image-processing-build-"));
await build({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  worker: { format: "es" },
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: { input: "tests/fixtures/image-processing.html" },
  },
});
const server = await preview({
  configFile: false,
  root: process.cwd(),
  build: { outDir },
  preview: { host: "127.0.0.1", port: 0 },
});
const pw = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await pw.chromium.launch({
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.addInitScript("globalThis.__name = value => value;");
  const errors: string[] = [];
  const wasm: number[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().endsWith(".wasm")) wasm.push(response.status());
  });
  await page.goto(
    `http://127.0.0.1:${(server.httpServer.address() as any).port}/tests/fixtures/image-processing.html`,
  );
  await page.waitForFunction(() => (window as any).images);
  const result = await page.evaluate(async () => {
    const service = (window as any).images;
    const canvas = new OffscreenCanvas(3000, 1500);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ff0022";
    ctx.fillRect(30, 30, 2400, 1000);
    ctx.font = "40px sans-serif";
    ctx.fillStyle = "#111";
    ctx.fillText("Screenshot clarity / 中文", 80, 90);
    const png = await canvas.convertToBlob({ type: "image/png" });
    const stages: string[] = [];
    const optimized = await service.compress(png, {
      onProgress: (stage: string) => stages.push(stage),
    });
    if (
      optimized.reason === "codec-failed" ||
      optimized.reason === "codec-unavailable"
    )
      throw new Error(optimized.reason);
    const decoded = await createImageBitmap(optimized.blob);
    const check = new OffscreenCanvas(decoded.width, decoded.height).getContext(
      "2d",
    )!;
    check.drawImage(decoded, 0, 0);
    const before = ctx.getImageData(0, 0, 3000, 1500).data;
    const after = check.getImageData(0, 0, 3000, 1500).data;
    const pixelsEqual = before.every((value, index) => value === after[index]);
    decoded.close();
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 1 });
    const file = new File([jpeg], "photo.jpeg", { type: "image/jpeg" });
    const attachment = await (window as any).resolveBrowserAttachment(
      file,
      {
        id: "test",
        name: file.name,
        mimeType: file.type,
        size: file.size,
        uri: null,
        lifecycle: "pending",
        error: null,
      },
      undefined,
      service,
    );
    const uploaded = await (await fetch(attachment.uri)).blob();
    const dimensions = await createImageBitmap(uploaded);
    const width = dimensions.width;
    dimensions.close();
    const abort = new AbortController();
    const pending = service.compress(png, { signal: abort.signal });
    abort.abort();
    let cancelled = false;
    try {
      await pending;
    } catch (error) {
      cancelled = (error as Error).name === "AbortError";
    }
    const unknown = new Blob(["GIF89a"], { type: "image/gif" });
    const kept = await service.compress(unknown);
    const sourceBytes = new Uint8Array(await png.arrayBuffer());
    const animatedBytes = new Uint8Array(sourceBytes.length + 20);
    animatedBytes.set(sourceBytes.subarray(0, 33));
    animatedBytes.set([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 2], 33);
    animatedBytes.set(sourceBytes.subarray(33), 53);
    const animated = new Blob([animatedBytes], { type: "image/png" });
    const animatedResult = await service.compress(animated);
    const animationPreserved =
      animatedResult.reason === "unsupported-or-animated" &&
      animatedResult.blob.size === animated.size;
    new DataView(sourceBytes.buffer).setUint32(16, 25000);
    let budgetRejected = false;
    try {
      await service.compress(new Blob([sourceBytes], { type: "image/png" }));
    } catch (error) {
      budgetRejected = (error as Error).message.includes("safe decoding limit");
    }
    return {
      pngBefore: png.size,
      pngAfter: optimized.blob.size,
      pixelsEqual,
      jpegBefore: jpeg.size,
      jpegAfter: uploaded.size,
      mime: attachment.mimeType,
      size: attachment.size,
      width,
      cancelled,
      unsupportedPreserved: (await kept.blob.text()) === "GIF89a",
      animationPreserved,
      budgetRejected,
      stages,
    };
  });
  assert.equal(result.pixelsEqual, true);
  assert.ok(
    result.pngAfter < result.pngBefore,
    "fixture PNG must actually be optimized, not silently fall back",
  );
  assert.ok(result.jpegAfter < result.jpegBefore);
  assert.equal(result.mime, "image/jpeg");
  assert.equal(result.size, result.jpegAfter);
  assert.equal(result.width, 2560);
  assert.equal(result.cancelled, true);
  assert.equal(result.unsupportedPreserved, true);
  assert.equal(result.animationPreserved, true);
  assert.equal(result.budgetRejected, true);
  assert.ok(wasm.includes(200), "built WASM asset must actually load");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...result, wasm, outDir }));
} finally {
  await browser.close();
  await new Promise<void>((resolve) =>
    server.httpServer.close(() => resolve()),
  );
}
