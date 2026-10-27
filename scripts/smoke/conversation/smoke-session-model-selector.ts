import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compile, Logger } from "sass";

const root = resolve(import.meta.dirname, "../../..");
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { buildOpenCraftThemeCssProperties, opencraftNeutralThemePalette, frostThemePalette } from "./packages/design-system/src/theme-engine";
window.__setTheme = (mode, frost = false) => { document.documentElement.dataset.theme = mode; for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties(mode, (frost ? frostThemePalette : opencraftNeutralThemePalette)[mode]))) document.documentElement.style.setProperty(key, value); };
import { embeddedLocaleCatalogs } from "./apps/workbench-web/src/i18n/catalogs";
const locale = new LocaleRuntime(embeddedLocaleCatalogs);
await locale.update({ localeOverride: "en-US" });
window.__setLocale = (value) => locale.update({ localeOverride: value });
let sequence = 0;
const controller = createComposerController({ type: "new-thread", draftId: "draft", execution: {
  hostId: "fixture", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
}}, { now: Date.now, createId: () => String(++sequence) });
window.__sent = [];
window.__resetDraft = () => controller.dispatch({ type: "reset-all" });
const model = (id, label, isDefault, configuredRole = null) => ({ id, value: id, label, isDefault, configuredRole,
  description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] });
