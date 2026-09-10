import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "vite";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";

// Real plugin UI -> authenticated WebSocket -> bundled DSH. The only simulated
// boundary is an isolated model endpoint. No live account or inference is used.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const dataDirectory = await mkdtemp(resolve(tmpdir(), "opencraft-provider-ui-"));
delete process.env.OPENCRAFT_DSH_URL;
delete process.env.OPENCRAFT_DSH_REPOSITORY;
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: any;
const probes: { path?: string; authorized: boolean }[] = [];
const endpoint = createHttpServer((request, response) => {
  probes.push({ path: request.url, authorized: request.headers.authorization === "Bearer synthetic-browser-key" });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: [{ id: "browser-test-model" }] }));
});
try {
  await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
  const endpointPort = (endpoint.address() as { port: number }).port;
  host = await startLocalAgentHost({ dataDirectory, dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") });
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { LocalAgentSettingsService } from '/plugins/builtin-agents/src/local-agent-settings-service.ts';
    import { createLocalAgentSettingsView } from '/plugins/builtin-agents/src/local-agent-settings-view.tsx';
    import '/apps/workbench-web/src/styles/app.scss';
    import { buildCodexThemeCssProperties } from '/packages/design-system/src/theme-engine.ts';
    for (const [key, value] of Object.entries(buildCodexThemeCssProperties('light'))) document.documentElement.style.setProperty(key, value);
    const socket = new WebSocket(${JSON.stringify(host.websocketUrl)});
    const ready = new Promise(resolve => socket.addEventListener('open', resolve, {once:true}));
    let id = 0;
    const pending = new Map();
    socket.onmessage = event => { const frame = JSON.parse(event.data); const handler = pending.get(frame.id); if (!handler) return; pending.delete(frame.id); frame.error ? handler.reject(new Error(frame.error.message)) : handler.resolve(frame.result); };
    window.smokeMethods = [];
    const request = async (_host, method, params) => { await ready; window.smokeMethods.push(method); return new Promise((resolve, reject) => { const next = ++id; pending.set(next, {resolve,reject}); socket.send(JSON.stringify({jsonrpc:'2.0',id:next,method,params})); }); };
    const service = new LocalAgentSettingsService(request);
    window.smokeRequest = (method, params) => request('local', method, params);
    window.smokeNavigation = () => service.panel.getSnapshot();
    const View = createLocalAgentSettingsView(service);
    const root = createRoot(document.getElementById('root'));
    let mount = 0;
    window.smokeRemount = () => root.render(<div className="settings-page__viewport" data-layout="master-detail"><div className="settings-page__content"><View key={++mount} /></div></div>);
    window.smokeRemount();
  `;
  vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "provider-ui-smoke", resolveId: (id) => id === "/provider-smoke.tsx" ? id : null,
      load: (id) => id === "/provider-smoke.tsx" ? entry : null,
      configureServer(server) { server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/provider-smoke.tsx"></script></body></html>');
      }); },
    }],
  });
  await vite.listen();
  const address = vite.httpServer!.address() as { port: number };
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("heading", { name: "DeepSeek", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Add provider", exact: true }).count(), 1);
  assert.equal(await page.locator(".provider-settings__savebar").count(), 0);
  await page.screenshot({ path: "/tmp/opencraft-provider-built-in.png", fullPage: true });
  // The panel, not the application viewport, owns the breakpoint.
  const seeded = await page.evaluate(() => (window as any).smokeNavigation());
  await page.locator('.adaptive-panel').evaluate((element: HTMLElement) => { element.style.width = '390px'; });
  await page.waitForFunction(() => document.querySelector('.adaptive-panel')?.getAttribute('data-presentation') === 'stack');
  assert.equal(await page.locator('[data-panel-page="providers"]').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => (window as any).smokeNavigation()), seeded);
  await page.locator('.adaptive-panel').evaluate((element: HTMLElement) => { element.style.removeProperty('width'); });
  await page.waitForFunction(() => document.querySelector('.adaptive-panel')?.getAttribute('data-presentation') === 'split');
  await page.setViewportSize({ width: 390, height: 700 });
  await page.waitForFunction(() => document.querySelector('.adaptive-panel')?.getAttribute('data-presentation') === 'stack');
  assert.equal(await page.locator('[data-panel-page="providers"]').isVisible(), true);
  assert.equal(await page.locator('[data-panel-page^="provider:"]').isVisible(), false);
  assert.equal((await page.evaluate(() => (window as any).smokeNavigation())).active, 'primary');
  const previewPage = await page.locator('[data-panel-page^="provider:"]').elementHandle();
  await page.getByRole('textbox', { name: 'Search providers', exact: true }).fill('Deep');
  await page.locator('.provider-settings__connection').first().click();
  await page.getByRole('button', { name: 'Model services', exact: true }).waitFor();
  const detailRoute = (await page.evaluate(() => (window as any).smokeNavigation())).secondaryId;
  assert.equal(await previewPage.getAttribute('data-panel-page'), detailRoute);
  assert.equal(await previewPage.evaluate((element: HTMLElement) => element.isConnected), true, 'preview and entered detail are the same page');
  await page.getByRole('button', { name: 'Model services', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Search providers', exact: true }).inputValue(), 'Deep', 'list page owns its search state');
  await page.getByRole('textbox', { name: 'Search providers', exact: true }).fill('');
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
  const disabledCreate = page.getByRole("button", { name: "Create connection", exact: true });
  assert.equal(await disabledCreate.isDisabled(), true);
  assert.equal(await disabledCreate.evaluate((element: HTMLElement) => {
    const style = getComputedStyle(element);
    return style.color !== style.backgroundColor && style.opacity === "1";
  }), true);
  await page.getByLabel("Display name", { exact: true }).fill("Browser Test Gateway");
  await page.getByRole("button", { name: "Create connection", exact: true }).click();
  await page.getByRole("heading", { name: "Browser Test Gateway", exact: true }).waitFor();
  assert.equal(await page.getByRole("switch", { name: "Enable provider", exact: true }).getAttribute("aria-checked"), "false");
  await page.getByLabel("API protocol", { exact: true }).selectOption("openai-responses");
  await page.getByLabel("Base URL", { exact: true }).fill(`http://127.0.0.1:${endpointPort}/deployment/v1`);
  await page.getByRole("button", { name: "Add API key", exact: true }).click();
  await page.getByLabel("New API key", { exact: true }).fill("synthetic-browser-key");
  await page.getByRole("button", { name: "Manage models", exact: true }).click();
  await page.getByRole("button", { name: "Discover endpoint models", exact: true }).click();
  await page.getByRole("button", { name: "Add to draft", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("Provider saved. Inference has not been verified.", { exact: true }).waitFor();
  assert.equal(await page.locator(".provider-settings__savebar").count(), 0);
  assert.equal(await page.getByLabel("API protocol", { exact: true }).inputValue(), "openai-responses");
  await page.getByLabel("Enable provider", { exact: true }).click();
  await page.getByText("Provider enabled.", { exact: true }).waitFor();
  await page.getByRole("switch", { name: "Enable browser-test-model", exact: true }).click();
  await page.getByText("Model disabled. Existing conversations are unchanged.", { exact: true }).waitFor();
  const selectable = await page.evaluate(() => (window as any).smokeRequest('runtime/models/list', {}));
  assert.equal(selectable.groups.some((group: any) => group.models.some((model: any) => model.id === 'browser-test-model')), false);
  await page.getByRole("button", { name: "Refresh providers", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Enable browser-test-model"]')?.getAttribute('aria-checked') === 'false');
  await page.getByRole("switch", { name: "Enable browser-test-model", exact: true }).click();
  await page.getByText("Model enabled.", { exact: true }).waitFor();
  await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:1/draft");
  const pathBefore = await page.evaluate(() => (window as any).smokeNavigation());
  const field = await page.getByLabel("Base URL", { exact: true }).elementHandle();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.waitForFunction(() => document.querySelector('.adaptive-panel')?.getAttribute('data-presentation') === 'stack');
  assert.equal(await page.locator('[data-panel-page="providers"]').isVisible(), false);
  assert.equal(await page.locator('[data-panel-page^="provider:"]').isVisible(), true);
  assert.equal(await field.evaluate((element: HTMLElement) => element.isConnected), true);
  assert.equal(await page.getByLabel("Base URL", { exact: true }).inputValue(), "http://127.0.0.1:1/draft");
  assert.deepEqual(await page.evaluate(() => (window as any).smokeNavigation()), pathBefore);
  const detailPane = page.locator('[data-panel-page^="provider:"]');
  await detailPane.evaluate((element: HTMLElement) => { element.scrollTop = 120; });
  const scrollBefore = await detailPane.evaluate((element: HTMLElement) => element.scrollTop);
  await page.getByRole('button', { name: 'Model services', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  assert.deepEqual(await page.evaluate(() => (window as any).smokeNavigation()), { ...pathBefore, active: 'primary' });
  assert.equal(await field.evaluate((element: HTMLElement) => element.isConnected), true, 'Back retains the dirty detail page');
  await page.locator('.provider-settings__connection[aria-pressed="true"]').click();
  assert.equal(await detailPane.evaluate((element: HTMLElement) => element.scrollTop), scrollBefore, 'Back/reopen retains detail scroll');
  assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), 'http://127.0.0.1:1/draft');
  assert.deepEqual(await page.evaluate(() => (window as any).smokeNavigation()), pathBefore);
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.evaluate(() => (window as any).smokeRemount());
  await page.waitForFunction(() => (document.querySelector('#provider-base-url') as HTMLInputElement | null)?.value === 'http://127.0.0.1:1/draft'
    || [...document.querySelectorAll('input')].some(input => input.value === 'http://127.0.0.1:1/draft'));
  assert.deepEqual(await page.evaluate(() => (window as any).smokeNavigation()), pathBefore);
  await page.getByRole("button", { name: "Refresh providers", exact: true }).click();
  await page.getByRole("button", { name: "Refresh providers", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Base URL", { exact: true }).inputValue(), "http://127.0.0.1:1/draft");
  assert.equal(await page.locator(".provider-settings__savebar").count(), 1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.locator(".provider-settings__savebar").count(), 0);
  const methods = await page.evaluate(() => (window as any).smokeMethods as string[]);
  assert.ok(methods.includes("runtime/providers/apply"));
  assert.equal(methods.includes("runtime/credentials/set"), false);
  assert.deepEqual(probes, [{ path: "/deployment/v1/models", authorized: true }]);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/opencraft-local-agent-provider-smoke.png", fullPage: true });
  await page.setViewportSize({ width: 760, height: 420 });
  await page.locator('[data-panel-page^="provider:"]').evaluate((element: HTMLElement) => { element.scrollTop = element.scrollHeight; });
  const geometry = await page.locator('[data-panel-page^="provider:"]').evaluate((element: HTMLElement) => ({
    scrollable: element.scrollHeight > element.clientHeight,
    moved: element.scrollTop > 0,
    horizontalOverflow: element.scrollWidth > element.clientWidth,
  }));
  assert.deepEqual(geometry, { scrollable: true, moved: true, horizontalOverflow: false });
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.getByRole("switch", { name: "Enable provider", exact: true }).click();
  await page.getByText("Provider disabled. Configuration and credentials are retained.", { exact: true }).waitFor();
  page.once('dialog', (dialog: any) => dialog.accept());
  await page.getByRole("button", { name: "Delete browser-test-model", exact: true }).click();
  await page.getByText("Model configuration deleted.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh providers", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Enable browser-test-model"]'));
  const managed = await page.evaluate(() => (window as any).smokeRequest('runtime/models/list', {includeDisabled:true}));
  assert.equal(managed.groups.some((group: any) => group.models.some((model: any) => model.id === 'browser-test-model')), false);
  const protectedDefault = await page.evaluate(async () => {
    const request = (window as any).smokeRequest;
    const settings = await request('runtime/settings/describe', {});
    const defaults = settings.namespaces.find((entry: any) => entry.ns === 'agent-default-model').value;
    const expectedRevision = settings.namespaces.find((entry: any) => entry.ns === 'llm-pi-ai').revision;
    try { await request('runtime/models/setEnabled', {...defaults, expectedRevision, enabled:false}); return false; }
    catch (error) { return /default model/i.test(String(error)); }
  });
  assert.equal(protectedDefault, true);
  console.log("Provider UI smoke passed: add → discover → select candidate → save via AppServer → real runtime model catalog. No default change.");
} finally {
  await browser?.close();
  await vite?.close();
  await host?.close();
  if (endpoint.listening) await new Promise<void>((done) => endpoint.close(() => done()));
  await rm(dataDirectory, { recursive: true, force: true });
}
