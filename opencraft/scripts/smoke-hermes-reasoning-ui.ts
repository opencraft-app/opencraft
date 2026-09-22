import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const output = await mkdtemp("/tmp/opencraft-hermes-reasoning-ui-");
const source = `
import React from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {CodexComposer} from '@opencraft/codex-composer';
import {createComposerController} from '@opencraft/composer-core';
import {projectComposerModelChoices} from '@opencraft/workbench-runtime';
import {mapHermesModelOptions} from '/plugins/lightvela-hermes/src/hermes-appserver-bridge/model-catalog.ts';
import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
import '/apps/workbench-web/src/styles/app.scss';

const controller=createComposerController(
  {type:'existing-thread',key:{hostId:'hermes',threadId:'thread'}},
  {now:Date.now,createId:()=>crypto.randomUUID()},
);
const hermesModels=projectComposerModelChoices(mapHermesModelOptions({
  model:'glm-5.3-flash',
  provider:'tokenhub',
  providers:[{
    slug:'tokenhub',
    name:'TokenHub',
    authenticated:true,
    models:['glm-5.3-flash'],
    capabilities:{'glm-5.3-flash':{reasoning:true,can_disable_reasoning:false}},
  }],
}));
const models=[
  ...hermesModels,
  {
    id:'plain',
    value:'plain',
    label:'Custom Vision',
    description:'No configurable reasoning',
    isDefault:false,
    inputModalities:['text','image'],
    contextWindow:128000,
    maxTokens:16384,
    source:'custom',
    defaultEffort:null,
    efforts:[],
  },
];
initializeAppearanceTheme();
setThemePreference('light');
window.fixture={controller,theme:setThemePreference};
createRoot(document.getElementById('root')).render(
  <div style={{width:'min(720px, calc(100vw - 32px))',margin:'80px auto'}}>
    <CodexComposer
      controller={controller}
      selectionCatalog={{models,permissionProfiles:[]}}
      onSubmit={async()=>{}}
      onCancel={()=>{}}
    />
  </div>,
);`;

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: "node_modules/.vite-hermes-reasoning-ui",
  resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "hermes-reasoning-fixture",
      resolveId: (id) => (id === "/probe.tsx" ? id : null),
      load: (id) => (id === "/probe.tsx" ? source : null),
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/favicon.ico") {
            response.statusCode = 204;
            response.end();
            return;
          }
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<div id="root"></div><script type="module" src="/probe.tsx"></script>',
          );
        });
      },
    },
  ],
});

await vite.listen();
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
});

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript("window.__name=value=>value");
  await page.goto(vite.resolvedUrls!.local[0]!, { timeout: 60_000 });

  const trigger = page.locator(".codex-composer-mode--intelligence");
  try {
    await trigger.waitFor({ timeout: 30_000 });
  } catch (error) {
    throw new Error(
      `Composer did not mount: ${await page.locator("body").innerText()} | ${errors.join(" | ")}`,
      { cause: error },
    );
  }

  await trigger.click();
  const menu = page.locator(
    '.codex-composer-selection-menu--intelligence[role="menu"]',
  );
  await menu.waitFor();
  assert.equal(
    await menu.locator(".codex-composer-intelligence-models").count(),
    1,
  );
  assert.equal(
    await menu.locator(".codex-composer-intelligence-reasoning").count(),
    1,
  );
  assert.deepEqual(
    await menu.getByRole("menuitemradio").evaluateAll(items => items.map(item => item.getAttribute("aria-label"))),
    ["Light", "High", "Max"],
  );
  assert.equal(await menu.locator(".codex-composer-reasoning-track").count(), 1);
  assert.equal(await menu.locator(".codex-composer-reasoning-value").innerText(), "High");
  const track = await menu.locator(".codex-composer-reasoning-track").boundingBox();
  const fill = await menu.locator(".codex-composer-reasoning-track__fill").boundingBox();
  assert.ok(track && fill && fill.width / track.width > 0.45 && fill.width / track.width < 0.55);
  const modelRow = menu.getByRole("menuitem", { name: "glm-5.3-flash", exact: true });
  await modelRow.hover();
  assert.equal(await modelRow.evaluate(element => getComputedStyle(element).outlineStyle), "none");
  const maxEffort = menu.getByRole("menuitemradio", { name: "Max" });
  await maxEffort.hover();
  assert.equal(await maxEffort.evaluate(element => getComputedStyle(element).outlineStyle), "none");
  assert.doesNotMatch(
    await menu.innerText(),
    /None|Minimal|Medium|Extra High|Ultra/u,
  );
  assert.doesNotMatch(
    await menu.innerText(),
    /Hermes via TokenHub|No configurable reasoning|More thorough reasoning/u,
  );
  const wideModels = await menu.locator(".codex-composer-intelligence-models").boundingBox();
  const wideDetail = await menu.locator(".codex-composer-intelligence-detail").boundingBox();
  assert.ok(wideModels && wideDetail && wideModels.x + wideModels.width <= wideDetail.x);

  await menu.getByText("Custom Vision", { exact: true }).click();
  await menu.waitFor();
  assert.equal(
    await page.evaluate(
      () => (window as any).fixture.controller.getSnapshot().draft.selections.model,
    ),
    "plain",
  );
  assert.equal(
    await menu.locator(".codex-composer-intelligence-reasoning").count(),
    0,
  );
  const customDetail = await menu.locator(".codex-composer-intelligence-detail").innerText();
  assert.match(customDetail, /Custom Vision/u);
  assert.match(customDetail, /Custom/u);
  assert.match(customDetail, /128K/u);
  assert.match(customDetail, /16\.4K/u);
  assert.match(customDetail, /Text/u);
  assert.match(customDetail, /Image/u);
  await menu.screenshot({ path: join(output, "model-capability-menu-custom.png") });

  await menu.getByText("glm-5.3-flash", { exact: true }).click();
  await menu.waitFor();
  assert.equal(
    await menu.locator(".codex-composer-intelligence-reasoning").count(),
    1,
  );
  assert.equal(
    await page.evaluate(
      () => (window as any).fixture.controller.getSnapshot().draft.selections.effort,
    ),
    "high",
  );

  await menu.screenshot({ path: join(output, "model-reasoning-menu-wide.png") });
  await page.setViewportSize({ width: 420, height: 650 });
  const narrowModels = await menu.locator(".codex-composer-intelligence-models").boundingBox();
  const narrowDetail = await menu.locator(".codex-composer-intelligence-detail").boundingBox();
  assert.ok(narrowModels && narrowDetail && narrowModels.y + narrowModels.height <= narrowDetail.y + 1);
  await menu.screenshot({ path: join(output, "model-reasoning-menu-narrow.png") });
  await page.evaluate(() => (window as any).fixture.theme("dark"));
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    "dark",
  );
  await menu.screenshot({ path: join(output, "model-reasoning-menu-dark.png") });

  await maxEffort.focus();
  assert.equal(await maxEffort.evaluate(element => document.activeElement === element), true);
  assert.notEqual(await maxEffort.evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(
      () => (window as any).fixture.controller.getSnapshot().draft.selections.effort,
    ),
    "max",
  );
  assert.equal(
    await page.locator(".codex-composer-editor.ProseMirror").evaluate(
      (editor) => document.activeElement === editor,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, effort: "max", evidence: output }));
} finally {
  await browser.close();
  await vite.close();
}
