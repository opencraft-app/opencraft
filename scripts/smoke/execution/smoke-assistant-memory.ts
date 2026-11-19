import {installAssistantHostExtension} from "../../../apps/personal-assistant/src/runtime/host-extension.mjs";
import { AssistantThreadCommands } from "../../../packages/access-control/src/assistant-thread-commands";
import { ThreadAccessStore } from "../../../packages/access-control/src/thread-access";
import { createAssistantModelSource } from "../../../apps/local-agent-host/src/model-config/assistant";
import { ModelConfigurationRepository } from "../../../apps/local-agent-host/src/model-config/repository";
import { createPersonalAssistantHost, spawnAssistant } from "../../../apps/personal-assistant/src/runtime/host-supervisor.mjs";
import { ImChannelService } from "../../im-channel-service.mjs";
import { AppHostServer } from "@opencraft/app-host-server";
import { ImChannelsAppServer } from "../../im-channels-appserver.mjs";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, loadConfigFromFile } from "vite";
import { chromium } from "playwright";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../../packages/access-control/src/actors";
import { ActorAccess } from "../../../packages/access-control/src/actor-access";
import {
  Collaboration,
  CollaborationHttpApi,
} from "../../../packages/access-control/src/collaboration";
import { parsePrincipal } from "@opencraft/identity-core";

// Actual Workbench extension, native transport, communication authority and DB.
// Identity admission and worker execution are explicit fixtures. Model selection uses the real repository and RPC.
const root = await mkdtemp(join(tmpdir(), "personal-assistant-ui-"));
const evidence =
  process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/personal-assistant-ui";
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
const credential = actors.issueCredential(
    bot.id,
    Date.now() + 3600000,
    human.actorId,
  ),
  botContext = actors.authenticateSession(credential.token)!;
