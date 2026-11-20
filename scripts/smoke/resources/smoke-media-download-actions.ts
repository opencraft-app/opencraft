import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, type UserConfig } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let video: Buffer = Buffer.alloc(0);
const wave = Buffer.alloc(44 + 16000); wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(16000, 40);
const aliasPlugin: NonNullable<UserConfig["plugins"]>[number] = { name: "workspace-media-runtime", enforce: "pre", resolveId(source, importer) {
  if (source.endsWith("/appserver-runtime-context") && importer?.includes("/panels/")) return resolve("tests/fixtures/workspace-media-runtime.ts");
  return null;
} };
const html = '<!doctype html><html><body><div id="host"></div><script type="module" src="/tests/fixtures/workspace-media-preview.tsx"></script></body></html>';
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"], alias: [{ find: resolve("apps/workbench-web/src/runtime/appserver-runtime-context.tsx"), replacement: resolve("tests/fixtures/workspace-media-runtime.ts") }] },
  cacheDir: "node_modules/.vite-workspace-media-smoke", server: { host: "127.0.0.1", port: 0 },
  plugins: [aliasPlugin, { name: "workspace-media-smoke", configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url === "/") { response.setHeader("content-type", "text/html"); response.end(html); return; }
    const files: Record<string, Buffer> = { "/fixture/voice.wav": wave, "/fixture/clip.webm": video };
    const file = files[request.url ?? ""]; if (file === undefined) { next(); return; }
    response.setHeader("content-type", "application/octet-stream"); response.end(file);
  }); } }],
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  video = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d")!; context.fillStyle = "red"; context.fillRect(0, 0, 32, 32);
    const stream = canvas.captureStream(10); const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    return new Promise<number[]>(resolve => {
      const chunks: Blob[] = []; recorder.ondataavailable = event => chunks.push(event.data);
      recorder.onstop = () => { stream.getTracks().forEach(track => track.stop()); void new Blob(chunks).arrayBuffer().then(data => resolve([...new Uint8Array(data)])); };
      recorder.start(); setTimeout(() => recorder.stop(), 300);
    });
  }));
  // The file panel owns downloads; successful media previews must not add a footer action.
  for (const { width, touch } of [{ width: 390, touch: true }, { width: 820, touch: true }, { width: 1280, touch: false }]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch });
    const mediaPage = await context.newPage();
    mediaPage.on("pageerror", error => errors.push(error.message));
    await mediaPage.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    for (const theme of ["Light", "Dark"]) {
      await mediaPage.getByRole("button", { name: theme, exact: true }).click();
      for (const name of ["clip.webm", "voice.wav"]) {
        await mediaPage.getByRole("link", { name: `/fixture/${name}`, exact: true }).click();
        const player = mediaPage.locator(name === "clip.webm" ? "video" : "audio");
        await player.waitFor();
        await mediaPage.waitForFunction(() => ((document.querySelector("video,audio") as HTMLMediaElement | null)?.readyState ?? 0) >= 1, undefined, { timeout: 15000 });
        assert.equal(await player.evaluate(node => (node as HTMLMediaElement).controls), true, "keep native playback controls");
        assert.equal(await mediaPage.locator(".file-media-preview button").count(), 0, "no duplicate footer download");
        const trigger = mediaPage.getByRole("button", { name: "File actions", exact: true });
        if (touch) await trigger.tap(); else { await trigger.focus(); await mediaPage.keyboard.press("ArrowDown"); }
        const downloadItem = mediaPage.locator(".workspace-file-menu__item[download]");
        await downloadItem.waitFor(); assert.equal(await downloadItem.count(), 1);
        await mediaPage.locator(".workspace-file-menu").evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))); });
        const geometry = await downloadItem.evaluate(node => ({ height: node.getBoundingClientRect().height, decoration: getComputedStyle(node).textDecorationLine }));
        assert.equal(geometry.decoration, "none", "menu action must not inherit link underline");
        if (touch) assert.ok(geometry.height >= 44, "shared touch-density target must remain at least 44px");
        if (!touch) { await downloadItem.hover(); assert.equal(await downloadItem.evaluate(node => getComputedStyle(node).textDecorationLine), "none"); }
        await downloadItem.focus(); assert.equal(await downloadItem.evaluate(node => getComputedStyle(node).textDecorationLine), "none");
        await mediaPage.screenshot({ fullPage: true, path: `/tmp/opencraft-media-download-${width}-${theme}-${name}.png` });
        const downloading = mediaPage.waitForEvent("download");
        if (touch) await downloadItem.tap(); else await mediaPage.keyboard.press("Enter");
        const original = await downloading;
        assert.equal(original.suggestedFilename(), name);
        assert.deepEqual(await readFile((await original.path())!), name === "clip.webm" ? video : wave, "menu downloads original media bytes");
        if (await mediaPage.locator(".workspace-file-menu").isVisible()) await mediaPage.keyboard.press("Escape");
        assert.ok(await mediaPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "media must not overflow phone/tablet viewport");
        await player.evaluate(node => node.dispatchEvent(new Event("error")));
        await mediaPage.getByText("Preview unavailable. Download this file to open it.", { exact: true }).waitFor();
        assert.equal(await mediaPage.locator(".file-media-preview button").count(), 0, "error state must not restore a duplicate download");
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("Media downloads: phone/tablet touch and desktop keyboard; light/dark; native controls, no footer duplicate, no underline, original bytes, error fallback and overflow passed.");
} finally { await browser?.close(); await vite.close(); }
