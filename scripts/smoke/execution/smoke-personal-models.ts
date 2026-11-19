import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { ModelGatewayStore, modelGatewayHttp } from "../../../packages/account-pool-host/src/index";
import { gatewayContributions } from "../../../apps/local-agent-host/src/model-config/gateway-contributions";
import { ModelConfigurationRepository } from "../../../apps/local-agent-host/src/model-config/repository";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const root = process.cwd(),
  scratch = await mkdtemp(join(tmpdir(), "personal-model-ui-"));
const out = process.env.OPENCRAFT_SMOKE_OUTPUT ?? join(scratch, "evidence");
await mkdir(out, { recursive: true });
const path = join(scratch, "gateway.sqlite"),
  models = join(scratch, "models"),
  ledger = new ModelGatewayStore(path);
ledger.configure("alice", { monthlyTokens: 2_000_000, requestTokens: 1000, concurrency: 4 }, 0, "admin");
const repository = new ModelConfigurationRepository(models);
await repository.initialize({
  schemaVersion: 1,
  revision: 0,
  providers: [
    {
      id: "approved",
      name: "编程模型服务",
      protocol: "openai-responses",
      baseUrl: "https://model.invalid/v1",
      credentialRef: null,
      enabled: false,
      models: [{ id: "coding-model", name: "编程模型", enabled: true }],
    },
  ],
  defaultModel: null,
});
const contributions = gatewayContributions(models, path);
let origin = "",
  identity = "alice",
  failSave = false;