actors.setGrant(human.actorId, bot.id, "message.send", true, "fixture");
const service = new Collaboration(storage, actors, {
  hostId: "local-codex",
  serverId: "fixture",
  hostForServer: () => "local-codex",
  async discover() {
    return {
      conversations: [
        {
          ref: { serverId: "fixture", threadId: "task-source" },
          title: "Project task settings",
        },
      ],
      nextCursor: null,
    };
  },
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
const threadAccess = new ThreadAccessStore(storage, actors);
threadAccess.created("fixture", "task-source", human, "private");
const threadCommands = new AssistantThreadCommands(
  service,
  {
    async prepare() {
      return { cwd: "/project", model: "granted", sandbox: "read-only" };
    },
    async create() {
      throw Error("not used");
    },
    async createRoot() {
      throw Error("not used");
    },
    async snapshot(threadId) {
      return { threadId, rootTurnId: null, turnId: null, state: "completed" };
    },
  },
  threadAccess,
);
await threadCommands.initialize();
const models = new ModelConfigurationRepository(join(root, "models"));
await models.initialize();
await models.update(0, (d) => {
  d.providers = [
    {
      id: "smoke",
      name: "Local test",
      enabled: true,
      protocol: "openai-responses",
      baseUrl: "http://127.0.0.1:1/v1",
      authentication: "none",
      credentialRef: null,
      models: [
        { id: "model-a", name: "Assistant A", enabled: true },
        { id: "model-b", name: "Assistant B", enabled: true },
      ],
    },
  ];
});
const claimed = await service.personalAssistant(
  human,
  "opencraft/personal-assistant/claim",
);
let runtimeEnabled = true;
const startupFailures:string[]=[];
installAssistantHostExtension({reportFailure(error){startupFailures.push(error instanceof Error?error.message:String(error));}});
const assistantHost = await createPersonalAssistantHost({
  spawn(options){
    const handle=spawnAssistant(options);
    void handle.ready.catch(error=>startupFailures.push(error instanceof Error?error.message:String(error)));
    return handle;
  },
  directory: root,
  service,
  readConfig: async () =>
    !runtimeEnabled
      ? null
      : {
          profileOptions: { mode: "fixture", telemetry: { enabled: false } },
        },
  intervalMs: 25,
});
for (
  let i = 0;
  assistantHost.state(claimed.assistant.binding.botId).phase !== "running";
  i++
) {
  if (i > 300) {
    const state=assistantHost.state(claimed.assistant.binding.botId);
    await assistantHost.close();
    throw Error("Host not ready: "+JSON.stringify({state,startupFailures}));
  }
  await new Promise((r) => setTimeout(r, 20));
}
const memoryFolder = join(
  root,
  "bots",
  claimed.assistant.binding.botId,
  "memory",
);
await mkdir(memoryFolder, { recursive: true });
await writeFile(
  join(memoryFolder, "profile.md"),
  "# 私有档案\n\n普通说明不是生效的记忆。\n\n" +
    Array.from(
      { length: 35 },
      (_, i) =>
        "- (2026-11-14) 记忆测试 " +
        String(i).padStart(2, "0") +
        "：喜欢清淡口味",
    ).join("\n") +
    "\n",
);
await mkdir(join(memoryFolder, "log"), { recursive: true });
await writeFile(
  join(memoryFolder, "log", "2026-01.md"),
  "# 纯文档\n只有普通段落，没有已识别事实。\n",
);
const seeded = [];
for (let i = 0; i < 5; i++) {
  const group = await service.communicate(
    human,
    "opencraft/channels/group/create",
    {
      title: "项目讨论 " + i,
      memberActorIds: [bot.id],
      clientRequestId: "directory-" + i,
    },
  );
  seeded.push(group);
  if (i < 4)
    await service.communicate(botContext, "opencraft/channels/messages/send", {
      channelId: group.id,
      clientMessageId: "preview-" + i,
      parts: [{ type: "text", text: "进展更新 " + i }],
    });
}
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
const { port: backendPort } = await backend.listen({
  host: "127.0.0.1",
  port: 0,
});
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId,frostThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createImExtension} from '/plugins/im/src/index.tsx';
import {connectWebSocketAppHost} from '/apps/workbench-web/src/runtime/websocket-app-host.ts';
import {createChannelsRpc} from '/apps/workbench-web/src/runtime/channels-rpc.ts';
import {CHANNELS_HOST_ID} from '/packages/appserver-protocol/src/channels.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
const wire=connectWebSocketAppHost();
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window),signal=>createChannelsRpc(wire.createTransport(CHANNELS_HOST_ID),signal)));
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={theme:(name)=>{setThemePreference(name==='frost'?'light':name);if(name==='frost')setAppearanceThemeId(frostThemeId);}};document.body.dataset.ready='true';`;
const applicationConfig = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  "apps/workbench-web/vite.config.ts",
);
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: ".local/personal-assistant-ui-vite",
  logLevel: "error",
  define: {
    "process.env.NEXT_PUBLIC_REGION": '"cn"',
    "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"',
    "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"',
  },
  optimizeDeps: {
    ...applicationConfig!.config.optimizeDeps,
    include: [
      ...applicationConfig!.config.optimizeDeps!.include!,
      "@opencraft/browser-core/presentation",
    ],
  },
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    proxy: {
      "/apphost": { target: "http://127.0.0.1:" + backendPort, ws: true },
    },
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
          } else if (req.url?.startsWith("/__opencraft_actors/collaboration/"))
            void api.handle(req, res);
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
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [1160, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      hasTouch: width < 600,
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("Browser error:", e.message);
    });
    await page.addInitScript("window.__name = target => target;");
    await page.goto(server.resolvedUrls!.local[0], {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await page.waitForSelector('body[data-ready="true"]', {
      state: "attached",
      timeout: 90000,
    });
    const sidebar = page
      .locator('[data-chrome-action-id="sidebar-toggle"]:visible')
      .first();
    if (
      (await sidebar.count()) &&
      (await sidebar.getAttribute("aria-expanded")) !== "true"
    )
      await sidebar.click();
    await page.getByRole("button", { name: "助理", exact: true }).click();
    const closeSidebar = page.getByRole("button", {
      name: "关闭侧边栏",
      exact: true,
    });
    if (width < 600 && (await closeSidebar.count())) {
      const box = await closeSidebar.boundingBox();
      if (box)
        await closeSidebar.tap({
          position: { x: box.width - 8, y: box.height / 2 },
        });
    }
    await page
      .getByRole("heading", { name: "我的助理", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "记忆", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".assistant-memory-item").length === 30,
    );
    const memoryView = page.locator(".assistant-memory");
    const firstBox = await memoryView.locator(".assistant-memory-item").first().boundingBox();
    const headerBox = await memoryView.boundingBox();
    assert.ok(firstBox && headerBox && firstBox.y - headerBox.y < (width < 600 ? 330 : 260), "Content must appear without a wall of explanation");
    assert.equal(await memoryView.locator(".assistant-memory-about").getAttribute("open"), null);
    assert.notEqual(await memoryView.locator('.assistant-memory-tabs button[aria-pressed="true"]').evaluate(e => getComputedStyle(e).borderBottomColor), "rgba(0, 0, 0, 0)");
    await page.screenshot({path:join(evidence,"memory-list-"+width+".png"),fullPage:true});
    for (const theme of ["dark", "frost", "light"]) {
      await page.evaluate(theme => (window as any).proof.theme(theme), theme);
      await page.screenshot({path:join(evidence,"memory-list-"+width+"-"+theme+".png"),fullPage:true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.waitForFunction(
      (n) => document.querySelectorAll(".assistant-memory-item").length === n,
      width === 1160 ? 35 : 34,
    );
    const view = page.locator(".assistant-memory");
    await view
      .locator(".assistant-memory-item")
      .filter({ hasText: "记忆测试 05" })
      .click();
    if(width < 600) {
      assert.equal(await view.locator(".assistant-memory-list").isVisible(),false);
      assert.equal(await view.locator(".assistant-memory-detail").evaluate(e => e === document.activeElement),true);
      await view.getByRole("button", {name:"返回记忆列表",exact:true}).click();
      assert.equal(await view.locator(".assistant-memory-list").isVisible(),true);
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.memoryKey),await view.locator('.assistant-memory-item').filter({hasText:"记忆测试 05"}).getAttribute('data-memory-key'));
      await view.locator('.assistant-memory-item').filter({hasText:"记忆测试 05"}).click();
    }
    await view.getByRole("button", { name: "原始文档", exact: true }).click();
    await page
      .getByText("普通说明不是生效的记忆。", { exact: false })
      .waitFor();
    assert.match(await view.locator("pre").innerText(), /# 私有档案/);
    await view.getByRole("button", { name: "来源", exact: true }).click();
    await view.getByText("未记录来源", { exact: true }).last().waitFor();
    await page.screenshot({
      path: join(evidence, "memory-" + width + ".png"),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    if (width === 1160) {
      await view
        .locator(".assistant-memory-item")
        .filter({ hasText: "记忆测试 00" })
        .click();
      await view.getByRole("button", { name: "纠正", exact: true }).click();
      let editor = view.getByRole("textbox", { name: "纠正", exact: true });
      await editor.fill("纠正后的偏好：不要香菜");
      let guarded = 0;
      page.once("dialog", async (dialog) => {
        guarded++;
        await dialog.dismiss();
      });
      await view
        .locator(".assistant-memory-item")
        .filter({ hasText: "记忆测试 05" })
        .click();
      assert.equal(guarded, 1);
      assert.equal(await editor.inputValue(), "纠正后的偏好：不要香菜");
      page.once("dialog", async (dialog) => {
        guarded++;
        await dialog.dismiss();
      });
      await view.getByRole("button", { name: "刷新", exact: true }).click();
      assert.equal(guarded, 2);
      assert.equal(await editor.inputValue(), "纠正后的偏好：不要香菜");
      page.once("dialog", async (dialog) => {
        guarded++;
        await dialog.dismiss();
      });
      await page.getByRole("button", { name: "记忆", exact: true }).click();
      assert.equal(guarded, 3);
      assert.equal(await editor.inputValue(), "纠正后的偏好：不要香菜");
      page.once("dialog",async dialog=>{guarded++;await dialog.dismiss();});
      await view.getByRole("button",{name:"返回记忆列表",exact:true}).click();
      assert.equal(guarded,4);
      assert.equal(await editor.inputValue(),"纠正后的偏好：不要香菜");
      page.once("dialog",async dialog=>{guarded++;await dialog.dismiss();});
      await page.getByRole("button",{name:"助理设置",exact:true}).click();
      assert.equal(guarded,5);
      assert.equal(await view.isVisible(),true);
      assert.equal(await editor.inputValue(),"纠正后的偏好：不要香菜");
      await page.getByRole("button", { name: "Inbox", exact: true }).click();
      await page.getByRole("button", { name: "助理", exact: true }).click();
      if (!(await view.isVisible()))
        await page.getByRole("button", { name: "记忆", exact: true }).click();
      editor = view.getByRole("textbox", { name: "纠正", exact: true });
      await editor.waitFor();
      assert.equal(await editor.inputValue(), "纠正后的偏好：不要香菜");
      const binding = claimed.assistant.binding,
        call = (params: any) =>
          service.personalAssistant(
            human,
            "opencraft/personal-assistant/memory",
            {
              botId: binding.botId,
              assignmentId: binding.assignmentId,
              ...params,
            },
          );
      const before = await call({ action: "list", query: "记忆测试 00" }),
        item = before.items[0];
      await call({
        action: "set",
        key: item.key,
        value: "其他地方刚更新的偏好",
        expectedRevision: item.revision,
        requestId: "browser-concurrent-0001",
      });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await view
        .getByText("记忆有新变化，当前内容和草稿未被覆盖。", { exact: true })
        .waitFor();
      assert.equal(await editor.inputValue(), "纠正后的偏好：不要香菜");
      await view.getByRole("button", { name: "保存纠正", exact: true }).click();
      await view
        .getByText("记忆已在别处更新，本次纠正未写入；草稿已保留。", {
          exact: true,
        })
        .waitFor();
      assert.equal(await editor.inputValue(), "纠正后的偏好：不要香菜");
      await view
        .locator(".assistant-memory-edit")
        .getByRole("button", { name: "读取最新版本（保留草稿）", exact: true })
        .click();
      await view
        .locator(".assistant-memory-latest")
        .getByText("其他地方刚更新的偏好", { exact: true })
        .waitFor();
      assert.equal(await editor.inputValue(), "纠正后的偏好：不要香菜");
      assert.equal(
        await view
          .getByRole("button", { name: "保存纠正", exact: true })
          .isDisabled(),
        true,
      );
      await page.screenshot({
        path: join(evidence, "draft-conflict-" + width + ".png"),
        fullPage: true,
      });
      await view
        .getByRole("button", { name: "以此版本为基础继续纠正", exact: true })
        .click();
      await view.getByRole("button", { name: "保存纠正", exact: true }).click();
      await view.getByText("记忆已更新。", { exact: true }).waitFor();
      assert.match(
        await view.locator(".assistant-memory-item").first().innerText(),
        /纠正后的偏好/,
      );
      const checked = await call({ action: "list", query: "纠正后的偏好" });
      assert.equal(checked.items.length, 1);
      assert.equal(checked.items[0].revision, item.revision + 2);
      const search = view.getByRole("textbox", {
        name: "搜索记忆",
        exact: true,
      });
      await search.fill("纠正后的偏好");
      await view.getByRole("button", { name: "搜索", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll(".assistant-memory-item").length === 1,
      );
      await view.locator(".assistant-memory-item").click();
      await view.getByRole("button", { name: "忘记", exact: true }).click();
      await view.getByRole("button", { name: "确认忘记", exact: true }).click();
      await view.getByText("已忘记这条记忆。", { exact: true }).waitFor();
      assert.equal(
        (await call({ action: "list", query: "纠正后的偏好" })).items.length,
        0,
      );
      await view.getByRole("button", { name: "文档", exact: true }).click();
      await view
        .locator(".assistant-memory-item")
        .filter({ hasText: "log/2026-01.md" })
        .click();
      await view
        .locator("pre")
        .getByText("只有普通段落，没有已识别事实。", { exact: false })
        .waitFor();
      runtimeEnabled = false;
      for (
        let i = 0;
        assistantHost.state(binding.botId).phase !== "config_required";
        i++
      ) {
        if (i > 300) throw Error("Host did not stop");
        await new Promise((r) => setTimeout(r, 20));
      }
      await view.getByRole("button", { name: "刷新", exact: true }).click();
      await view
        .getByText(
          "只读模式：管家尚未运行。无需启动模型即可浏览，修改仍需原管家进程就绪。",
          { exact: true },
        )
        .waitFor();
      await view
        .locator(".assistant-memory-item")
        .filter({ hasText: "log/2026-01.md" })
        .click();
      await view
        .locator("pre")
        .getByText("只有普通段落，没有已识别事实。", { exact: false })
        .waitFor();
      await page.screenshot({
        path: join(evidence, "offline-documents-" + width + ".png"),
        fullPage: true,
      });
    } else {
      assert.equal(
        await view
          .getByRole("button", { name: "纠正", exact: true })
          .isDisabled(),
        true,
      );
      await view.getByRole("button", { name: "文档", exact: true }).click();
      await view
        .locator(".assistant-memory-item")
        .filter({ hasText: "log/2026-01.md" })
        .click();
      await view
        .locator("pre")
        .getByText("只有普通段落，没有已识别事实。", { exact: false })
        .waitFor();
    }
    if (width < 600) {
      await view.getByRole("button", {name:"返回记忆列表",exact:true}).click();
      await view.getByRole("button", {name:"已记住",exact:true}).click();
      await page.setViewportSize({width:320,height:740});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false,"320px has no overflow");
      const submitBox=await view.getByRole("button",{name:"搜索",exact:true}).boundingBox();
      assert.ok(submitBox && submitBox.height>=32 && submitBox.width>=32);
      await page.screenshot({path:join(evidence,"memory-list-320.png"),fullPage:true});
      await page.setViewportSize({width:390,height:900});
      await view.getByRole("textbox",{name:"搜索记忆",exact:true}).fill("记忆测试 05");
      await view.getByRole("button",{name:"搜索",exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll(".assistant-memory-item").length===1);
      await page.screenshot({path:join(evidence,"memory-single-390.png"),fullPage:true});
      await view.locator(".assistant-memory-about summary").click();
      await view.getByText("这里只展示你个人管家的私有记忆，不包括群聊或共享记忆。",{exact:true}).waitFor();
      await view.getByRole("textbox",{name:"搜索记忆",exact:true}).fill("没有这个记忆-empty");
      await view.getByRole("button",{name:"搜索",exact:true}).click();
      await view.getByText("没有找到符合条件的记忆。",{exact:true}).waitFor();
      await page.screenshot({path:join(evidence,"memory-empty-390.png"),fullPage:true});
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "PASS: native Workbench + isolated Host; dirty guards, session draft restoration, CAS comparison, recent ordering, non-destructive update hint, independent prose catalogue and runtime-offline reads; desktop/touch no overflow or browser errors. No external model/deployment.",
  );
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) {
    console.error(await page.locator("body").innerText());
    await page.screenshot({
      path: join(evidence, "failure.png"),
      fullPage: true,
    });
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
  await backend.close();
  await host.close();
  await im.close();
  await assistantHost.close();
  await threadCommands.close();
  threadAccess.close();
  await service.close();
  actors.close();
  await storage.close();
  await rm(root, { recursive: true, force: true });
}
