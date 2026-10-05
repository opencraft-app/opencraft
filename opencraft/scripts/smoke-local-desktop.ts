import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { AccountPoolStore } from "@opencraft/account-pool-host";
import { AppHostServer } from "@opencraft/app-host-server";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { LocalDesktopService } from "../apps/local-agent-host/src/desktop/local-desktop-service.js";
import { createNativeObserver, localDesktopMachineIdentity } from "../apps/local-agent-host/src/desktop/native-observer.js";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";

if (!process.env.OPENCRAFT_CODEX_EXECUTABLE || !process.env.OPENCRAFT_PLAYWRIGHT_MODULE) {
  throw new Error("Explicit Codex executable and Playwright module required; installed observer must already be running");
}
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE);
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
// Use this checkout's actual built styles. A decoded but zero-sized canvas is
// not visual acceptance, and test-only layout CSS would hide that omission.
const assets = join(process.cwd(), "apps/workbench-web/dist/assets");
const cssNames = (await readdir(assets)).filter(name => name.endsWith(".css"));
const css = Buffer.concat(await Promise.all(cssNames.map(name => readFile(join(assets, name)))));
assert.ok(css.includes(Buffer.from(".cloud-desktop-panel")), "Build the current Web styles before acceptance");
const root = await mkdtemp(join(tmpdir(), "opencraft-local-desktop-smoke-"));
const dataDirectory = join(root, "codex"), webRoot = join(root, "web");
await mkdir(webRoot);
const store = new AccountPoolStore({ databasePath: join(dataDirectory, "account-pool.sqlite"), secretsDirectory: join(dataDirectory, "secrets") });
store.addAccount({ id: "fixture-account", provider: "codex", label: "Fixture", upstreamAccountId: "fixture-chatgpt-account",
  priority: 1, enabled: true }, { accessToken: "synthetic-local-only", refreshToken: "synthetic-local-only", expiresAt: null });
