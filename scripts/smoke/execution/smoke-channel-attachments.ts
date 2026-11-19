import { ImChannelService } from "../../im-channel-service.mjs";
import { AppHostServer } from "@opencraft/app-host-server";
import { ImChannelsAppServer } from "../../im-channels-appserver.mjs";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import assert from "node:assert/strict";
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
const evidence = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/assistant-chat-design";
const storage = await openServerDatabase(root),
  actors = new ActorStore(storage);
const principal = parsePrincipal({
  provider: "local",
  subject: "ui-human",
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
actors.setGrant(human.actorId, bot.id, "execution.queue", true, "fixture");
await service.bind(bot.id, "fixture-review", 0, () => {});
const claimed = await service.personalAssistant(human, "opencraft/personal-assistant/claim");
const assistantChannel = (await service.personalAssistant(human, "opencraft/personal-assistant/open")).channel;
let runtime: any = {
  phase: "running",
  reception: { running: 1, queued: 0 },
  works: [{ id: "week", title: "本周进展摘要", status: "running", updatedAt: Date.now() }],
};
service.attachPersonalAssistantHost({ state: () => runtime, wake() {} });
await service.communicate(human, "opencraft/channels/messages/send", {
  channelId: assistantChannel.id,
  clientMessageId: "hello",
  parts: [{ type: "text", text: "帮我看看今天还有什么没完成" }],
});
const assistantCredential = await service.provisionPersonalAssistant(human);
const assistantActor = actors.authenticateSession(assistantCredential.credential.token)!;
await service.communicate(assistantActor, "opencraft/channels/messages/send", {
  channelId: assistantChannel.id,
  clientMessageId: "response",
  parts: [
    {
      type: "text",
      text: "还有两件事需要你关注。\n\n1. **确认官网方案**\n\n   设计稿已更新，等你确认\n\n2. **整理本周进展**\n\n   我正在汇总相关会话\n\n整理好后，我会把摘要发在这里。",
    },
  ],
});
await service.communicate(human, "opencraft/channels/messages/send", {
  channelId: assistantChannel.id,
  clientMessageId: "followup",
  parts: [{ type: "text", text: "好，把需要我决定的单独列出来" }],
});
const colleague = actors.resolveHuman(
  parsePrincipal({ provider: "local", subject: "colleague", displayName: "小林", expiresAt: Date.now() + 3600000 })!,
)!;
const discussion = await service.communicate(human, "opencraft/channels/group/create", {
  title: "产品方案讨论",
  memberActorIds: [colleague.actorId, bot.id],
  clientRequestId: "group-one",
});
await service.communicate(colleague, "opencraft/channels/messages/send", {
  channelId: discussion.id,
  clientMessageId: "discussion-human",
  parts: [{ type: "text", text: "设计稿更新好了，大家看看这个方案。" }],
});
await service.communicate(botContext, "opencraft/channels/messages/send", {
  channelId: discussion.id,
  clientMessageId: "discussion-bot",
  parts: [{ type: "text", text: "已整理好待确认项：\n\n- **导航**：统一入口\n- **排版**：保持阅读轴线" }],
});
await service.communicate(human, "opencraft/channels/messages/send", {
  channelId: discussion.id,
  clientMessageId: "discussion-self",
  parts: [{ type: "text", text: "收到，下午一起确认。" }],
});
await service.communicate(human, "opencraft/channels/group/create", {
  title: "下周工作计划",
  memberActorIds: [],
  clientRequestId: "group-two",
});
const archive = await service.communicate(human, "opencraft/channels/group/create", {
  title: "历史归档",
  memberActorIds: [colleague.actorId],
  clientRequestId: "group-history",
});
for (let i = 0; i < 240; i++)
  await service.communicate(colleague, "opencraft/channels/messages/send", {
    channelId: archive.id,
    clientMessageId: "archive-" + i,
    parts: [{ type: "text", text: "历史消息 " + i + "：" + "验证长内容的测量与阅读锚点。".repeat((i % 5) + 1) }],
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
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
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
initializeAppearanceTheme();setAppearanceThemeId('opencraft.core.lavender');
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,stallStatus:()=>{ChannelsClient.prototype.assistantStatus=()=>new Promise(()=>{});}};document.body.dataset.ready='true';`;
const applicationConfig = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  "apps/workbench-web/vite.config.ts",
);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: ".local/assistant-chat-design-vite",
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
          if (req.url === "/") {
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
try {
  await server.listen();
  await mkdir(evidence, { recursive: true });
  for (const [width, theme] of [
    [1160, "light"],
    [390, "light"],
    [390, "dark"],
    [820, "dark"],
  ] as const) {
    if (process.env.OPENCRAFT_SMOKE_WIDTH && width !== Number(process.env.OPENCRAFT_SMOKE_WIDTH)) continue;
    console.log("CASE", width, theme);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    runtime = {
      phase: "running",
      reception: { running: 1, queued: 0 },
      works: [{ id: "week", title: "本周进展摘要", status: "running", updatedAt: Date.now() }],
    };
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 1000 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const activate = (locator: import("playwright").Locator) => (width < 1000 ? locator.tap() : locator.click());
    await page.addInitScript("window.__name = target => target;");
    await page.goto(server.resolvedUrls!.local[0], { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector('body[data-ready="true"]', { state: "attached", timeout: 90000 });
    await page.evaluate((theme) => (window as any).proof.theme(theme), theme);
    const sidebar = page.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
    if ((await sidebar.count()) && (await sidebar.getAttribute("aria-expanded")) !== "true") await activate(sidebar);
    await activate(page.getByRole("button", { name: "Inbox", exact: true }));
    const sidebarClose = page.getByRole("button", { name: "关闭侧边栏", exact: true });
    if (width < 1000 && (await sidebarClose.count())) {
      const box = await sidebarClose.boundingBox();
      if (box) await sidebarClose.tap({ position: { x: box.width - 8, y: box.height / 2 } });
    }
    await activate(page.getByRole("button", { name: "打开助理", exact: true }));
    const close = page.getByRole("button", { name: "关闭侧边栏", exact: true });
    if (width < 1000 && (await close.count())) {
      const box = await close.boundingBox();
      if (box) await close.tap({ position: { x: box.width - 8, y: box.height / 2 } });
    }
    await page.getByText("正在回复…", { exact: true }).waitFor({ timeout: 15000 });
    await page.locator(".im-channel-chat__message:visible").first().waitFor({ timeout: 60000 });
    const editor = page.locator('[contenteditable="true"]:visible').last();

    const photo = {
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4AWP8DwQMSICJAQ0wMaABJgY0AAAGXQQEOHaWpAAAAABJRU5ErkJggg==",
        "base64",
      ),
    };
    const document = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("attachment file contents") };
    const attach = async (files: any) => {
      const chooser = page.waitForEvent("filechooser");
      await activate(page.locator(".im-channel-chat__dock .opencraft-composer-footer__attachment button").first());
      await (await chooser).setFiles(files);
    };
    await editor.fill("请查看图片 " + width + theme);
    await attach(photo);
    await activate(page.getByRole("button", { name: "发送附件", exact: true }));
    await page.waitForFunction(() => !document.querySelector(".opencraft-composer-attachments"));
    assert.equal((await editor.innerText()).trim(), "");
    await page.locator(".im-channel-chat__picture img").last().waitFor();
    const uploaded = (
      await service.communicate(human, "opencraft/channels/messages/list", { channelId: assistantChannel.id })
    ).messages.at(-1);
    assert.equal(uploaded.text, "请查看图片 " + width + theme);
    assert.equal(uploaded.attachment.name, "photo.png");
    await attach(document);
    await editor.fill("Read this file");
    await activate(page.getByRole("button", { name: "发送附件", exact: true }));
    await page.waitForFunction(() => !document.querySelector(".opencraft-composer-attachments"));
    assert.equal((await editor.innerText()).trim(), "");
    const downloads = page.waitForEvent("download");
    await activate(page.getByRole("button", { name: "notes.txt", exact: true }).last());
    const downloaded = await downloads;
    assert.equal(downloaded.suggestedFilename(), "notes.txt");
    const stream = await downloaded.createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "attachment file contents");
    // The ordinary Composer owns late edits; native receipt may only consume the submitted snapshot.
    const resume = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const communicate = service.communicate.bind(service);
    (service as any).communicate = async (c: any, m: string, p: any) => {
      if (m === "opencraft/channels/attachments/send") {
        entered.resolve();
        await resume.promise;
      }
      return communicate(c, m, p);
    };
    await attach({ ...document, name: "later.txt" });
    await editor.fill("original caption");
    await activate(page.getByRole("button", { name: "发送附件", exact: true }));
    await entered.promise;
    assert.equal(await page.locator(".opencraft-composer-stack").getAttribute("aria-busy"), "true");
    resume.resolve();
    await page.waitForFunction(() => !document.querySelector(".opencraft-composer-attachments"));
    assert.equal((await editor.innerText()).trim(), "");
    await editor.fill("不要清掉新草稿");
    (service as any).communicate = communicate;
    await page.screenshot({ path: join(evidence, "attachments-" + theme + "-" + width + ".png"), fullPage: true });
    await editor.fill("");
    const switcher = page.getByRole("button", { name: "切换聊天", exact: true });
    await activate(switcher);
    await activate(page.getByRole("dialog").getByRole("button", { name: /^产品方案讨论/ }));
    await attach({ ...document, name: "group-file.txt" });
    await activate(page.getByRole("button", { name: "发送附件", exact: true }));
    await page.waitForFunction(() => !document.querySelector(".opencraft-composer-attachments"));
    await page.getByRole("button", { name: "group-file.txt", exact: true }).last().waitFor();
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
  }
  console.log(
    "PASS attachment route: actual Composer plus picker, native RPC, database, assistant/group photo and file, captions, download, late draft preservation; desktop/touch light/dark.",
  );
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) {
    console.error(
      await page
        .locator("body")
        .innerText({ timeout: 2000 })
        .catch(() => "(page unavailable)"),
    );
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true, timeout: 2000 }).catch(() => {});
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
