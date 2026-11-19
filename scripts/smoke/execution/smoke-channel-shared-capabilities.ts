import { ImChannelService } from "../../im-channel-service.mjs";
import { AppHostServer } from "@opencraft/app-host-server";
import { ImChannelsAppServer } from "../../im-channels-appserver.mjs";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import assert from "node:assert/strict";
import sharp from "sharp";
import { FORWARDED_RECORD_MIME } from "@opencraft/appserver-protocol";
import { writeFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, loadConfigFromFile } from "vite";
import { chromium } from "playwright";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../../packages/access-control/src/actors";
import { ActorAccess } from "../../../packages/access-control/src/actor-access";
import { Collaboration, CollaborationHttpApi } from "../../../packages/access-control/src/collaboration";
import { parsePrincipal } from "@opencraft/identity-core";

// Actual Workbench extension, native transport, communication authority and DB.
// Only identity admission is synthetic; no model or external IM service is used.
const root = await mkdtemp(join(tmpdir(), "native-channel-ui-"));
const evidence = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/channel-shared-capabilities";
const storage = await openServerDatabase(root),
  actors = new ActorStore(storage);
const principal = parsePrincipal({
  provider: "local",
  subject: "image-smoke-human",
  displayName: "Human",
  expiresAt: Date.now() + 3600000,
})!;
const human = actors.resolveHuman(principal)!,
  bot = actors.createSession("Review Bot", human.actorId);
const credential = actors.issueCredential(bot.id, Date.now() + 3600000, human.actorId),
  botContext = actors.authenticateSession(credential.token)!;
