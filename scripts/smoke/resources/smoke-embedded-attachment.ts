import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, open, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { LocalAttachmentStagingService } from "../../../apps/local-agent-host/src/attachments/local-attachment-staging";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = await mkdtemp(join(tmpdir(), "embedded-attachment-"));
const service = new LocalAttachmentStagingService(join(root, "stored"));
let chunks = 0;
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {LocaleRuntime} from '@opencraft/i18n';
import {IntlRuntimeProvider} from '@opencraft/i18n/react';
import {createComposerController} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {embeddedLocaleCatalogs} from './apps/workbench-web/src/i18n/catalogs';
import {resolveBrowserAttachment} from './apps/workbench-web/src/runtime/browser-attachment-resolver';
const locale=new LocaleRuntime(embeddedLocaleCatalogs);await locale.update({localeOverride:'en-US'});
const controller=createComposerController({type:'new-thread',draftId:'embedded',execution:{hostId:'test',workspace:{cwd:'/test',runtimeWorkspaceRoots:['/test']}}},{now:Date.now,createId:()=>crypto.randomUUID()});
globalThis.snapshot=()=>controller.getSnapshot();globalThis.reset=()=>controller.dispatch({type:'reset-all'});
globalThis.reads=0;
createRoot(document.getElementById('root')).render(<IntlRuntimeProvider runtime={locale}><OpenCraftComposer controller={controller} modelSelectionPolicy="session" onSubmit={()=>false} onCancel={()=>{}}
onResolveAttachment={(file,pending,signal)=>{const slice=file.slice.bind(file);file.arrayBuffer=()=>{throw new Error('Whole-file read forbidden')};file.slice=(start,end)=>{globalThis.reads++;return slice(start,end)};return resolveBrowserAttachment(file,pending,{maxBytes:1024**3,chunkBytes:1024**2,stage:()=>{throw new Error('One-shot forbidden')},uploadChunk:params=>globalThis.rpc('attachment/uploadChunk',params),uploadCancel:uploadId=>globalThis.rpc('attachment/uploadCancel',{uploadId})},undefined,signal);}} /></IntlRuntimeProvider>);
` }, bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", loader: { ".scss": "empty", ".css": "empty" } });
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0]!.text); }
  else res.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
});
let browser: any;
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.exposeFunction("rpc", async (method: string, params: any) => { if (method === "attachment/uploadChunk") chunks++; return service.handle(method, params); });
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
  const small = join(root, "recording.bin"), oversized = join(root, "too-large.bin");
  for (const [path, size] of [[small, 2 * 1024 * 1024 + 3], [oversized, 1024 ** 3 + 1]] as const) {
    const f = await open(path, "wx"); try { await f.truncate(size); } finally { await f.close(); }
  }
  const choose = async (path: string) => {
    const [picker] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Attach files", exact: true }).click()]);
    await picker.setFiles(path);
  };
  await choose(small);
  await page.waitForFunction(() => (globalThis as any).snapshot().draft.attachments[0]?.lifecycle === "ready").catch(async error => { console.error(JSON.stringify({snapshot:await page.evaluate(()=>(globalThis as any).snapshot()),errors,chunks})); throw error; });
  const attachment = await page.evaluate(() => (globalThis as any).snapshot().draft.attachments[0]);
  assert.equal(attachment.size, 2 * 1024 * 1024 + 3); assert.equal(chunks, 3);
  assert.equal((await readFile(decodeURIComponent(attachment.uri.replace("file://", "")))).length, attachment.size);
  await page.evaluate(() => { (globalThis as any).reset(); (globalThis as any).reads = 0; });
  await choose(oversized);
  await page.waitForFunction(() => (globalThis as any).snapshot().draft.attachments[0]?.lifecycle === "failed");
  const failed = await page.evaluate(() => ({ attachment: (globalThis as any).snapshot().draft.attachments[0], reads: (globalThis as any).reads }));
  assert.match(JSON.stringify(failed.attachment.error), /1024 MB/); assert.equal(failed.reads, 0); assert.equal(chunks, 3); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ boundary: "real embedded Composer and shared browser resolver; local staging RPC stand-in, not full Application", uploadBytes: attachment.size, chunks, oversizedRejectedBeforeRead: true }));
} finally {
  await browser?.close(); await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
}
