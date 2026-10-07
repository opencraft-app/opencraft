import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";
import { SpeechTranscriptionService, validateSpeechWav } from "./speech-transcription-service.mjs";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ entryPoints: ["tests/fixtures/hunyuan-dictation.tsx"], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic" });
const root = await mkdtemp(join(tmpdir(), "opencraft-hunyuan-browser-"));
const assets = resolve("apps/workbench-web/dist/assets");
let cssName: string | undefined;
for (const name of await readdir(assets)) if (name.endsWith(".css") && (await readFile(join(assets, name), "utf8")).includes(".codex-composer-voice-footer")) { cssName = name; break; }
assert.ok(cssName, "Build this checkout's Web CSS first");
await writeFile(join(root, "fixture.js"), bundle.outputFiles[0]!.contents);
await writeFile(join(root, "fixture.css"), await readFile(join(assets, cssName)));
await writeFile(join(root, "index.html"), '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
let mode: "success" | "fail-once" | "held" = "success", calls = 0, serviceNow = Date.now();
let release: (() => void) | null = null;
const service = new SpeechTranscriptionService({ apiKey: "synthetic-test-key", now: () => serviceNow, fetch: async (_url: string, init: RequestInit) => {
  calls++; const value = JSON.parse(String(init.body)); validateSpeechWav(Buffer.from(value.data, "base64"));
  if (mode === "held") await new Promise<void>(resolve => { release = resolve; });
  if (mode === "fail-once") { mode = "success"; return new Response("must not leak vendor body", { status: 500 }); }
  return Response.json({ status: "completed", output: { text: "混元测试文字" } });
} });
const server = await createWorkbenchWebServer({ root, appServerTarget: null, loopbackOnly: true, speechService: service });
let browser: any;
try {
  const address = await server.listen({ host: "127.0.0.1", port: 0 }); const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) for (const colorScheme of ["light", "dark"]) {
    // Each presentation case gets a fresh quota window; production limits stay unchanged.
    serviceNow += 60_000;
    const context = await browser.newContext({ viewport, colorScheme, hasTouch: viewport.width === 390 });
    // Hold only browser readiness delivery; the provider/Composer stay real.
    // Chromium uses its synthetic microphone, never a physical input device.
    await context.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await capture(constraints);
        if (!(window as any).__holdCaptureReady) return stream;
        (window as any).__heldCaptureStream = stream;
        return new Promise<MediaStream>(resolve => { (window as any).__releaseCaptureReady = () => resolve(stream); });
      };
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    const load = async () => { await page.goto(origin); await page.locator(".ProseMirror").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), colorScheme);
      await page.getByRole("combobox", { name: "识别方式" }).selectOption("hunyuan"); await page.waitForFunction(() => !(document.querySelector(".opencraft-voice-input-action") as HTMLButtonElement)?.disabled); };
    const start = async () => { await page.locator(".opencraft-voice-input-action").click(); await page.locator('[data-voice-phase="listening"]').waitFor(); await page.waitForTimeout(500); };
    const editor = page.locator(".ProseMirror");
    for (const action of ["cancel", "replace", "ready"] as const) {
      await load();
      const beforeCalls = calls;
      await page.evaluate(() => { (window as any).__holdCaptureReady = true; (window as any).__startupEditor = document.querySelector(".ProseMirror"); });
      await page.locator(".opencraft-voice-input-action").click();
      const starting = page.locator('[data-voice-phase="starting"]');
      await starting.waitFor();
      await page.waitForFunction(() => typeof (window as any).__releaseCaptureReady === "function");
      assert.equal(await starting.locator(".ui-progress-indicator").isVisible(), true);
      assert.equal(await starting.locator(".codex-composer-voice-footer__status-label, canvas").count(), 0);
      assert.equal(await starting.getByRole("status").textContent(), "正在准备录音");
      assert.equal(await page.locator(".opencraft-voice-input-action").getAttribute("title"), "正在准备录音，点击取消");
      assert.equal(await page.getByRole("button", { name: "取消语音输入", exact: true }).isEnabled(), true);
      assert.equal(await page.getByRole("button", { name: "停止并写入文字", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "识别完成后发送", exact: true }).isDisabled(), true);
      assert.equal(await editor.textContent(), "Original text");
      const initialGeometry = await starting.boundingBox();
      assert.ok(initialGeometry && initialGeometry.width <= viewport.width && initialGeometry.height < 70);
      if (action === "ready") {
        const spinner = starting.locator(".ui-progress-indicator");
        await page.waitForFunction(() => (document.querySelector(".ui-progress-indicator")?.getAnimations().length ?? 0) > 0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForFunction(() => (document.querySelector(".ui-progress-indicator")?.getAnimations().length ?? 0) === 0);
        assert.equal(await spinner.evaluate((node: HTMLElement) => getComputedStyle(node).animationName), "none");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.evaluate(() => (window as any).__releaseCaptureReady());
        const listening = page.locator('[data-voice-phase="listening"]');
        await listening.waitFor();
        assert.equal(await listening.locator("canvas").isVisible(), true);
        assert.equal(await listening.locator(".ui-progress-indicator").count(), 0);
        const readyGeometry = await listening.boundingBox();
        assert.ok(readyGeometry);
        for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(readyGeometry[key] - initialGeometry[key]) < 1, `readiness preserves Footer ${key}`);
        await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
      } else {
        if (action === "cancel") await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
        else await page.evaluate(() => (window as any).__hunyuanFixture.replace());
        await page.locator(".codex-composer-voice-footer").waitFor({ state: "hidden" });
        await page.evaluate(() => (window as any).__releaseCaptureReady());
        await page.waitForFunction(() => (window as any).__heldCaptureStream.getTracks().every((track: MediaStreamTrack) => track.readyState === "ended"));
      }
      assert.equal(await page.evaluate(() => (window as any).__startupEditor === document.querySelector(".ProseMirror")), true);
      assert.equal(await page.locator(".codex-composer-voice-footer").count(), 0);
      assert.equal(await editor.textContent(), action === "replace" ? "Replacement" : "Original text");
      assert.deepEqual(await page.evaluate(() => (window as any).__hunyuanFixture.sent), []);
      assert.equal(calls, beforeCalls);
    }
    mode = "success"; await load(); await start(); assert.equal(await editor.textContent(), "Original text");
    await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent === "Original text 混元测试文字").catch(async error => {
      console.log(JSON.stringify({ viewport, colorScheme, calls, errors, syntheticState: await page.evaluate(() => ({ text: document.querySelector(".ProseMirror")?.textContent,
        mic: document.querySelector(".opencraft-voice-input-action")?.getAttribute("title"), footer: document.querySelector(".codex-composer-voice-footer")?.getAttribute("data-voice-phase") })) }));
      throw error;
    });
    assert.deepEqual(await page.evaluate(() => (window as any).__hunyuanFixture.sent), []);
    await load(); await start();
    await page.getByRole("button", { name: "识别完成后发送", exact: true }).click();
    await page.waitForFunction(() => (window as any).__hunyuanFixture.sent.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).__hunyuanFixture.sent), ["Original text 混元测试文字"]);
    mode = "fail-once"; await load(); await start();
    await page.getByRole("button", { name: "识别完成后发送", exact: true }).click();
    await page.getByRole("button", { name: "重试语音识别", exact: true }).waitFor();
    const geometry = await page.locator(".codex-composer-voice-footer").boundingBox();
    assert.ok(geometry && geometry.width <= viewport.width && geometry.height < 70);
    if (process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR}/speech-retry-${viewport.width}-${colorScheme}.png` });
    assert.equal(await editor.textContent(), "Original text"); const before = calls;
    await page.getByRole("button", { name: "重试语音识别", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent === "Original text 混元测试文字");
    assert.equal(calls, before + 1); assert.deepEqual(await page.evaluate(() => (window as any).__hunyuanFixture.sent), []);
    for (const action of ["cancel", "replace"]) {
      mode = "held"; await load(); await start(); release = null; const before = calls;
      await page.getByRole("button", { name: "停止并写入文字", exact: true }).click();
      for (let tries = 0; tries < 50 && calls === before; tries++) await page.waitForTimeout(50);
      assert.equal(calls, before + 1);
      if (action === "cancel") await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
      else await page.evaluate(() => (window as any).__hunyuanFixture.replace());
      release?.(); await page.waitForTimeout(200);
      assert.equal(await editor.textContent(), action === "cancel" ? "Original text" : "Replacement");
      assert.deepEqual(await page.evaluate(() => (window as any).__hunyuanFixture.sent), []);
    }
    mode = "success"; await load();
    await page.getByRole("combobox", { name: "识别方式" }).selectOption("system");
    await page.getByRole("combobox", { name: "识别方式" }).selectOption("hunyuan");
    assert.deepEqual(errors, []); await context.close();
  }
  console.log("PASS desktop/touch light/dark: actual Browser capture + WAV + HTTP service + Composer + settings; text-free held startup, neutral announcement, readiness-only waveform, reduced motion, pending cancel/replacement and stable Footer/editor; final-only insertion, same-audio retry revokes send intent, late output fenced; only microphone device/readiness delivery and paid vendor simulated");
} finally { release?.(); await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
