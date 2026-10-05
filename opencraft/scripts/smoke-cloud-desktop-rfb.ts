import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { WebSocketServer } from "ws";
import { inflateSync, constants as zlibConstants } from "node:zlib";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const bundle = await build({ entryPoints: ["tests/fixtures/cloud-desktop-rfb-ui.tsx"], bundle: true,
  write: false, format: "esm", platform: "browser", jsx: "automatic" });
const assets = resolve("apps/workbench-web/dist/assets");
const cssNames = (await readdir(assets)).filter(name => name.endsWith(".css"));
const css = Buffer.concat(await Promise.all(cssNames.map(name => readFile(join(assets, name)))));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0]!.contents); }
  else if (req.url === "/fixture.css") { res.setHeader("content-type", "text/css"); res.end(css); }
  else if (req.url === "/desktop/attachments" && req.method === "POST") {
    let body = ""; req.on("data", chunk => body += String(chunk)); req.on("end", () => {
      const request = JSON.parse(body);
      assert.equal(request.target.principalId, "account:test"); assert.equal(request.bindingRevision, "binding:1");
      res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ code: "OK", message: "success", data: { ...request, version: 1,
        attachmentId: "abcdefghijklmnop", ticket: "synthetic_ticket_abcdefghijklmnop",
        incarnation: "physical:test", expiresAt: Date.now() + 60_000 } }));
    });
  }
  else if (req.url === "/desktop/attachments/abcdefghijklmnop" && req.method === "DELETE") {
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ code: "OK", message: "success", data: null }));
  }
  else if (req.url === "/revoke" && req.method === "POST") { for (const revoke of revokers) revoke(); res.writeHead(204); res.end(); }
  else { res.setHeader("content-type", "text/html"); res.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root" style="width:600px;height:420px"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});

// Minimal synthetic RFB 3.8 server for a known 2x2 RAW framebuffer. This is a
// test boundary, NOT a production protocol parser, auth broker or input gate.
const wss = new WebSocketServer({ server, path: "/desktop/connect" });
const inputs: number[] = [], protocolErrors: string[] = [];
const operations: string[] = [];
const extendedClipboard = process.env.OPENCRAFT_SMOKE_EXTENDED_CLIPBOARD === "1";
function clipboardMessage(flags: number, capacity?: number) {
  const message = Buffer.alloc(capacity === undefined ? 12 : 16);
  message[0] = 3; message.writeInt32BE(-(message.length - 8), 4); message.writeUInt32BE(flags, 8);
  if (capacity !== undefined) message.writeUInt32BE(capacity, 12);
  return message;
}
let releaseFrame: (() => void) | undefined;
let sendEmptyFrame: (() => void) | undefined;
const revokers = new Set<() => void>();
let viewerCloses = 0;
let notifyViewerClosed!: () => void;
const viewerClosed = new Promise<void>(resolve => { notifyViewerClosed = resolve; });
wss.on("connection", socket => {
  let stage = "attach", buffer = Buffer.alloc(0), drawn = false;
  let grant: string | null = null;
  let red = 16, green = 8, blue = 0, bigEndian = false;
  const revoke = () => {
    if (!grant) return; const requestId = grant; grant = null;
    socket.send(JSON.stringify({ event: "control/release", requestId }));
  };
  revokers.add(revoke);
  socket.on("close", () => { viewerCloses++; revokers.delete(revoke); notifyViewerClosed(); });
  socket.on("message", (data, binary) => {
    try {
      if (!binary) {
        const message = JSON.parse(data.toString());
        if (stage === "attach") {
          assert.equal(message.event, "desktop/attach"); assert.equal(message.version, 1);
          assert.equal(message.attachmentId, "abcdefghijklmnop"); assert.equal(message.ticket, "synthetic_ticket_abcdefghijklmnop");
          stage = "version";
          socket.send(JSON.stringify({ event: "desktop/ready", version: 1, attachmentId: message.attachmentId, controlAvailable: true }));
          socket.send(Buffer.from("RFB 003.008\n"));
        } else if (message.event === "control/request") {
          grant = message.requestId; socket.send(JSON.stringify({ event: "control/locked", requestId: grant }));
        } else if (message.event === "control/release") { if (grant === message.requestId) grant = null; }
        else throw new Error("Unexpected synthetic control message");
        return;
      }
      buffer = Buffer.concat([buffer, Buffer.from(data as Buffer)]);
      while (buffer.length) {
        if (stage === "version") {
          if (buffer.length < 12) return;
          assert.equal(buffer.subarray(0, 12).toString(), "RFB 003.008\n");
          buffer = buffer.subarray(12); stage = "security"; socket.send(Buffer.from([1, 1]));
        } else if (stage === "security") {
          assert.equal(buffer[0], 1); buffer = buffer.subarray(1); stage = "init";
          socket.send(Buffer.alloc(4));
        } else if (stage === "init") {
          assert.equal(buffer[0], 1); buffer = buffer.subarray(1); stage = "normal";
          const name = Buffer.from("Synthetic desktop"); const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(2, 0); init.writeUInt16BE(2, 2);
          init[4] = 32; init[5] = 24; init[7] = 1;
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
          init[14] = 16; init[15] = 8; init.writeUInt32BE(name.length, 20); name.copy(init, 24);
          socket.send(init);
          if (extendedClipboard) socket.send(clipboardMessage(0x1f000001, 64 << 10));
        } else {
          const type = buffer[0]!;
          let size: number;
          if (type === 0) size = 20;
          else if (type === 2) { if (buffer.length < 4) return; size = 4 + 4 * buffer.readUInt16BE(2); }
          else if (type === 3) size = 10;
          else if (type === 4) size = 8;
          else if (type === 5) size = 6;
          else if (type === 6) { if (buffer.length < 8) return; size = 8 + Math.abs(buffer.readInt32BE(4)); }
          else throw new Error(`Unexpected RFB test message ${type}`);
          if (buffer.length < size) return;
          if (type === 0) { bigEndian = buffer[6] === 1; red = buffer[14]!; green = buffer[15]!; blue = buffer[16]!; }
          if ((type === 4 || type === 5) && grant) inputs.push(type);
          if (type === 6 && grant) {
            if (buffer.readInt32BE(4) >= 0) operations.push(`clipboard:${buffer.subarray(8, size).toString("latin1")}`);
            else if (buffer[8] === 0x08) socket.send(clipboardMessage(0x02000001)); // Notify -> Request
            else if (buffer[8] === 0x10) {
              const text = inflateSync(buffer.subarray(12, size), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
              operations.push(`clipboard:${text.subarray(4, 4 + text.readUInt32BE(0) - 1).toString("utf8")}`);
            }
          }
          if (type === 4 && grant) operations.push(`key:${buffer.readUInt32BE(4)}:${buffer[1]}`);
          if (type === 3 && !drawn) {
            drawn = true;
            const frame = Buffer.alloc(32); frame.writeUInt16BE(1, 2); // one RAW rectangle
            frame.writeUInt16BE(2, 8); frame.writeUInt16BE(2, 10);
            const color = ((32 << red) | (128 << green) | (224 << blue)) >>> 0;
            for (let i = 16; i < 32; i += 4) {
              if (bigEndian) frame.writeUInt32BE(color, i); else frame.writeUInt32LE(color, i);
            }
            releaseFrame = () => socket.send(frame);
            sendEmptyFrame = () => socket.send(Buffer.alloc(4));
          }
          buffer = buffer.subarray(size);
        }
      }
    } catch (error) { protocolErrors.push(String(error)); socket.close(); }
  });
});

let browser: any;
try {
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  const consoleErrors: string[] = []; page.on("console", (message: any) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.getByText("Loading desktop…", { exact: true }).waitFor();
  assert.ok(releaseFrame, "peer must have received the real first-frame request");
  assert.equal(await page.getByRole("button", { name: "Take control", exact: true }).isDisabled(), true);
  sendEmptyFrame!();
  // Deliberately withhold pixels, not an application timing heuristic.
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".cloud-desktop-panel").getAttribute("data-phase"), "connecting",
    "a handshake/empty update must not dismiss the connection feedback");
  releaseFrame!();
  try { await page.getByText("Viewing desktop.", { exact: true }).waitFor(); }
  catch (error) {
    console.error(JSON.stringify({ ui: await page.locator("body").innerText(), errors, consoleErrors, protocolErrors,
      peers: wss.clients.size }, null, 2));
    throw error;
  }
  await page.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas || canvas.width !== 2) return false;
    const rgba = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
    return rgba[0] === 32 && rgba[1] === 128 && rgba[2] === 224;
  });
  const canvas = page.locator("canvas");
  await canvas.click(); await page.keyboard.press("a");
  assert.equal(inputs.length, 0, "observe mode must not send pointer/key input");
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.getByText("You are in control.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("canvas")), true);
  await page.keyboard.press("a");
  await page.waitForTimeout(50);
  assert.ok(inputs.includes(4), "real noVNC input must reach the synthetic peer after granting control");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const clipboardText = extendedClipboard ? "剪贴板 smoke" : "clipboard smoke";
  await page.evaluate(text => navigator.clipboard.writeText(text), clipboardText);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page.getByText("You are in control.", { exact: true }).waitFor();
  await page.waitForTimeout(50);
  let index = operations.indexOf(`clipboard:${clipboardText}`);
  assert.ok(index >= 0);
  assert.deepEqual(operations.slice(index + 1, index + 5), ["key:65507:1", "key:118:1", "key:118:0", "key:65507:0"]);
  if (!extendedClipboard) {
    const before = operations.length;
    await page.evaluate(() => navigator.clipboard.writeText("不应损坏"));
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    await page.getByText("Unable to paste.", { exact: true }).waitFor();
    assert.equal(operations.length, before, "legacy clipboard must reject Unicode rather than replace it");
  }
  await page.evaluate(() => navigator.clipboard.writeText("keyboard paste"));
  await canvas.click();
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(100);
  index = operations.indexOf("clipboard:keyboard paste");
  assert.ok(index >= 0, "focused Ctrl+V must use the same authorized clipboard intent");
  assert.deepEqual(operations.slice(index + 1, index + 5), ["key:65507:1", "key:118:1", "key:118:0", "key:65507:0"]);
  await page.evaluate(() => (window as any).__desktopFixture.revoke());
  await page.getByText("Viewing desktop.", { exact: true }).waitFor();
  const inputCount = inputs.length;
  await canvas.click(); await page.keyboard.press("b"); await page.waitForTimeout(50);
  assert.equal(inputs.length, inputCount, "revocation must stop further pointer/key input");
  await page.evaluate(() => (window as any).__desktopFixture.close());
  await page.getByText("Desktop is not available here.", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("canvas").length === 0);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Viewer transport did not close")), 5_000);
    void viewerClosed.then(() => { clearTimeout(timer); resolve(); });
  });
  assert.equal(viewerCloses, 1); assert.deepEqual(errors, []); assert.deepEqual(protocolErrors, []);
  await page.evaluate(() => (window as any).__desktopFixture.dispose());
  console.log("PASS real panel + Vela viewer port + session wire + patched noVNC 1.5: held/empty first-frame negative; binary framebuffer; grant focus; clipboard before paste keys (button and Ctrl+V); revoke input; viewer close. Backend authority/executor and RFB peer synthetic, not native/production security acceptance.");
} finally {
  await browser?.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>(yes => wss.close(() => yes()));
  await new Promise<void>(yes => server.close(() => yes()));
}