function Fixture() {
  const [policy, setPolicy] = React.useState("session");
  window.__setPolicy = setPolicy;
  const [catalog, setCatalog] = React.useState({ agents: [], permissionProfiles: [], models: [
    model("default-model", "Default model", true, "primary"),
    model("custom-model", "Custom model", false, "fallback"),
    model("idle-model", "Idle model", false),
  ] });
  window.__setCatalog = setCatalog;
  return <IntlRuntimeProvider runtime={locale}>
    <OpenCraftComposer controller={controller} modelSelectionPolicy={policy} selectionCatalog={catalog}
      onSubmit={(intent) => {
        window.__sent.push({ selected: Object.hasOwn(intent.selections, "model"), model: intent.selections.model });
        return false;
      }} onCancel={() => {}} />
  </IntlRuntimeProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;
const bundle = await build({
  stdin: { contents: fixture, resolveDir: root, sourcefile: "embedded-model-selector.tsx", loader: "tsx" },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  loader: { ".css": "empty", ".scss": "empty" },
});
const css = compile(resolve(root, "apps/workbench-web/src/styles/app.scss"), {
  logger: Logger.silent,
  importers: [{ findFileUrl(url: string) {
    const roots = {
      "@opencraft/design-system/": "packages/design-system/src/",
      "@opencraft/design-system-web/": "packages/design-system-web/src/",
      "@opencraft/plugin-cloud-desktop/": "plugins/cloud-desktop/src/",
    };
    for (const [prefix, path] of Object.entries(roots)) {
      if (url.startsWith(prefix)) return pathToFileURL(resolve(root, path, `${url.slice(prefix.length)}.scss`));
    }
    return null;
  } }],
}).css;
assert.ok(css.includes(".opencraft-composer-mode"), "Composer stylesheet is required for the browser smoke");
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(bundle.outputFiles[0]!.contents);
  } else if (request.url === "/fixture.css") {
    response.setHeader("content-type", "text/css");
    response.end(css);
  } else {
    response.setHeader("content-type", "text/html");
    response.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root" style="width:min(760px,calc(100vw - 32px));margin:460px auto 0"></div><script type="module" src="/fixture.js"></script></body></html>');
  }
});
await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({
  executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  headless: true,
});
try {
  await mkdir(resolve(root, ".local/session-model-selector"), { recursive: true });
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, isMobile: touch, hasTouch: touch });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.addInitScript("window.__name = value => value");
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.evaluate(theme => (window as unknown as { __setTheme: (theme: string) => void }).__setTheme(theme), theme);
  const editor = page.locator(".ProseMirror");
  const send = () => page.locator(".opencraft-composer-submit").click();
  await editor.fill("Use the default");
  await send();
  await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 1);
  const picker = page.locator(".opencraft-composer-mode--intelligence");
  await picker.click();
  assert.equal(await page.locator('.opencraft-composer-model-role[data-role="primary"]').count(), 0);
  assert.equal(await page.locator('.opencraft-composer-model-role[data-role="fallback"]').innerText(), "Backup");
  assert.equal(await page.locator('.opencraft-composer-model-current').count(), 0);
  assert.equal(await page.getByRole("menuitem", { name: "Idle model" }).locator(".opencraft-composer-model-role").count(), 0);
  await page.evaluate('window.__setLocale("zh-CN")');
  assert.equal(await page.locator('.opencraft-composer-model-role[data-role="fallback"]').innerText(), "备用");
  if (process.env.OPENCRAFT_MODEL_SELECTOR_SCREENSHOT) {
    await page.screenshot({ path: process.env.OPENCRAFT_MODEL_SELECTOR_SCREENSHOT });
  }
  await page.getByRole("menuitem", { name: /Custom model/u }).click();
  await page.getByRole("menuitem", { name: /Custom model/u }).waitFor({ state: "hidden" });
  await picker.click();
  await page.getByRole("menuitem", { name: /Custom model/u }).waitFor();
  assert.equal(await page.getByRole("menuitem", { name: /Custom model/u }).locator('.opencraft-composer-model-role[data-role="fallback"]').count(), 1);
  assert.equal(await page.getByRole("menuitem", { name: /Custom model/u }).getAttribute("data-selected"), "true");
  assert.equal(await page.getByRole("menuitem", { name: /Default model/u }).locator('.opencraft-composer-model-role').count(), 0);
  await page.keyboard.press("Escape");
  await editor.fill("Use the custom model");
  await send();
  await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 2);
  const sent = await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent);
  assert.deepEqual(sent, [{ selected: false, model: undefined }, { selected: true, model: "custom-model" }]);
  await page.evaluate('window.__setLocale("en-US")');
  await page.evaluate('window.__setCatalog({ agents: [], permissionProfiles: [], models: [], modelError: "private backend failure", retryModels: () => { window.__retried = true; } })');
  await picker.click();
  await page.getByText("Couldn't load models. Try again.").waitFor();
  await page.getByRole("menuitem", { name: "Retry" }).click();
  assert.equal(await page.evaluate(() => (window as unknown as { __retried: boolean }).__retried), true);
  await page.evaluate('window.__setCatalog({ agents: [], permissionProfiles: [], models: [] })');
  if (await picker.getAttribute("aria-expanded") !== "true") await picker.click();
  await page.getByText("No models available. Check Model Settings.").waitFor();
  await page.evaluate('window.__setLocale("zh-CN")');
  await page.getByText("没有可用模型，请检查模型配置。").waitFor();
  await page.evaluate('window.__setLocale("es")');
  await page.getByText("No hay modelos disponibles. Revisa la configuración de modelos.").waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate('window.__resetDraft()');
  await editor.fill("Use the Host default without a catalog");
  await send();
  await page.waitForFunction(() => (window as unknown as { __sent: unknown[] }).__sent.length === 3);
  assert.deepEqual((await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent))[2],
    { selected: false, model: undefined });
  await page.keyboard.press("Escape");
  await page.locator(".opencraft-composer-selection-menu").waitFor({ state: "hidden" });
  await page.evaluate('window.__setLocale("en-US")');
  const longName = "A configured model with a very long display name for truncation";
  await page.evaluate(label => (window as unknown as { __setCatalog: (catalog: unknown) => void }).__setCatalog({
    agents: [], permissionProfiles: [], models: [{ id: "long-model", value: "long-model", label,
      groupKey: "configured", groupLabel: "Configured models", isDefault: true, efforts: [], defaultEffort: null,
      configuredRole: "fallback", inputModalities: ["text"] }],
    onConfigureModels: () => { (window as unknown as { __configured: boolean }).__configured = true; },
  }), longName);
  await picker.click();
  await page.getByText("Configured models", { exact: true }).waitFor();
  await page.getByRole("menuitem", { name: new RegExp(longName) }).click();
  await page.locator(".opencraft-composer-selection-menu").waitFor({ state: "hidden" });
  assert.equal(await picker.innerText(), longName);
  await picker.click();
  await page.getByRole("menuitem", { name: "Add more models" }).waitFor();
  const geometry = await page.locator(".opencraft-composer-selection-menu").boundingBox();
  assert.ok(geometry && geometry.x >= 0 && geometry.x + geometry.width <= (touch ? 390 : 1280), "menu stays in viewport");
  const labelStyle = await page.locator(".opencraft-composer-model-group__label").evaluate(element => getComputedStyle(element).fontWeight);
  assert.equal(labelStyle, "500", "group heading uses the section role");
  await page.screenshot({ path: resolve(root, `.local/session-model-selector/${touch ? "mobile" : "desktop"}-${theme}.png`) });
  await page.getByRole("menuitem", { name: "Add more models" }).click();
  assert.equal(await page.evaluate(() => (window as unknown as { __configured: boolean }).__configured), true);
  // The standalone picker must preserve engine identity even for identical labels.
  await page.evaluate(`window.__resetDraft(); window.__setPolicy("user");
    const models = [
      { id: "dsh-model", value: "dsh-model", label: "Shared model", groupKey: "dsh", groupLabel: "DSH · Models", isDefault: true, efforts: [], defaultEffort: null },
      { id: "pi:provider:model", value: "pi:provider:model", label: "Shared model", groupKey: "pi:provider", groupLabel: "Pi · provider", efforts: [], defaultEffort: null }
    ];
    window.__setCatalog({ agents: [], permissionProfiles: [], models,
      agentGroups: [{ id: "server", label: "Server", active: true, models, select: model => { window.__selectedEngineModel = model.value; } }] });`);
  await editor.fill("Keep this engine selection draft");
  await picker.click();
  await page.getByRole("menuitem", { name: "Shared model", exact: true }).click();
  const standalone = page.locator(".opencraft-composer-selection-menu--model-select");
  await standalone.getByText("DSH · Models", { exact: true }).waitFor();
  await standalone.getByText("Pi · provider", { exact: true }).waitFor();
  assert.equal(await standalone.getByRole("menuitem", { name: "Shared model", exact: true }).count(), 2);
  await standalone.getByRole("menuitem", { name: "Shared model", exact: true }).nth(1).click();
  await page.waitForFunction(() => (window as unknown as { __selectedEngineModel: string }).__selectedEngineModel === "pi:provider:model");
  assert.equal(await editor.innerText(), "Keep this engine selection draft");
  const standaloneGeometry = await standalone.boundingBox();
  assert.ok(standaloneGeometry && standaloneGeometry.x >= 0 && standaloneGeometry.x + standaloneGeometry.width <= (touch ? 390 : 1280));
  await page.screenshot({ path: resolve(root, `.local/session-model-selector/standalone-${touch ? "mobile" : "desktop"}-${theme}.png`) });
  await page.keyboard.press("Escape");
  await standalone.waitFor({ state: "hidden" });

  // No catalog must open the useful list immediately, including empty Agent groups.
  await page.evaluate(`window.__resetDraft(); window.__setLocale("zh-CN");
    window.__retryCount = 0;
    window.__setCatalog({ permissionProfiles: [], models: [], agentGroups: [
      { id: "opencraft", label: "OpenCraft", active: true, models: [], select() {}, manage() { window.__addedModel = true; } },
      { id: "codex", label: "Codex", active: false, models: [], error: "spawn codex ENOENT /private/synthetic/path", select(model) { window.__selectedEngineModel = model.value; },
        retry() { window.__retryCount++; window.__setCatalog(current => ({ ...current, agentGroups: current.agentGroups.map(group => group.id === "codex" ? { ...group, error: null, loading: true } : group) })); } }
    ] });`);
  await editor.fill("保留尚未发送的草稿");
  await editor.evaluate(element => { (window as any).__originalEditor = element; });
  const composerBefore = await page.locator(".opencraft-composer-shell").boundingBox();
  const activate = async (locator: ReturnType<typeof page.locator>) => touch ? locator.tap() : locator.click();
  await activate(picker);
  await standalone.getByText("还没有可用模型", { exact: true }).waitFor();
  await standalone.getByText("暂时无法加载模型", { exact: true }).waitFor();
  assert.doesNotMatch(await standalone.innerText(), /ENOENT|private\/synthetic/u);
  assert.equal(await page.locator(".opencraft-composer-model-quick__title").count(), 0, "no empty intermediate depth panel");
  assert.deepEqual(await page.locator(".opencraft-composer-shell").boundingBox(), composerBefore);
  const settleMenu = () => standalone.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
  await settleMenu();
  const emptyGeometry = await standalone.boundingBox();
  assert.ok(emptyGeometry && emptyGeometry.x >= 0 && emptyGeometry.x + emptyGeometry.width <= (touch ? 390 : 1280));
  const add = standalone.getByRole("menuitem", { name: "添加模型…", exact: true });
  assert.ok(await add.isVisible(), "configuration remains reachable alongside the failed Agent");
  await page.screenshot({ path: resolve(root, `.local/session-model-selector/empty-${touch ? "mobile" : "desktop"}-${theme}.png`) });
  if (theme === "light") {
    await page.evaluate('window.__setTheme("light", true)');
    await settleMenu();
    await page.screenshot({ path: resolve(root, `.local/session-model-selector/empty-${touch ? "mobile" : "desktop"}-frost.png`) });
    await page.evaluate('window.__setTheme("light")');
  }
  const retry = standalone.getByRole("menuitem", { name: "重试", exact: true });
  await activate(retry);
  await standalone.getByText("正在加载模型…").waitFor();
  assert.equal(await retry.getAttribute("aria-disabled"), "true");
  assert.equal(await page.evaluate('window.__retryCount'), 1);
  await settleMenu();
  const pendingGeometry = await standalone.boundingBox();
  assert.ok(pendingGeometry && emptyGeometry && ["x", "y", "width", "height"].every(key =>
    Math.abs(pendingGeometry[key as keyof typeof pendingGeometry] - emptyGeometry[key as keyof typeof emptyGeometry]) <= 1), "held retry keeps the same menu geometry within subpixel/collision rounding");
  assert.equal(await editor.innerText(), "保留尚未发送的草稿");
  await page.evaluate(`window.__setCatalog(current => ({ ...current, agentGroups: current.agentGroups.map(group => group.id === "codex"
    ? { ...group, loading: false, error: null, models: [{ id: "recovered", value: "recovered", label: "Recovered model", efforts: [], defaultEffort: null }] } : group) }));`);
  await activate(standalone.getByRole("menuitem", { name: "Recovered model", exact: true }));
  await page.waitForFunction(() => (window as any).__selectedEngineModel === "recovered");
  // A language switch updates the open menu without replacing the input or draft.
  await page.evaluate('window.__setLocale("en-US")');
  await standalone.getByText("No models available yet", { exact: true }).waitFor();
  assert(await editor.evaluate(element => element === (window as any).__originalEditor));
  assert.equal(await editor.innerText(), "保留尚未发送的草稿");
  await page.keyboard.press("Escape");
  await standalone.waitFor({ state: "hidden" });
  await picker.focus();
  await page.keyboard.press("Enter");
  await standalone.waitFor();
  assert(await standalone.evaluate(element => element.contains(document.activeElement)), "keyboard entry focuses a real menu action");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.textContent?.includes("Add a model…"));
  await page.keyboard.press("Enter");
  await standalone.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate('window.__addedModel'), true);
  assert.equal(await editor.innerText(), "保留尚未发送的草稿");
  await page.evaluate('window.__setCatalog({ models: [], permissionProfiles: [], agentGroups: [] })');
  await activate(picker);
  assert.equal(await standalone.getByText("No models available yet", { exact: true }).count(), 1, "an empty group array retains the empty state");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(`PASS unconfigured models ${touch ? "touch" : "desktop"}/${theme}: direct entry, safe error, add action, held retry/recovery, keyboard/locale/draft continuity`);
  console.log(`PASS standalone engine groups ${touch ? "mobile" : "desktop"}/${theme}: duplicate labels retain engine headings and selected native ID, draft preserved`);
  console.log(`PASS session model selector ${touch ? "mobile" : "desktop"}/${theme}: inherited/explicit selection, backup, locales, retry/empty, groups/configure, viewport`);
  await context.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
}