actors.setGrant(human.actorId, bot.id, "message.send", true, "fixture");
const service = new Collaboration(storage, actors, {
  hostId: "fixture",
  serverId: "fixture",
  async validate() {},
  async receipt() {
    return null;
  },
  async add() {
    throw Error("fixture execution unavailable");
  },
  async steer() {
    throw Error("fixture execution unavailable");
  },
  async cancel() {
    return false;
  },
});
const access = new ActorAccess(actors, {
  authenticateHuman: () => principal,
  admitted: () => true,
  administrator: () => false,
});
const api = new CollaborationHttpApi(service, access);
const im = await ImChannelService.open([], {
  dataDirectory: root,
  actors,
  actorAccess: access,
  collaboration: service,
  getAppHost: () => null,
});
const host = new AppHostServer({
  logicalClientRouting: true,
  physicalHostLifetime: "server",
  createTransport: () => new ImChannelsAppServer(() => service),
});
const backend = await createWorkbenchWebServer({
  root,
  appServerTarget: null,
  appHostServer: host,
  actorService: access,
  allowSessionChannels: true,
  actorCollaborationService: api,
  loopbackOnly: true,
  onAppHostDiagnostic() {},
});
const { port: backendPort } = await backend.listen({ host: "127.0.0.1", port: 0 });
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createImExtension} from '/plugins/im/src/index.tsx';
import {ChannelsClient} from '/plugins/im/src/channel-client.ts';
import {connectWebSocketAppHost} from '/apps/workbench-web/src/runtime/websocket-app-host.ts';
import {createChannelsRpc} from '/apps/workbench-web/src/runtime/channels-rpc.ts';
import {CHANNELS_HOST_ID} from '/packages/appserver-protocol/src/channels.ts';
import '/apps/workbench-web/src/styles/app.scss';
import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
import {openWorkbenchUiPreferences} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
bindInteractionDensity(document, await openWorkbenchUiPreferences());
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'en-US').render(<WorkbenchRoot application={application}/>);
const calls={};ChannelsClient.prototype.recordResource=async function(group,sequence,path,signal){const key=group+':'+sequence+':'+path;calls[key]=(calls[key]??0)+1;const response=await fetch('/fixture-record-resource?path='+encodeURIComponent(path),{signal});if(!response.ok)throw Error('fixture_unavailable');return{name:response.headers.get('x-name')??'file',blob:await response.blob()};};
window.proof={calls,theme:setThemePreference,openGroup:id=>application.supervisor.navigation.openExtensionView('opencraft.im.channel-chat','opencraft-channel:'+id)};document.body.dataset.ready='true';`;
const fixturePng = await sharp({ create: { width: 400, height: 250, channels: 3, background: "#257c62" } })
  .png()
  .toBuffer();
const fixtureWav = Buffer.alloc(44 + 1600);
fixtureWav.write("RIFF");
fixtureWav.writeUInt32LE(36 + 1600, 4);
fixtureWav.write("WAVEfmt ", 8);
fixtureWav.writeUInt32LE(16, 16);
fixtureWav.writeUInt16LE(1, 20);
fixtureWav.writeUInt16LE(1, 22);
fixtureWav.writeUInt32LE(8000, 24);
fixtureWav.writeUInt32LE(16000, 28);
fixtureWav.writeUInt16LE(2, 32);
fixtureWav.writeUInt16LE(16, 34);
fixtureWav.write("data", 36);
fixtureWav.writeUInt32LE(1600, 40);
const applicationConfig = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  "apps/workbench-web/vite.config.ts",
);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: ".local/channel-shared-capabilities-vite",
  logLevel: "error",
  define: {
    "process.env.NEXT_PUBLIC_REGION": '"cn"',
    "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"',
    "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"',
  },
  optimizeDeps: {
    ...applicationConfig!.config.optimizeDeps,
    include: [...applicationConfig!.config.optimizeDeps!.include!, "@opencraft/browser-core/presentation"],
  },
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    proxy: { "/apphost": { target: "http://127.0.0.1:" + backendPort, ws: true } },
  },
  plugins: [
    {
      name: "native-channel-proof",
      resolveId: (id) => (id === "/native-channel-proof.tsx" ? id : null),
      load: (id) => (id === "/native-channel-proof.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/fixture-record-resource")) {
            const path = new URL(req.url, "http://fixture").searchParams.get("path");
            if (path === "0.0" || path === "0.1") {
              res.setHeader("content-type", "image/png");
              res.setHeader("x-name", "record-photo.png");
              res.end(fixturePng);
            } else if (path === "0.2") {
              res.setHeader("content-type", "audio/wav");
              res.setHeader("x-name", "voice.wav");
              res.end(fixtureWav);
            } else {
              res.statusCode = 404;
              res.end();
            }
          } else if (req.url === "/fixture-avatar.svg") {
            res.setHeader("content-type", "image/svg+xml");
            res.end(
              '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#257c62"/><circle cx="16" cy="12" r="6" fill="white"/><path d="M6 30a10 10 0 0 1 20 0" fill="white"/></svg>',
            );
          } else if (req.url === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/native-channel-proof.tsx"></script></body></html>',
            );
          } else if (req.url?.startsWith("/__opencraft_im")) {
            void im.handle(req, res, () => true).catch(next);
          } else if (req.url?.startsWith("/__opencraft_actors/collaboration/")) void api.handle(req, res);
          else next();
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: any[] = [];
try {
  await server.listen();
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  for (const [width, theme, touch] of [
    [390, "light", true],
    [1160, "dark", false],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch });
    page.setDefaultTimeout(20000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const activate = (el: import("playwright").Locator) => (touch ? el.tap() : el.click());
    await page.addInitScript(() => {
      (window as any).__name = (target: any) => target;
      (window as any).copied = [];
      (window as any).resizeWarnings = [];
      window.addEventListener("error", (e) => {
        if (e.message.includes("ResizeObserver loop")) (window as any).resizeWarnings.push(e.message);
      });
      Object.defineProperty(navigator, "clipboard", {
        value: {
          async write(items: any[]) {
            const value: any = {};
            for (const type of items[0].types) value[type] = await (await items[0].getType(type)).text();
            (window as any).copied.push(value);
          },
          async writeText(text: string) {
            (window as any).copied.push({ "text/plain": text });
          },
        },
      });
    });
    await page.goto(server.resolvedUrls!.local[0], { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector('body[data-ready="true"]', { state: "attached", timeout: 90000 });
    await page.evaluate((t) => (window as any).proof.theme(t), theme);
    const group = (await service.communicate(human, "opencraft/channels/group/create", {
      title: "共享群聊 " + width,
      memberActorIds: [bot.id],
      clientRequestId: "shared-group-" + width,
    })) as { id: string };
    await page.evaluate((id) => (window as any).proof.openGroup(id), group.id);
    const closeSidebar = page.getByRole("button", { name: "Close sidebar", exact: true });
    if (touch && (await closeSidebar.count())) {
      const b = await closeSidebar.boundingBox();
      if (b) await closeSidebar.tap({ position: { x: b.width - 8, y: b.height / 2 } });
    }
    const editor = page.locator('[contenteditable="true"]:visible').last();
    await editor.click();
    await editor.pressSequentially("Keep this draft");
    for (const [id, w, h] of [
      ["one", 400, 800],
      ["two", 900, 450],
    ] as const) {
      const bytes = await sharp({ create: { width: w, height: h, channels: 3, background: "#346779" } })
        .png()
        .toBuffer();
      await service.communicate(human, "channel/image/send", {
        channelId: group.id,
        clientMessageId: width + "-" + id,
        type: "image/png",
        bytes,
      });
    }
    await page.locator(".im-channel-chat__picture img").last().waitFor();
    const first = page.getByRole("button", { name: "Preview image", exact: true }).first();
    await first.scrollIntoViewIfNeeded();
    await activate(first);
    let viewer = page.getByRole("dialog");
    await viewer.getByRole("img", { name: "Preview image", exact: true }).waitFor();
    await viewer.getByText("1 / 2", { exact: true }).waitFor();
    if (touch) await activate(viewer.getByRole("button", { name: "Next image", exact: true }));
    else await page.keyboard.press("ArrowRight");
    await viewer.getByText("2 / 2", { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, `${width}-gallery.png`) });
    if (!touch) {
      for (let i = 0; i < 90; i++)
        await service.communicate(human, "opencraft/channels/messages/send", {
          channelId: group.id,
          clientMessageId: width + "-recycle-" + i,
          parts: [{ type: "text", text: "Background message " + i }],
        });
      await page.locator(".im-channel-chat__timeline").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(300);
      assert.equal(await first.count(), 0, "origin image row recycled while gallery stays open");
      await viewer.getByRole("img", { name: "Preview image", exact: true }).waitFor();
    }
    if (touch) await activate(viewer.getByRole("button", { name: "Close image preview", exact: true }));
    else await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    if (touch) assert.equal(await first.evaluate((el) => document.activeElement === el), true);
    else
      assert.equal(
        await page.evaluate(() => !!window.document.activeElement?.matches(".im-channel-chat__conversation")),
        true,
        "fallback focus when origin row recycled",
      );
    // Real native text and Reply/Copy menu; clipboard port only is synthetic.
    await service.communicate(human, "opencraft/channels/messages/send", {
      channelId: group.id,
      clientMessageId: width + "-copy",
      parts: [{ type: "text", text: "Copy exactly this message https://example.com" }],
    });
    const text = page.getByText("Copy exactly this message https://example.com", { exact: true });
    const row = page.getByRole("listitem").filter({ has: text });
    await row.scrollIntoViewIfNeeded();
    if (touch) {
      const box = await row.boundingBox();
      assert.ok(box);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
      });
      await page.waitForTimeout(1000);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    } else await row.click({ button: "right" });
    await activate(page.getByRole("menuitem", { name: "Copy message", exact: true }));
    await page.waitForFunction(() => (window as any).copied.length > 0);
    const copied = await page.evaluate(() => (window as any).copied.at(-1));
    assert.equal(copied["text/plain"], "Copy exactly this message https://example.com");
    assert.equal(
      await page.evaluate((html) => {
        const el = window.document.createElement("div");
        el.innerHTML = html;
        return el.textContent;
      }, copied["text/html"]),
      "Copy exactly this message https://example.com",
    );
    assert.ok(!copied["text/plain"].includes("Human"));
    const attach = async (name: string, type: string, bytes: Buffer) =>
      service.communicate(human, "opencraft/channels/attachments/send", {
        channelId: group.id,
        clientMessageId: width + "-" + name,
        name,
        type,
        base64: bytes.toString("base64"),
      });
    await attach("voice.wav", "audio/wav", fixtureWav);
    const media = page
      .locator(".im-channel-chat__message")
      .filter({ has: page.getByRole("button", { name: "voice.wav", exact: true }) });
    await activate(media.getByRole("button", { name: "Load media", exact: true }));
    await media.locator("audio").waitFor();
    assert.equal(await media.locator("audio").evaluate((el: HTMLAudioElement) => el.autoplay), false);
    await media.locator("audio").evaluate(async (el: HTMLAudioElement) => {
      await el.play();
    });
    await page.waitForTimeout(30);
    await media.locator("audio").evaluate((el) => {
      (el as any).__pauseCount = 0;
      const original = (el as HTMLAudioElement).pause.bind(el);
      (el as HTMLAudioElement).pause = () => {
        (el as any).__pauseCount++;
        original();
      };
    });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.ok(await media.locator("audio").evaluate((el) => (el as any).__pauseCount > 0));
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    });
    const webm = await page.evaluate(async () => {
      const canvas = window.document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#257c62";
      ctx.fillRect(0, 0, 160, 90);
      const stream = canvas.captureStream(10),
        recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" }),
        parts: Blob[] = [];
      const done = new Promise<Blob>((resolve) => {
        recorder.ondataavailable = (e) => parts.push(e.data);
        recorder.onstop = () => resolve(new Blob(parts, { type: "video/webm" }));
      });
      recorder.start();
      await new Promise((r) => setTimeout(r, 200));
      recorder.stop();
      const blob = await done;
      stream.getTracks().forEach((t) => t.stop());
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    });
    await attach("clip.webm", "video/webm", Buffer.from(webm, "base64"));
    const videoRow = page
      .locator(".im-channel-chat__message")
      .filter({ has: page.getByRole("button", { name: "clip.webm", exact: true }) });
    await activate(videoRow.getByRole("button", { name: "Load media", exact: true }));
    await videoRow.locator("video").waitFor();
    assert.equal(await videoRow.locator("video").evaluate((el: HTMLVideoElement) => el.autoplay), false);
    await attach("voice.amr", "audio/amr", Buffer.from("#!AMR\n"));
    const unsupported = page
      .locator(".im-channel-chat__message")
      .filter({ has: page.getByRole("button", { name: "voice.amr", exact: true }) });
    await unsupported.waitFor();
    assert.equal(await unsupported.locator("audio,video").count(), 0);
    const record = {
      version: 1,
      title: "Shared record",
      entries: [
        {
          path: "0",
          sender: { id: "record-author", name: "Record author" },
          parts: [
            { kind: "text", text: "Literal **not emphasis** <script>bad()</script>" },
            { kind: "link", text: "Safe URL", url: "https://example.com/record" },
            { kind: "link", text: "Unsafe URL", url: "javascript:alert(1)" },
            { kind: "image", resource: "0.0", name: "first.png" },
            { kind: "image", resource: "0.1", name: "second.png" },
            { kind: "voice", resource: "0.2", name: "voice.wav" },
          ],
        },
      ],
    };
    await attach("Shared record.chat-record.json", FORWARDED_RECORD_MIME, Buffer.from(JSON.stringify(record)));
    await activate(page.getByRole("button", { name: "Shared record", exact: true }));
    let dialog = page.getByRole("dialog");
    await dialog.getByText("Record author", { exact: true }).waitFor();
    const document = dialog.locator(".opencraft-chat-document").first();
    assert.ok((await document.innerText()).includes("not emphasis"));
    assert.equal(await document.locator("script").count(), 0);
    assert.equal(await document.locator("strong").innerText(), "not emphasis");
    assert.equal(await dialog.locator('a[href^="javascript:"]').count(), 0);
    await dialog.locator('a[aria-disabled="true"]').first().waitFor();
    assert.equal(
      await dialog.locator("a[href]").count(),
      0,
      "quoted record keeps the existing restricted resource policy",
    );
    const photo = dialog.getByRole("button", { name: "View image", exact: true }).first();
    await photo.scrollIntoViewIfNeeded();
    await activate(photo);
    viewer = page.locator(".opencraft-image-preview");
    await viewer.getByRole("img", { name: "first.png", exact: true }).waitFor();
    await activate(viewer.getByRole("button", { name: "Next image", exact: true }));
    await viewer.getByRole("img", { name: "second.png", exact: true }).waitFor();
    await activate(viewer.getByRole("button", { name: "Close image preview", exact: true }));
    await viewer.waitFor({ state: "hidden" });
    await dialog.getByText("Record author", { exact: true }).waitFor();
    await activate(dialog.getByRole("button", { name: "Load media", exact: true }));
    await dialog.locator("audio").waitFor();
    await page.screenshot({ path: join(evidence, `${width}-record.png`) });
    await activate(dialog.getByRole("button", { name: "Close", exact: true }));
    await dialog.waitFor({ state: "hidden" });
    await activate(page.getByRole("button", { name: "Shared record", exact: true }));
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "View image", exact: true }).first().waitFor();
    const calls = await page.evaluate(() => (window as any).proof.calls);
    assert.equal(
      calls[
        group.id +
          ":" +
          (await service.communicate(human, "opencraft/channels/messages/list", { channelId: group.id })).messages.at(
            -1,
          ).sequence +
          ":0.0"
      ],
      1,
      "record row remount reuses application resource",
    );
    await activate(dialog.getByRole("button", { name: "Close", exact: true }));
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await editor.innerText()).trim(), "Keep this draft");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const stable = await page.evaluate(async () => {
      const values: number[] = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        values.push(window.document.querySelector(".im-channel-chat__conversation")!.getBoundingClientRect().height);
      }
      return Math.max(...values) - Math.min(...values);
    });
    assert.ok(stable < 1, "layout settles after native player/image resize");
    const resizeWarnings = await page.evaluate(() => (window as any).resizeWarnings);
    assert.ok(resizeWarnings.length <= 4, "no continuing resize loop");
    assert.deepEqual(errors, []);
    results.push({
      width,
      touch,
      theme,
      gallery: true,
      copy: true,
      audio: true,
      unsupportedFallback: true,
      recordUserDialect: true,
      recordGallery: true,
      cachedRecord: true,
      focusAndDraft: true,
      resizeWarnings,
      settledLayout: true,
    });
    await page.close();
  }
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(
      {
        cases: results,
        realWorkbench: true,
        realNativeTransport: true,
        fixtureIdentity: true,
        recordResourceBoundary: "synthetic provider loader",
        clipboardBoundary: "synthetic clipboard write port",
        physicalPhone: false,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: shared gallery/copy/resources/media/record rendering on actual Workbench, desktop keyboard and touch.",
  );
} catch (error) {
  const p = browser?.contexts().at(-1)?.pages().at(-1);
  if (p) {
    console.error(await p.locator("body").innerText());
    await p.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
  await backend.close();
  await host.close();
  await im.close();
  await service.close();
  actors.close();
  await storage.close();
  await rm(root, { recursive: true, force: true });
}
