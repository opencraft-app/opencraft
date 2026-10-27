import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { ImChannelService } from "../../im-channel-service.mjs";
import { sourceRoute } from "../../../plugins/im/src/templates";

// Real Settings/Supervisor/IM UI, HTTP API, SQLite and QuickJS. Only human
// admission and external platform transports are synthetic; no real IM sends.
const dataDirectory = await mkdtemp(join(tmpdir(), "im-ui-"));
const evidence = process.env.OPENCRAFT_IM_EVIDENCE ?? ".local/im-channels";
const context = {
  actorId: "fixture-human",
  generation: 1,
  credentialId: null,
  expiresAt: Date.now() + 3600000,
};
const credentials = new Map<string, string>();
const service = await ImChannelService.open([], {
  dataDirectory,
  actors: {
    get: (id: string) =>
      id === context.actorId
        ? { enabled: true, kind: "human", generation: 1 }
        : null,
    isCurrent: (c: any) => c.actorId === context.actorId,
  },
  actorAccess: { authenticate: () => context },
  collaboration: {
    execution: { serverId: "fixture-server", hostId: "fixture-host", servers: [
      {serverId:"fixture-server",hostId:"fixture-host",label:"Codex"},
      {serverId:"fixture-pi",hostId:"opencraft-server",label:"Pi"},
      {serverId:"fixture-dsh",hostId:"opencraft-server",label:"DSH"},
    ] },
    discover: async () => ({conversations:[
      {ref:{serverId:"fixture-server",threadId:"codex-one"},title:"Codex conversation"},
      {ref:{serverId:"fixture-pi",threadId:"pi_one"},title:"Pi conversation"},
      {ref:{serverId:"fixture-dsh",threadId:"dsh-one"},title:"DSH conversation"},
    ],nextCursor:null}),
  },
  getAppHost: () => null,
  credentials: {
    set: async (k: string, v: string) => credentials.set(k, v),
    resolve: async (k: string) => credentials.get(k),
    remove: async (k: string) => credentials.delete(k),
  },
  createWeCom: () => ({
    state: "ready",
    start() {},
    close() {},
    deliver: async () => {
      throw Error("No external sends in UI smoke");
    },
  }),
});
function seedChannel() {
service.store.saveChannel(
  {
    id: "fixture-channel",
    provider: "wecom",
    ownerId: context.actorId,
    name: "工程助手",
    botId: "fixture-bot",
    groupScope: "sender",
  },
  false,
  null,
);
service.store.route("fixture-channel", 1, sourceRoute, true);
}
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createWebWorkbenchApplication,WorkbenchRoot} from '/apps/workbench-web/src/workbench-root.tsx';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {createSmokeClientProduct} from '/tests/fixtures/client-product.ts';
import {createImExtension} from '/plugins/im/src/index.tsx';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const application=await createWebWorkbenchApplication({hostProfileMode:'configured',navigationMode:'memory',clientProduct:createSmokeClientProduct()});
await application.supervisor.extensions.activateOptional(createImExtension(fetch.bind(window)));
application.supervisor.navigation.openSettings('opencraft.im.channels');
createIntlTestRoot(document.getElementById('app'),undefined,'zh-CN').render(<WorkbenchRoot application={application}/>);
window.proof={theme:setThemePreference,open:()=>application.supervisor.navigation.openSettings('opencraft.im.channels'),away:()=>application.supervisor.navigation.openSettings('appearance')};
document.body.dataset.ready='true';`;
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: ".local/im-channels/vite-cache",
  logLevel: "error",
  define: {
    "process.env.NEXT_PUBLIC_REGION": '"cn"',
    "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"',
    "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"',
  },
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "im-smoke",
      resolveId: (id) => (id === "/im-proof.tsx" ? id : null),
      load: (id) => (id === "/im-proof.tsx" ? source : null),
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<html><body><div id="app"></div><script type="module" src="/im-proof.tsx"></script></body></html>',
            );
          } else if (req.url?.startsWith("/__opencraft_im"))
            // Exercise exact browser Origin/Host instead of bypassing CSRF checks.
            void service.handle(req, res, () => false);
          else next();
        });
      },
    },
  ],
});
let browser: any;
try {
  await server.listen();
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e: Error) => {
    errors.push(e.message);
    console.error(e.message);
  });
  page.on("console", (m: any) => {
    if (m.type() === "error") console.error(m.text().slice(0, 400));
  });
  await page.addInitScript("window.__name = target => target;");
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
  for (const theme of ["light", "dark"]) for (const width of [320, 390, 1160]) {
    const touch = width < 600;
    const sample = await browser.newPage({ viewport: {width, height: 760}, hasTouch: touch });
    await sample.addInitScript("window.__name = target => target;");
    sample.on("pageerror", (e: Error) => errors.push(e.message));
    await sample.goto(server.resolvedUrls!.local[0]);
    await sample.waitForSelector('body[data-ready="true"]', {timeout: 60000});
    await sample.evaluate((t: string) => (window as any).proof.theme(t), theme);
    const toggle = sample.locator('[data-chrome-action-id="sidebar-toggle"]:visible').first();
    if (touch && await toggle.getAttribute("aria-expanded") === "true") await toggle.press("Enter");
    await sample.waitForTimeout(400);
    const empty = sample.locator(".im-empty");
    await empty.waitFor();
    assert.ok(await empty.evaluate((el: Element) => {
      const title=el.querySelector('h3')!, copy=el.querySelector('p')!;
      return getComputedStyle(title).marginTop==='0px' && getComputedStyle(copy).marginBottom==='0px';
    }), 'empty state resets browser heading and paragraph margins');
    await sample.screenshot({path: join(evidence, `${theme}-${width}-empty.png`)});
    const add = sample.getByRole('button', {name:'添加渠道', exact:true});
    if(touch) await add.tap(); else await add.click();
    const dialog=sample.getByRole('dialog'); await dialog.waitFor();
    const bounds=await dialog.boundingBox();
    assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=width+1 && bounds.y>=0 && bounds.y+bounds.height<=761, 'shared dialog stays within viewport');
    assert.ok(await dialog.evaluate((el: Element) => {
      const label=el.querySelector('label[for="new-name"]')!, input=el.querySelector('#new-name')!;
      const distance=input.getBoundingClientRect().top-label.getBoundingClientRect().bottom;
      return distance >= 0 && distance <= 12 && !!el.querySelector('.settings-panel');
    }), 'shared utility form places the input directly below its label');
    const name=sample.getByLabel('渠道名称',{exact:true}); const before=(await name.boundingBox())!.y;
    await sample.getByRole('button',{name:'保存并连接',exact:true}).click();
    assert.equal((await name.boundingBox())!.y, before, 'reserved validation keeps field position stable');
    await name.fill('界面验收');
    await sample.getByLabel('平台',{exact:true}).selectOption('slack');
    assert.equal(await name.inputValue(),'界面验收');
    await sample.screenshot({path:join(evidence,`${theme}-${width}-slack.png`)});
    await sample.getByLabel('平台',{exact:true}).selectOption('wecom');
    await sample.screenshot({path:join(evidence,`${theme}-${width}-add.png`)});
    await sample.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    assert.equal(await add.evaluate((el:Element)=>el===document.activeElement),true,'Escape restores opener focus');
    await sample.close();
  }
  seedChannel();
  await page.reload();
  await page.getByRole('button', { name: '管理', exact: true }).waitFor();
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole('button', {name:'交给管家 进入指定会话，由 Agent 继续分派'}).click();
  for (const [width,theme] of [[1280,'light'],[390,'dark']] as const) {
    await page.setViewportSize({width,height:1000});await page.evaluate((theme:string)=>(window as any).proof.theme(theme),theme);
    await page.getByRole('button',{name:'选择已有会话…',exact:true}).click();
    const chooser=page.getByRole('dialog');await chooser.waitFor();
    for(const engine of ['Codex','Pi','DSH']) assert.equal(await chooser.getByText(engine,{exact:true}).count(),1);
    await page.screenshot({path:join(evidence,`engine-picker-${theme}-${width}.png`)});
    const row=chooser.locator('.settings-control-list-item').filter({hasText:'Pi conversation'});
    await row.getByRole('button',{name:'选择',exact:true}).click();
    await chooser.waitFor({state:'hidden'});
  }
  await page.setViewportSize({width:1280,height:1000});
  await page.getByRole('button',{name:'按来源分会话 私聊、群成员各自继续；话题共享'}).click();
  await page.getByRole("button", { name: "运行预览", exact: true }).click();
  await page.getByText("预览结果", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "自定义函数 按群、发送人或消息内容决定" })
    .click();
  await page
    .getByLabel("路由函数", { exact: true })
    .fill('function route(event) { return { key: ["team", event.chat.id] }; }');
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".im-hint") !== null);
  await page.getByRole("button", { name: "启用更改", exact: true }).click();
  await page.getByRole("button", { name: "启用新版本", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.match(service.store.channel("fixture-channel")!.route!, /"team"/);
  await page.getByRole("tab", { name: "连接配置", exact: true }).click();
  await page.getByLabel("渠道名称", { exact: true }).fill("工程助手改名");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await page
    .getByRole("heading", { name: "工程助手改名", exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "使用者", exact: true }).click();
  await page.getByRole("button", { name: "关联我的身份", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.match(
    await page.locator(".im-reference").innerText(),
    /^\/identify [a-f0-9]{32}$/,
  );
  await page.getByRole("button", { name: "完成后刷新" }).click();
  await page.getByRole("tab", { name: "消息路由", exact: true }).click();
  for (const theme of ["light", "dark"])
    for (const width of [1280, 390, 320]) {
      await page.evaluate((t: string) => (window as any).proof.theme(t), theme);
      await page.setViewportSize({ width, height: 1000 });
      const toggle = page
        .locator('[data-chrome-action-id="sidebar-toggle"]:visible')
        .first();
      if (
        ((await toggle.getAttribute("aria-expanded")) === "true") !==
        width > 600
      )
        await toggle.press("Enter");
      if (width <= 600) await page.keyboard.press("Escape");
      await page.mouse.click(width - 5, 100);
      await page.waitForTimeout(400);
      const box = await page.locator(".im-settings").boundingBox();
      console.log("layout", theme, width, box);
      if (width === 320)
        console.log(
          "ancestors",
          await page.locator(".im-settings").evaluate((el) => {
            const rows = [];
            for (let e: Element | null = el; e; e = e.parentElement)
              rows.push([
                e.className,
                e.getBoundingClientRect().width,
                getComputedStyle(e).minWidth,
              ]);
            return rows;
          }),
        );
      await page.screenshot({
        path: join(evidence, theme + "-" + width + ".png"),
        fullPage: true,
      });
      assert.ok(
        box && box.x >= 0 && box.x + box.width <= width + 1,
        "IM controls stay within the actual Settings viewport",
      );
      await page.screenshot({
        path: join(evidence, theme + "-" + width + ".png"),
        fullPage: true,
      });
    }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page
    .getByLabel("路由函数", { exact: true })
    .fill("function route(){ return {ignore:true}; }");
  await page.evaluate(() => (window as any).proof.away());
  await page.evaluate(() => (window as any).proof.open());
  await page.getByRole("button", { name: "管理", exact: true }).click();
  assert.match(
    await page.getByLabel("路由函数", { exact: true }).inputValue(),
    /ignore:true/,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, "browser.json"),
    JSON.stringify(
      {
        errors,
        channel: service.store.channel("fixture-channel"),
        matrix: ["light", "dark"].flatMap((theme) =>
          [1280, 390, 320].map((width) => ({ theme, width })),
        ),
        scope:
          "actual Settings + API + SQLite + QuickJS; external platform/admission synthetic",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real IM Settings, isolated preview, CAS draft/publish, connection update, identity proof, route-away draft preservation and light/dark responsive DOM.",
  );
} finally {
  await browser?.close();
  await server.close();
  await service.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
