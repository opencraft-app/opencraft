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
const evidence = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/channel-weaknet-ui";
const storage = await openServerDatabase(root),
  actors = new ActorStore(storage);
const principal = parsePrincipal({
  provider: "local",
  subject: "weak-network-human",
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
await application.supervisor.extensions.activateOptional({
 manifest:{manifestVersion:1,id:'fixture.identity-avatar',name:'Avatar fixture',version:'1.0.0',apiVersion:1,trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},
 activate(api){api.internal.register('identityAvatar',{id:'fixture.avatar',resolve:(kind,name)=>{(window.avatarLookups??=[]).push([kind,name]);return kind==='employee'&&name==='verified-human'?'/fixture-avatar.svg':null;}});}
});
createIntlTestRoot(document.getElementById('app'),undefined,'en-US').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,openGroup:id=>application.supervisor.navigation.openExtensionView('opencraft.im.channel-chat','opencraft-channel:'+id)};document.body.dataset.ready='true';`;
const applicationConfig = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  "apps/workbench-web/vite.config.ts",
);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: ".local/channel-avatar-ui-vite",
  logLevel: "error",
  define: {
    "import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST": '"true"',
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
          if (req.url === "/fixture-avatar.svg") {
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

const originalCommunicate = service.communicate.bind(service);
(service as any).communicate = async (...args: any[]) => {
  if (args[1] === "opencraft/channels/attachments/upload") await new Promise((r) => setTimeout(r, 180));
  return (originalCommunicate as any)(...args);
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await server.listen();
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [1160, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("pageerror", e.message);
    });
    await page.addInitScript("window.__name = target => target;");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let probes = 0;
    await page.route("**/__opencraft_browser/capabilities", async (route) => {
      probes++;
      await held;
      await route
        .fulfill({ status: 200, contentType: "application/json", body: '{"available":false}' })
        .catch(() => {});
    });
    await page.goto(server.resolvedUrls!.local[0], { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForSelector('body[data-ready="true"]', { state: "attached", timeout: 30000 });
    console.log("shell-ready", width, probes);
    assert.ok(probes > 0);
    release();
    const activate = (locator: import("playwright").Locator) => (width === 390 ? locator.tap() : locator.click());
    const group = (await service.communicate(human, "opencraft/channels/group/create", {
      title: "Weak network " + width,
      memberActorIds: [bot.id],
      clientRequestId: "weak-" + width,
    })) as { id: string };
    const open = async () => {
      await page.evaluate((id) => (window as any).proof.openGroup(id), group.id);
      const close = page.getByRole("button", { name: "Close sidebar", exact: true });
      if (width === 390 && (await close.count())) {
        const b = await close.boundingBox();
        if (b) await close.tap({ position: { x: b.width - 8, y: b.height / 2 } });
      }
    };
    await open();
    console.log("group-open", width);
    let editor = page.locator('[contenteditable="true"]:visible').last();
    await editor.fill("Preserved draft " + width);
    console.log("draft-filled", width);
    // IndexedDB commits are asynchronous; wait for the storage worker, not network.
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('body[data-ready="true"]', { state: "attached", timeout: 90000 });
    await open();
    editor = page.locator('[contenteditable="true"]:visible').last();
    await editor.waitFor();
    assert.equal(await editor.innerText(), "Preserved draft " + width);
    await page.screenshot({ path: join(evidence, "draft-" + width + ".png"), fullPage: true });
    await activate(page.getByRole("button", { name: "Send message", exact: true }));
    await page.getByText("Preserved draft " + width, { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll('[contenteditable="true"]')].some((node) =>
          node.textContent?.includes("Preserved draft"),
        ),
    );
    await page.screenshot({ path: join(evidence, "before-file-" + width + ".png"), fullPage: true });
    console.log("attachment-controls", await page.getByRole("button", { name: "Add", exact: true }).count());
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      activate(page.getByRole("button", { name: "Add", exact: true }).last()),
    ]);
    await chooser.setFiles({ name: "weak-network.txt", mimeType: "text/plain", buffer: Buffer.alloc(256 * 1024, 65) });
    console.log("file-picked", width);
    await activate(page.getByRole("button", { name: "Send attachment", exact: true }));
    await page.getByText(/Uploading attachment/).waitFor();
    await page.screenshot({ path: join(evidence, "upload-" + width + ".png"), fullPage: true });
    await page.getByRole("button", { name: "weak-network.txt", exact: true }).waitFor({ timeout: 30000 });
    const download = page.waitForEvent("download");
    await activate(page.getByRole("button", { name: "weak-network.txt", exact: true }));
    await download;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('body[data-ready="true"]', { state: "attached", timeout: 90000 });
    await open();
    editor = page.locator('[contenteditable="true"]:visible').last();
    await editor.waitFor();
    assert.equal((await editor.innerText()).trim(), "");
    const history = (await service.communicate(human, "opencraft/channels/messages/list", {
      channelId: group.id,
    })) as any;
    assert.equal(history.messages.length, 2, "refresh must not replay accepted text or file");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        width,
        touch: width === 390,
        shellBeforeCapability: true,
        draftRestored: true,
        chunkUploadDownload: true,
        noReplay: true,
      }),
    );
    await page.close();
  }
} catch (error) {
  console.error(error);
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) {
    console.error(await page.locator("body").innerText());
    await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true });
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
