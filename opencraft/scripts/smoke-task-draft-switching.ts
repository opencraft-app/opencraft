import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const bundle = await build({ entryPoints: ["tests/fixtures/task-draft-switching.tsx"], bundle: true, write: false,
  format: "esm", platform: "browser", jsx: "automatic", loader: { ".scss": "empty", ".css": "empty" } });
const assets = resolve("apps/workbench-web/dist/assets");
const css = Buffer.concat(await Promise.all((await readdir(assets)).filter(name => name.endsWith(".css")).map(name => readFile(join(assets, name)))));
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") { response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0]!.contents); }
  else if (request.url === "/fixture.css") { response.setHeader("content-type", "text/css"); response.end(css); }
  else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{min-height:100%;margin:0}#root{padding:24px 12px}main{max-width:760px;margin:auto}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhWQAAAAASUVORK5CYII=", "base64");
const markdownBytes = Buffer.from("# 草稿\r\n\n- exact bytes survive task selection\n");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, isMobile: width === 390 });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(origin);
    const editor = page.locator('.codex-composer-editor[role="textbox"]');
    await editor.waitFor();
    await editor.fill(`Task A unfinished ${width}`);
    const choose = async () => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      return chooser;
    };
    await (await choose()).setFiles([
      { name: "capture.png", mimeType: "image/png", buffer: imageBytes },
      { name: "notes.md", mimeType: "text/markdown", buffer: markdownBytes },
    ]);
    await page.locator('.codex-composer-image-attachment img').waitFor();
    await page.getByText("notes.md", { exact: true }).waitFor();
    const before = await page.evaluate(() => (window as any).__taskDraftFixture.snapshot());
    const image = before.attachments.find((asset: any) => asset.name === "capture.png");
    assert.match(image.previewUrl, /^blob:/u);
    assert.deepEqual(before.attachments.map((asset: any) => asset.lifecycle), ["processing", "uploading"]);
    await page.evaluate(() => (window as any).__taskDraftFixture.select("b"));
    await page.waitForFunction(() => document.querySelector('.codex-composer-placeholder') !== null);
    await editor.fill("Task B independent");
    const b = await page.evaluate(() => (window as any).__taskDraftFixture.completeFiles());
    assert.equal(b.text, "Task B independent"); assert.deepEqual(b.attachments, []);
    assert.equal(b.jobs.every((job: any) => !job.aborted), true);
    await page.evaluate(() => (window as any).__taskDraftFixture.select("a"));
    await page.waitForFunction(text => document.querySelector('.codex-composer-editor')?.textContent === text, `Task A unfinished ${width}`);
    const returned = await page.evaluate(() => (window as any).__taskDraftFixture.snapshot());
    assert.equal(returned.sameOriginalController, true);
    assert.equal(returned.viewId, before.viewId); assert.equal(returned.draftId, before.draftId);
    assert.equal(returned.attachments[0].previewUrl, image.previewUrl);
    assert.deepEqual(returned.attachments.map((asset: any) => asset.lifecycle), ["ready", "ready"]);
    assert.deepEqual(await page.evaluate(async preview => Array.from(new Uint8Array(await (await fetch(preview)).arrayBuffer())), image.previewUrl), Array.from(imageBytes));
    const retainedFiles = await page.evaluate(() => (window as any).__taskDraftFixture.retainedFileBytes());
    assert.deepEqual(retainedFiles.find((file: any) => file.name === "notes.md").bytes, Array.from(markdownBytes));
    await page.waitForFunction(() => (document.querySelector('.codex-composer-image-attachment img') as HTMLImageElement | null)?.naturalWidth === 1);
    const visited = await page.evaluate(() => (window as any).__taskDraftFixture.visitContent(25));
    assert.equal(visited.originalViewCached, false); assert.equal(visited.originalOwnerRetained, true);
    await page.evaluate(() => (window as any).__taskDraftFixture.select("a"));
    await page.waitForFunction(text => document.querySelector('.codex-composer-editor')?.textContent === text, `Task A unfinished ${width}`);
    assert.equal((await page.evaluate(() => (window as any).__taskDraftFixture.snapshot())).sameOriginalController, true);
    const failed = await page.evaluate(() => (window as any).__taskDraftFixture.settle("failed"));
    assert.equal(failed.draftId, before.draftId); assert.equal(failed.attachments[0].previewUrl, image.previewUrl);
    const accepted = await page.evaluate(() => (window as any).__taskDraftFixture.settle("accepted"));
    assert.equal(accepted.hasContent, false); assert.deepEqual(accepted.attachments, []);
    await page.locator('.codex-composer-image-attachment').waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(async preview => { try { await fetch(preview); return false; } catch { return true; } }, image.previewUrl), true);
    await (await choose()).setFiles({ name: "revoke.png", mimeType: "image/png", buffer: imageBytes });
    await page.locator('.codex-composer-image-attachment').waitFor();
    const revoked = await page.evaluate(() => (window as any).__taskDraftFixture.revoke());
    assert.equal(revoked.hasContent, false); assert.equal(revoked.jobs.at(-1).aborted, true);
    await page.evaluate(() => (window as any).__taskDraftFixture.completeFiles());
    await page.locator('.codex-composer-image-attachment').waitFor({ state: "hidden" });
    assert.equal((await page.evaluate(() => (window as any).__taskDraftFixture.snapshot())).sends, 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px real Task editor: completed A→B→A, exact image/Markdown bytes, late preparation, >20 Views, failed/accepted settlement and account revoke; no sends`);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise<void>(done => server.close(() => done()));
}