const http = modelGatewayHttp({
  path,
  ...contributions,
  subscription: async (actor, input, assertCurrent) => {
    if (input.operation === "start")
      return {
        status: "pending",
        login: {
          sessionId: "fixture-login",
          verificationUrl: "https://auth.example.test/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 60000,
        },
      };
    if (input.operation === "cancel") return { cancelled: true };
    const hash = createHash("sha256").update(actor).digest("hex");
    return {
      status: "complete",
      ...(await contributions.connectSubscription(
        actor,
        {
          providerId: "subscription-" + hash,
          baseUrl: "http://127.0.0.1:12345/personal/" + hash + "/v1",
          proxyToken: "x".repeat(43),
          models: [{ id: "subscription-fixture", name: "订阅模型", enabled: true }],
        },
        assertCurrent,
      )),
    };
  },
  authority: () => ({ actor: identity, administrator: false, origin }),
});
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {IntlProvider} from 'react-intl';
import messages from '/apps/workbench-web/src/i18n/locales/zh-CN.json';
import '/apps/workbench-web/src/styles/settings-page.scss';import '/apps/workbench-web/src/styles/app.scss';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import {SettingsNavigation} from '/apps/workbench-web/src/components/settings-page.tsx';
import {createPersonalModelServicesView} from '/plugins/builtin-agents/src/model-services/personal.tsx';
initializeAppearanceTheme();setThemePreference('light');window.setTheme=setThemePreference;
const View=createPersonalModelServicesView();
const snapshot={settingsPages:[{extensionId:'personal-models',contribution:{id:'models',title:'模型服务',viewId:'models',group:'Server',icon:'brain'}}]};const store={getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
function App(){return <IntlProvider locale="zh-CN" messages={messages}><div className="personal-smoke-shell"><nav className="personal-smoke-navigation"><SettingsNavigation section="models" onSectionChange={()=>{}} extensionContributions={store} profiles={[]} machines={[]} onBack={()=>{}}/></nav><View/></div></IntlProvider>};createRoot(document.getElementById('root')).render(<App/>);`;
let vite: any, browser: any;
const errors: string[] = [];
try {
  vite = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "personal-model-smoke",
        resolveId(id) {
          if (id === "/personal-smoke.tsx") return id;
        },
        load(id) {
          if (id === "/personal-smoke.tsx") return entry;
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.startsWith("/__opencraft_model_gateway")) {
              if (failSave && request.method === "POST") {
                response.writeHead(409, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "gateway_revision_conflict" }));
                return;
              }
              void http(request, response);
              return;
            }
            if (request.url?.split("?")[0] !== "/settings/models") return next();
            response.setHeader("content-type", "text/html");
            response.end(
              '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}.personal-smoke-shell{height:100%;display:grid;grid-template-columns:210px minmax(0,1fr)}.personal-smoke-navigation{border-right:1px solid var(--color-border-subtle);overflow:auto}@media(max-width:650px){.personal-smoke-shell{grid-template-columns:minmax(0,1fr)}.personal-smoke-navigation{display:none}}</style><div id="root"></div><script type="module" src="/personal-smoke.tsx"></script></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  origin = "http://127.0.0.1:" + vite.httpServer.address().port;
  browser = await chromium.launch({
    ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(origin + "/settings/models");
  await page.getByRole("heading", { name: "编程模型服务", exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "添加我的连接", exact: true }).first().click();
  await page.getByLabel("名称", { exact: true }).fill("我的编程模型");
  await page.getByLabel("API key", { exact: true }).fill("synthetic-personal-key");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("heading", { name: "我的编程模型", exact: true }).waitFor();
  assert.equal(ledger.contributions("alice").length, 1);
  assert.equal(ledger.contributions("alice")[0]!.scope, "personal");
  await page.screenshot({ path: join(out, "desktop.png"), fullPage: true });
  const change = page.getByRole("button", { name: "更改", exact: true }).first();
  await change.click();
  await page.getByLabel("使用范围", { exact: true }).selectOption("team");
  assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(ledger.contributions("alice")[0]!.scope, "personal");
  await change.click();
  await page.getByLabel("使用范围", { exact: true }).selectOption("team");
  await page.getByRole("switch", { name: "允许其他人使用", exact: true }).click();
  failSave = true;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("设置已在其他位置修改。请刷新后重试，当前输入已保留。", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("使用范围", { exact: true }).inputValue(), "team");
  failSave = false;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("此平台的用户", { exact: true }).waitFor();
  assert.equal(ledger.contributions("alice")[0]!.scope, "team");
  await change.click();
  await page.getByLabel("使用范围", { exact: true }).selectOption("personal");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("你和帮你办事的助手可以用，别人的任务不能用。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "更改", exact: true }).last().click();
  await page.getByLabel("每月最多使用", { exact: true }).fill("500000");
  await page.getByRole("button", { name: "保存限制", exact: true }).click();
  await page.getByText("500,000 tokens / 月", { exact: true }).waitFor();
  assert.equal(ledger.personalLimit("alice").monthlyTokens, 500000);
  await page.evaluate(() => (window as any).setTheme("dark"));
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "更改");
    return button && Number(getComputedStyle(button).color.match(/[0-9.]+/g)?.[0]) > 140;
  });
  await page.screenshot({ path: join(out, "dark.png"), fullPage: true });
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await touch.newPage();
  mobile.on("pageerror", (e: Error) => errors.push(e.message));
  await mobile.goto(origin + "/settings/models");
  await mobile.getByRole("heading", { name: "我的编程模型", exact: true }).waitFor();
  await mobile.getByRole("button", { name: "更改", exact: true }).first().tap();
  await mobile.getByLabel("使用范围", { exact: true }).selectOption("team");
  await mobile.getByRole("switch", { name: "允许其他人使用", exact: true }).tap();
  await mobile.setViewportSize({ width: 430, height: 844 });
  assert.equal(await mobile.getByLabel("使用范围", { exact: true }).inputValue(), "team");
  await mobile.screenshot({ path: join(out, "touch-scope.png"), fullPage: true });
  await mobile.keyboard.press("Escape");
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: join(out, "touch.png"), fullPage: true });
  await page.getByRole("button", { name: "添加我的连接", exact: true }).first().click();
  await page.getByLabel("连接方式", { exact: true }).selectOption("subscription");
  await page.getByRole("button", { name: "登录并连接", exact: true }).click();
  await page.getByText("ABCD-1234", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "我的 Codex 订阅", exact: true }).waitFor();
  assert.equal(
    ledger.contribution("subscription-" + createHash("sha256").update("alice").digest("hex"))?.scope,
    "personal",
  );
  assert.equal(await page.getByRole("button", { name: "更改", exact: true }).count(), 1);
  await page.screenshot({ path: join(out, "subscription.png"), fullPage: true });
  identity = "bob";
  await mobile.reload();
  await mobile.getByRole("heading", { name: "编程模型服务", exact: true }).waitFor();
  assert.equal(await mobile.getByText("我的编程模型", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, "verification.json"),
    JSON.stringify(
      {
        realComponents: true,
        realHttpAndPersistence: true,
        identity: "synthetic",
        inference: false,
        desktop: true,
        touchEmulated: true,
        physicalDevice: false,
        productionShell: false,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Personal model settings: HTTP persistence, owner isolation, consent, cancel, error recovery, limits, dark theme and touch passed.",
  );
} finally {
  await browser?.close();
  await vite?.close();
  ledger.close();
  await rm(scratch, { recursive: true, force: true });
}
