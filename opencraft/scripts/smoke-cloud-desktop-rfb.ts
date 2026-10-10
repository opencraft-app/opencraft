import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { WebSocketServer } from "ws";
import { inflateSync, constants as zlibConstants } from "node:zlib";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const artifacts = await mkdtemp(join(tmpdir(), "opencraft-desktop-input-"));
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
  else { res.setHeader("content-type", "text/html"); res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root" style="width:min(600px,100vw);height:420px"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});

// Minimal synthetic RFB 3.8 server for a known 2x2 RAW framebuffer. This is a
// test boundary, NOT a production protocol parser, auth broker or input gate.
const wss = new WebSocketServer({ server, path: "/desktop/connect" });
const inputs: number[] = [], protocolErrors: string[] = [];
const operations: string[] = [];
const pointers: { x: number; y: number; mask: number }[] = [];
const extendedClipboard = process.env.OPENCRAFT_SMOKE_EXTENDED_CLIPBOARD === "1";
function clipboardMessage(flags: number, capacity?: number) {
  const message = Buffer.alloc(capacity === undefined ? 12 : 16);
  message[0] = 3; message.writeInt32BE(-(message.length - 8), 4); message.writeUInt32BE(flags, 8);
  if (capacity !== undefined) message.writeUInt32BE(capacity, 12);
  return message;
}
let releaseFrame: (() => void) | undefined;
let sendEmptyFrame: (() => void) | undefined;
let sendCursor: ((size: number) => void) | undefined;
let holdControl = false;
let confirmHeldControl: (() => void) | undefined;
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
          const confirm = () => {
            grant = message.requestId; socket.send(JSON.stringify({ event: "control/locked", requestId: grant }));
          };
          if (holdControl) confirmHeldControl = confirm;
          else confirm();
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
          sendCursor = size => {
            // Real cursor pseudo-encoding, including pixels and transparency mask.
            const cursor = Buffer.alloc(16 + size * size * 4 + Math.ceil(size / 8) * size, 255);
            cursor.fill(0, 0, 16); cursor.writeUInt16BE(1, 2);
            cursor.writeUInt16BE(size, 8); cursor.writeUInt16BE(size, 10); cursor.writeInt32BE(-239, 12);
            socket.send(cursor);
          };
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
          // Record even ungranted attempts: a dropping peer cannot hide an
          // observe-mode/retired input bug in the actual browser adapter.
          if (type === 4 || type === 5) inputs.push(type);
          if (type === 5) pointers.push({ mask: buffer[1]!, x: buffer.readUInt16BE(2), y: buffer.readUInt16BE(4) });
          if (type === 5 && grant) operations.push(`pointer:${buffer[1]}`);
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
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true });
  page.setDefaultTimeout(15000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  const consoleErrors: string[] = []; page.on("console", (message: any) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('.cloud-desktop-panel[data-phase="connecting"][data-stage="video"]').waitFor();
  assert.ok(releaseFrame, "peer must have received the real first-frame request");
  assert.equal(await page.locator('button[aria-pressed]').isDisabled(), true);
  sendEmptyFrame!();
  // Deliberately withhold pixels, not an application timing heuristic.
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".cloud-desktop-panel").getAttribute("data-phase"), "connecting",
    "a handshake/empty update must not dismiss the connection feedback");
  releaseFrame!();
  try { await page.locator('.cloud-desktop-panel[data-phase="ready"]').waitFor(); }
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
  const canvas = page.locator(".cloud-desktop-panel__surface canvas");
  assert.equal(await page.locator('body > canvas').count(), 0, "observe-only media cannot attach a control cursor");
  assert.equal(await canvas.evaluate((element: HTMLCanvasElement) => element.style.cursor), "auto");
  await page.keyboard.press("a");
  assert.equal(inputs.length, 0, "observe mode must not send pointer/key input");
  const touchSession = await page.context().newCDPSession(page);
  const pinch = async () => {
    const rect = await canvas.boundingBox(); const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const points = (offset: number) => [{ x: x - offset, y, id: 1 }, { x: x + offset, y, id: 2 }];
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(40) });
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(70) });
    await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return canvas.evaluate((element: HTMLElement) => getComputedStyle(element).transform);
  };
  const observeTransform = await pinch(); assert.notEqual(observeTransform, "none");
  assert.equal(inputs.length, 0, "observing pinch changes only local viewing");
  sendCursor!(8);
  await page.waitForTimeout(50);
  assert.equal(await page.locator('body > canvas').count(), 0, "shape updates while observing cannot attach a control cursor");
  holdControl = true;
  await canvas.tap();
  await page.locator('.cloud-desktop-panel[data-control="requesting"]').waitFor();
  assert.equal(await page.locator('body > canvas').count(), 0, "waiting for authorization is not control");
  await page.getByRole("button", { name: "Stop controlling", exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="observing"]').waitFor();
  assert.ok(confirmHeldControl, "synthetic peer must have received the pending request");
  confirmHeldControl!();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cloud-desktop-panel').getAttribute('data-control'), 'observing');
  assert.equal(await page.locator('body > canvas').count(), 0, "a cancelled request's late grant cannot restore the cursor");
  assert.equal(inputs.length, 0);
  holdControl = false;
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("canvas")), true);
  await page.keyboard.press("a");
  await page.waitForTimeout(50);
  assert.ok(inputs.includes(4), "real noVNC input must reach the synthetic peer after granting control");
  const beforePinch = inputs.length;
  const controlTransform = await pinch(); assert.notEqual(controlTransform, observeTransform);
  await page.waitForTimeout(50);
  assert.equal(inputs.length, beforePinch, "controlling pinch never sends Ctrl/remote pointer/scroll");
  assert.equal(await page.locator('.cloud-desktop-panel').getAttribute("data-control"), "controlling");
  const bounds = await canvas.boundingBox(); const position = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(position.x, position.y); await page.mouse.wheel(0, 80); await page.waitForTimeout(120);
  assert.ok(pointers.some(pointer => pointer.mask === 16), "managed wheel encodes bounded RFB scroll");
  assert.ok(pointers.every(pointer => pointer.x >= 0 && pointer.x < 2 && pointer.y >= 0 && pointer.y < 2),
    "zoomed pointer coordinates remain framebuffer pixels");
  const beforeTap = pointers.length;
  await page.touchscreen.tap(position.x, position.y); await page.waitForTimeout(50);
  assert.deepEqual(pointers.slice(beforeTap).map(pointer => pointer.mask), [1, 0], "native touch tap commits once, no compatibility mouse duplicate");
  const beforeScroll = pointers.length;
  const two = (dy: number) => [{ x: position.x - 30, y: position.y + dy, id: 1 }, { x: position.x + 30, y: position.y + dy, id: 2 }];
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: two(0) });
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: two(-70) });
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(50);
  assert.deepEqual(pointers.slice(beforeScroll).map(pointer => pointer.mask), [16, 0], "two-finger scroll shares wheel policy without a stray tap");
  await page.screenshot({ path: join(artifacts, "touch-viewport.png") });
  // Mobile focusout can temporarily leave only body as the active element.
  // That missing destination must not revoke the existing grant before click.
  await canvas.evaluate((element: HTMLCanvasElement) => element.blur());
  assert.equal(await page.locator('.cloud-desktop-panel').getAttribute("data-control"), "controlling");
  await page.getByRole("button", { name: "Show keyboard", exact: true }).tap();
  const textInput = page.getByRole("textbox", { name: "Type on desktop" });
  await textInput.waitFor(); assert.equal(await textInput.evaluate(element => element === document.activeElement), true);
  const beforeTyping = operations.length;
  await page.keyboard.insertText("b");
  await touchSession.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
  await touchSession.send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(50);
  assert.deepEqual(operations.slice(beforeTyping), ["key:98:1", "key:98:0"], "IME candidates never reach the peer");
  await touchSession.send("Input.insertText", { text: "中" }); await page.waitForTimeout(50);
  assert.deepEqual(operations.slice(beforeTyping), ["key:98:1", "key:98:0", "key:16797229:1", "key:16797229:0"],
    "actual browser composition commits Unicode once");
  await page.keyboard.press("Enter"); await page.keyboard.press("Backspace");
  await page.waitForTimeout(50);
  assert.deepEqual(operations.slice(-4), ["key:65293:1", "key:65293:0", "key:65288:1", "key:65288:0"]);
  await page.screenshot({ path: join(artifacts, "editable-focus.png") });
  // Same grant, different remote input target: finish the actual browser IME
  // before the RFB click, not after it. A new typing transaction cannot revive
  // a delayed notification from the old editable node.
  await touchSession.send("Input.imeSetComposition", { text: "文", selectionStart: 1, selectionEnd: 1 });
  await textInput.evaluate(element => { (window as any).__retiredTextInput = element; });
  const beforeHandoff = operations.length;
  await page.touchscreen.tap(position.x, position.y); await page.waitForTimeout(50);
  assert.deepEqual(operations.slice(beforeHandoff), ["key:16803207:1", "key:16803207:0", "pointer:1", "pointer:0"],
    "actual browser composition must commit to the old target BEFORE the remote click");
  assert.equal(await textInput.count(), 0);
  assert.equal(await page.locator('.cloud-desktop-panel').getAttribute("data-control"), "controlling",
    "handoff within the same panel retains the valid grant");
  await page.getByRole("button", { name: "Show keyboard", exact: true }).tap();
  await textInput.waitFor();
  const beforeLate = operations.length;
  await page.evaluate(() => {
    const old = (window as any).__retiredTextInput as HTMLTextAreaElement;
    old.dispatchEvent(new CompositionEvent("compositionend", { data: "旧" }));
    old.value = "旧"; old.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "旧" }));
  });
  await page.waitForTimeout(50); assert.equal(operations.length, beforeLate, "old text DOM cannot replay into a same-grant successor");
  await page.keyboard.insertText("c"); await page.waitForTimeout(50);
  assert.deepEqual(operations.slice(beforeLate), ["key:99:1", "key:99:0"]);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const clipboardText = extendedClipboard ? "剪贴板 smoke" : "clipboard smoke";
  await page.evaluate(text => navigator.clipboard.writeText(text), clipboardText);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
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
  await page.locator('.cloud-desktop-panel[data-control="observing"]').waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Type on desktop" }).count(), 0, "revocation destroys the keyboard transaction");
  const inputCount = inputs.length;
  await canvas.click(); await page.keyboard.press("b"); await page.waitForTimeout(50);
  assert.equal(inputs.length, inputCount, "revocation must stop further pointer/key input");
  // No mouseleave is dispatched: mobile can hide a resident presentation without
  // changing the last synthetic mouse target. Cursor lives outside media DOM.
  // Park Chromium's physical hover outside before the synthetic touch cursor;
  // otherwise removing inert on reopen correctly generates a fresh mouseover.
  await page.mouse.move(380, 600);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  sendCursor!(8);
  const overlay = page.locator('body > canvas');
  await page.waitForTimeout(50);
  assert.equal(await overlay.count(), 0, "revocation removes local control feedback, not just its input");
  assert.equal(await canvas.evaluate((element: HTMLCanvasElement) => element.style.cursor), 'auto');
  await canvas.evaluate(element => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  assert.equal(await overlay.count(), 0, "observe-mode mouseover cannot resurrect the overlay");
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('body > canvas')?.width === 8);
  await canvas.evaluate((element: HTMLCanvasElement) => element.dispatchEvent(new MouseEvent("mouseover",
    { bubbles: true, clientX: element.getBoundingClientRect().left + 10, clientY: element.getBoundingClientRect().top + 10 })));
  const positiveCursor = await overlay.evaluate((element: HTMLCanvasElement) => ({ visible: getComputedStyle(element).visibility,
    width: element.width, height: element.height, style: element.style.cssText }));
  assert.equal(positiveCursor.visible, "visible", `positive control: actual decoder fallback cursor ${JSON.stringify(positiveCursor)}`);
  const mediaNode = await canvas.elementHandle();
  await page.getByRole('button', { name: 'Stop controlling', exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="observing"]').waitFor();
  assert.equal(await overlay.count(), 0, 'Stop removes the painted fallback cursor without mouseleave');
  assert.equal(await canvas.evaluate((element: HTMLCanvasElement) => element.style.cursor), 'auto');
  sendCursor!(12);
  await page.waitForTimeout(50);
  await canvas.evaluate(element => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  assert.equal(await overlay.count(), 0, 'late shape and hover events cannot undo Stop');
  assert.equal(await canvas.evaluate((element, old) => element === old, mediaNode), true);
  assert.equal(viewerCloses, 0, 'Stop retains the viewing transport');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
  assert.equal(await overlay.evaluate((element: HTMLCanvasElement) => element.width), 12, 'new control uses the latest observed shape');
  await page.evaluate(() => {
    const outside = document.createElement('input'); outside.id = 'outside'; document.body.append(outside); outside.focus();
  });
  await page.locator('.cloud-desktop-panel[data-control="observing"]').waitFor();
  assert.equal(await overlay.count(), 0, 'focus leaving the panel retires cursor and input together');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
  await canvas.evaluate(element => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  assert.equal(await overlay.isVisible(), true);
  await page.evaluate(() => (window as any).__desktopFixture.setActive(false));
  await page.waitForFunction(() => document.querySelector('.cloud-desktop-panel')?.hasAttribute('inert'));
  assert.equal(await overlay.count(), 0, "inactive presentation must retire its body-level cursor without mouseleave");
  assert.equal(viewerCloses, 0, "hiding must retain the viewing transport");
  sendCursor!(12);
  await page.waitForTimeout(100);
  assert.equal(await overlay.count(), 0, "hidden cursor shape updates cannot resurrect the overlay");
  await page.evaluate(() => (window as any).__desktopFixture.setActive(true));
  await page.waitForFunction(() => !document.querySelector('.cloud-desktop-panel')?.hasAttribute('inert'));
  assert.equal(await canvas.evaluate((element, old) => element === old, mediaNode), true);
  assert.equal(await page.locator('.cloud-desktop-panel').getAttribute('data-control'), 'observing');
  assert.equal(await overlay.count(), 0, "reopening only restores observation, not a cursor attachment");
  await canvas.evaluate((element: HTMLCanvasElement) => element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  assert.equal(await overlay.count(), 0, 'reopening and hovering cannot restore control feedback');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
  await canvas.evaluate(element => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  assert.equal(await overlay.isVisible(), true);
  assert.equal(await overlay.evaluate((element: HTMLCanvasElement) => element.width), 12, "latest hidden shape is retained");
  await page.evaluate(() => (window as any).__desktopFixture.close());
  await page.getByText("Desktop is not available here.", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".cloud-desktop-panel__surface canvas").length === 0);
  assert.equal(await overlay.count(), 0, "logical close removes the global fallback cursor");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Viewer transport did not close")), 5_000);
    void viewerClosed.then(() => { clearTimeout(timer); resolve(); });
  });
  assert.equal(viewerCloses, 1); assert.deepEqual(errors, []); assert.deepEqual(protocolErrors, []);
  await page.evaluate(() => (window as any).__desktopFixture.dispose());
  for (const hasTouch of [true, false]) {
    const initiallyHidden = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch });
    initiallyHidden.on("pageerror", (error: Error) => errors.push(error.message));
    await initiallyHidden.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?inactive=1`);
    await initiallyHidden.waitForFunction(() => document.querySelector('.cloud-desktop-panel')?.getAttribute('data-stage') === 'video'); releaseFrame!();
    await initiallyHidden.locator('.cloud-desktop-panel[data-phase="ready"]').waitFor();
    sendCursor!(16);
    await initiallyHidden.waitForTimeout(100);
    assert.equal(await initiallyHidden.locator('body > canvas').count(), 0, "connecting while hidden cannot attach a cursor overlay");
    const hiddenMedia = initiallyHidden.locator('.cloud-desktop-panel__surface canvas');
    const original = await hiddenMedia.elementHandle();
    for (let i = 0; i < 3; i++) {
      await initiallyHidden.evaluate(() => (window as any).__desktopFixture.setActive(true));
      await initiallyHidden.waitForFunction(() => !document.querySelector('.cloud-desktop-panel')?.hasAttribute('inert'));
      assert.equal(await hiddenMedia.evaluate((element, node) => element === node, original), true);
      assert.equal(await initiallyHidden.locator('body > canvas').count(), 0, 'visible but observing has no local cursor');
      assert.equal(await hiddenMedia.evaluate((element: HTMLCanvasElement) => element.style.cursor), 'auto');
      await initiallyHidden.getByRole('button', { name: 'Take control', exact: true }).click();
      await initiallyHidden.locator('.cloud-desktop-panel[data-control="controlling"]').waitFor();
      if (hasTouch) {
        const resumed = initiallyHidden.locator('body > canvas');
        assert.equal(await resumed.count(), 1);
        assert.equal(await resumed.evaluate((element: HTMLCanvasElement) => element.width), 16);
      } else {
        assert.equal(await initiallyHidden.locator('body > canvas').count(), 0, "desktop URI cursors never create an overlay");
        assert.ok(await hiddenMedia.evaluate((element: HTMLCanvasElement) => element.style.cursor.startsWith('url(')));
      }
      await initiallyHidden.getByRole('button', { name: 'Stop controlling', exact: true }).click();
      await initiallyHidden.locator('.cloud-desktop-panel[data-control="observing"]').waitFor();
      assert.equal(await initiallyHidden.locator('body > canvas').count(), 0, 'Stop retires touch fallback and desktop URI alike');
      assert.equal(await hiddenMedia.evaluate((element: HTMLCanvasElement) => element.style.cursor), 'auto');
      sendCursor!(16); await initiallyHidden.waitForTimeout(50);
      await hiddenMedia.evaluate(element => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
      assert.equal(await initiallyHidden.locator('body > canvas').count(), 0);
      assert.equal(await hiddenMedia.evaluate((element: HTMLCanvasElement) => element.style.cursor), 'auto');
      await initiallyHidden.evaluate(() => (window as any).__desktopFixture.setActive(false));
      await initiallyHidden.waitForFunction(() => document.querySelector('.cloud-desktop-panel')?.hasAttribute('inert'));
      assert.equal(await initiallyHidden.locator('body > canvas').count(), 0);
    }
    await initiallyHidden.evaluate(() => (window as any).__desktopFixture.dispose());
    assert.equal(await initiallyHidden.locator('body > canvas').count(), 0);
    await initiallyHidden.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(protocolErrors, []);
  console.log("PASS real panel + viewer port + session wire + managed noVNC 1.5: observed/controlled local pinch; bounded wheel; native touch tap and two-finger scroll; actual Chromium editable focus/IME commit once/Enter/Backspace and composition-before-remote-click handoff; retired same-grant text cannot replay; held first-frame, clipboard order, revoke input and viewer close; observe/requesting/cancelled late grant cannot paint a cursor; Stop/revoke/blur/hide retire touch overlay and desktop URI, late shape/hover cannot resurrect; same media/connection retained and fresh grants use cached shapes. Peer and authority synthetic; not iPhone OS keyboard or native/production security acceptance.");
  console.log(JSON.stringify({ artifacts, viewport: "390px coarse pointer", keyboard: "Chromium IME, not iPhone OS", extendedClipboard }));
} finally {
  await browser?.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>(yes => wss.close(() => yes()));
  await new Promise<void>(yes => server.close(() => yes()));
}