store.close();
let modelRequests = 0;
const model = createServer((request, response) => {
  request.resume();
  if (request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-test", object: "model", owned_by: "fixture" }] })); return;
  }
  modelRequests++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const item = { id: "fixture-message", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Fixture response.", annotations: [] }] };
  for (const event of [
    { type: "response.created", response: { id: "fixture-response", object: "response", created_at: 1, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture response." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fixture-response", object: "response", created_at: 1, status: "completed",
      output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
let browser: any, web: any, appHost: AppHostServer | undefined, desktop: LocalDesktopService | undefined;
try {
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const nativeObserver = createNativeObserver(); await nativeObserver.inspect(AbortSignal.timeout(5_000));
  const viewingStreams: Socket[] = [];
  // Fault injection is confined to this isolated Host's viewer, never Chat or
  // the observer service. All native proof and authorization remain real.
  const observer = {
    inspect: (signal: AbortSignal) => nativeObserver.inspect(signal),
    async open(incarnation: string, signal: AbortSignal) {
      const stream = await nativeObserver.open(incarnation, signal);
      viewingStreams.push(stream); return stream;
    },
  };
  desktop = new LocalDesktopService({ serverId: "isolated-local-codex", environmentId: await localDesktopMachineIdentity(),
    principalId: `local-owner:${process.getuid!()}`, observer });
  let engines = 0;
  appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport(hostId) {
    assert.equal(hostId, "local-codex"); engines++;
    return new CodexEngineAdapter({ executable: process.env.OPENCRAFT_CODEX_EXECUTABLE!, runtimeDirectory: root, dataDirectory,
      nativeCodexHomeDirectory: join(root, "native-codex"), desktop,
      upstreamBaseUrl: `http://127.0.0.1:${port}/backend-api/codex`,
      fetch: async (input, init) => String(input).includes("/wham/usage") ? Response.json({ plan_type: "fixture" }) : fetch(input, init),
      logDiagnostic: event => { if (event.event === "appserver-start" || event.event === "appserver-exit") console.info(event.event); },
    });
  } });
  const bundle = await build({ entryPoints: ["tests/fixtures/local-desktop-ui.tsx"], bundle: true, write: false,
    format: "esm", platform: "browser", jsx: "automatic", define: { SMOKE_WORKSPACE_ROOT: JSON.stringify(root) } });
  await writeFile(join(webRoot, "fixture.js"), bundle.outputFiles[0]!.contents);
  await writeFile(join(webRoot, "fixture.css"), css);
  await writeFile(join(webRoot, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root" style="width:720px;height:480px"></div><script type="module" src="/fixture.js"></script></body></html>');
  web = await createWorkbenchWebServer({ root: webRoot, appServerTarget: null, appHostServer: appHost,
    loopbackOnly: true, desktopService: desktop, onAppHostDiagnostic: () => {} });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.setDefaultTimeout(20_000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("status").filter({ hasText: "Viewing desktop." }).waitFor();
  const canvas = page.locator("canvas");
  const assertVisibleFramebuffer = async () => {
    await canvas.waitFor({ state: "visible" });
    const displayed = await canvas.evaluate((element: HTMLCanvasElement) => {
      const rect = element.getBoundingClientRect(), parent = document.getElementById("root")!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, contained: rect.left >= parent.left - 1
        && rect.top >= parent.top - 1 && rect.right <= parent.right + 1 && rect.bottom <= parent.bottom + 1 };
    });
    assert.ok(displayed.width >= 200 && displayed.height >= 100 && displayed.contained,
      "decoded framebuffer must occupy a visible area inside the real panel geometry");
    return displayed;
  };
  assert.deepEqual(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]), [1440, 900]);
  // RFB connect acknowledges protocol readiness, not first-frame paint.
  await page.waitForFunction(() => {
    const element = document.querySelector("canvas");
    return element?.getContext("2d")?.getImageData(2, 2, 1, 1).data[3] === 255;
  });
  const pixel = await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext("2d")!.getImageData(2, 2, 1, 1).data));
  assert.deepEqual(pixel, [32, 128, 224, 255], "real Xvfb root pixel must survive the authenticated native/RFB/browser chain");
  await assertVisibleFramebuffer();
  assert.equal(await page.getByRole("button", { name: "Take control" }).isDisabled(), true);
  assert.equal(viewingStreams.length, 1);
  const previousCanvas = await canvas.elementHandle();
  viewingStreams[0]!.destroy();
  await page.getByRole("status").filter({ hasText: "Connecting…" }).waitFor();
  await page.waitForFunction(() => (window as any).__localDesktopFixture.viewingConnections() === 2);
  await page.getByRole("status").filter({ hasText: "Viewing desktop." }).waitFor();
  await page.waitForFunction(() => document.querySelector("canvas")?.getContext("2d")?.getImageData(2, 2, 1, 1).data[3] === 255);
  assert.equal(await previousCanvas!.evaluate((element: HTMLElement) => element.isConnected), false);
  await previousCanvas!.dispose();
  assert.deepEqual(await canvas.evaluate((element: HTMLCanvasElement) => Array.from(element.getContext("2d")!.getImageData(2, 2, 1, 1).data)), pixel);
  assert.equal(viewingStreams.length, 2, "recovery must open a new authorized physical stream");
  assert.equal(viewingStreams[0]!.destroyed, true);
  assert.equal(await page.getByRole("button", { name: "Take control" }).isDisabled(), true);
  const displayed = await assertVisibleFramebuffer();
  await page.screenshot({ path: join(root, "desktop-acceptance.png") });
  assert.equal(await page.evaluate(() => (window as any).__localDesktopFixture.closeViewer()), true, "closing viewer must preserve the native Thread");
  await page.evaluate(() => (window as any).__localDesktopFixture.disconnectHost());
  await page.getByRole("status").filter({ hasText: "Desktop is not available here." }).waitFor();
  assert.equal(engines, 1); assert.equal(modelRequests, 1); assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).__localDesktopFixture.dispose());
  console.info(JSON.stringify({ result: "passed", realCodex: true, realThread: true, realNativeDesktop: true,
    framebuffer: [1440, 900], displayed, pixel, automaticRecovery: true, viewingConnections: viewingStreams.length,
    model: "local synthetic only", tat: "not exercised", evidenceDirectory: root }));
} finally {
  await browser?.close(); desktop?.close();
  await web?.close(); await appHost?.close();
  await new Promise<void>(resolve => model.close(() => resolve()));
}
