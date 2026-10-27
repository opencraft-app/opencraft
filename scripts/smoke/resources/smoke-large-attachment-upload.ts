import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { LocalAttachmentStagingService } from "../../../apps/local-agent-host/src/attachments/local-attachment-staging";
import { AppHostServer } from "../../../packages/app-host-server/src/index";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = await mkdtemp(join(tmpdir(), "opencraft-large-upload-"));
const service = new LocalAttachmentStagingService(join(root, "staged"));
let largestRpcBytes = 0;
let chunkCount = 0;
const listeners = new Set<(frame: string) => void>();
const appHost = new AppHostServer({ createTransport: () => ({
  status: { state: "idle" as const }, async connect() {},
  async send(frame: string) {
    largestRpcBytes = Math.max(largestRpcBytes, Buffer.byteLength(frame));
    const request = JSON.parse(frame);
    if (request.method === "attachment/uploadChunk") chunkCount++;
    let reply;
    try { reply = { result: await service.handle(request.method, request.params) }; }
    catch (error) { reply = { error: { code: -32602, message: (error as Error).message } }; }
    for (const listener of listeners) listener(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply, __opencraftClient: request.__opencraftClient }));
  },
  subscribeMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  subscribeStatus() { return () => {}; }, async close() {},
}) });
let browser: any;
let web: any;
try {
  const bundle = await build({ stdin: { contents: `
    import { resolveBrowserAttachment } from './apps/workbench-web/src/runtime/browser-attachment-resolver';
    globalThis.probe = async (file, cancelAfter = 0) => {
      const socket = new WebSocket(location.origin.replace('http', 'ws') + '/apphost');
      const pending = new Map(); let generation; let count = 0; let maxRead = 0; let id = 0;
      const wait = key => new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
      socket.onmessage = event => {
        const frame = JSON.parse(event.data);
        const inner = frame.type === 'host/frame' ? JSON.parse(frame.frame) : frame;
        const key = frame.type === 'host/frame' ? inner.id : frame.requestId ?? frame.type;
        const p = pending.get(key); if (!p) return;
        pending.delete(key);
        if (inner.error || inner.ok === false) p.reject(new Error(JSON.stringify(inner.error))); else p.resolve(inner.result ?? inner);
      };
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const ready = wait('ready'); socket.send(JSON.stringify({type:'hello',protocolVersion:2,rendererId:'file-upload-probe'})); await ready;
      const connected = wait('connect'); socket.send(JSON.stringify({type:'host/connect',requestId:'connect',hostId:'upload-host',leaseId:'upload'})); generation = (await connected).generation;
      const rpc = async (method, params) => {
        const requestId = 'rpc-' + (++id); const response = wait(requestId);
        socket.send(JSON.stringify({type:'host/send',requestId:'send-'+id,hostId:'upload-host',leaseId:'upload',generation,frame:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})}));
        return response;
      };
      const controller = new AbortController();
      file.arrayBuffer = () => { throw new Error('whole-file read forbidden'); };
      const slice = file.slice.bind(file); file.slice = (start, end) => { maxRead = Math.max(maxRead, end - start); return slice(start, end); };
      try {
        const result = await resolveBrowserAttachment(file, {id:cancelAfter ? 'cancel-file' : 'large-file',name:file.name,size:file.size,mimeType:file.type,uri:null,lifecycle:'pending',error:null}, {
          maxBytes:1024*1024*1024, chunkBytes:1024*1024,
          stage:()=>{throw new Error('one-shot upload forbidden');},
          uploadChunk:async params=>{const result=await rpc('attachment/uploadChunk',params);if(++count===cancelAfter)controller.abort();return result;},
          uploadCancel:uploadId=>rpc('attachment/uploadCancel',{uploadId}),
        },undefined,controller.signal);
        return {size:result.size,lifecycle:result.lifecycle,uri:result.uri,maxRead,count};
      } catch (error) { if(cancelAfter && controller.signal.aborted) return {cancelled:true,maxRead,count}; throw error; }
      finally {socket.close();}
    };
  `, resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts" }, bundle: true, write: false, platform: "browser", format: "iife" });
  await writeFile(join(root, "probe.js"), bundle.outputFiles[0]!.text);
  await writeFile(join(root, "index.html"), '<!doctype html><input type="file"><script src="/probe.js"></script>');
  const input = join(root, "recording.bin");
  const size = 1024 * 1024 * 1024;
  const file = await open(input, "wx");
  try { await file.truncate(size); } finally { await file.close(); }
  web = await createWorkbenchWebServer({ root, appHostServer: appHost, appServerTarget: null });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('input').setInputFiles(input);
  const startedAt = Date.now();
  const result = await page.evaluate(() => (globalThis as any).probe((document.querySelector('input') as HTMLInputElement).files![0]));
  assert.equal(result.size, size);
  assert.equal(result.lifecycle, "ready");
  assert.equal(result.maxRead, 1024 * 1024);
  assert.equal(result.count, 1024);
  assert(largestRpcBytes < 1.5 * 1024 * 1024);
  const path = decodeURIComponent(result.uri.replace("file://", ""));
  const actual = createHash("sha256");
  let storedBytes = 0;
  for await (const chunk of createReadStream(path)) { actual.update(chunk); storedBytes += chunk.length; }
  const expected = createHash("sha256");
  const zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 1024; i++) expected.update(zeros);
  assert.equal(storedBytes, size);
  const sha256 = actual.digest("hex");
  assert.equal(sha256, expected.digest("hex"));
  const cancelled = await page.evaluate(() => (globalThis as any).probe((document.querySelector('input') as HTMLInputElement).files![0], 2));
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.count, 2);
  assert.deepEqual(await readdir(join(root, "staged", ".uploads")), []);
  console.log(JSON.stringify({ size, sha256, largestRpcBytes, chunkCount, maxRead: result.maxRead, elapsedMs: Date.now() - startedAt, cancelled: true, boundary: "real Chromium File -> WebSocket AppHost -> disk, synthetic engine" }));
} finally {
  await browser?.close();
  await web?.close();
  await appHost.close();
  await service.close();
  await rm(root, { recursive: true, force: true });
}
