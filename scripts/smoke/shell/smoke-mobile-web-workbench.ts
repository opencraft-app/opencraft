import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const identity = { version: 1, runtimeId: "browser-native-boundary" };
const packagedManifest = JSON.parse(await readFile("apps/mobile/assets/mobile-resources.json", "utf8"));
const packagedIds = new Set<string>(Object.values(packagedManifest.modules).map((module: any) => module.resourceId));
// Execute in a normal page script so DevTools' evaluation permissions cannot
// bypass the document's policy. These are local resources, not remote code.
const resourcePolicyProbe = `<script>
window.__mobileResourcePolicyProbe = (async () => {
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const dataBytes = await (await fetch('data:application/wasm;base64,AGFzbQEAAAA=')).arrayBuffer();
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
  try {
    const blobBytes = await (await fetch(url)).arrayBuffer();
    const module = await WebAssembly.compile(blobBytes);
    let javascriptEvalAllowed = false;
    try { new Function('return 1')(); javascriptEvalAllowed = true; } catch {}
    return { dataBytes: Array.from(new Uint8Array(dataBytes)), blobBytes: Array.from(new Uint8Array(blobBytes)), wasmExports: WebAssembly.Module.exports(module), javascriptEvalAllowed };
  } finally { URL.revokeObjectURL(url); }
})();
</script>`;
const html = (await readFile("apps/mobile/assets/mobile-workbench.html", "utf8"))
  .replace("/*OPENCRAFT_MOBILE_IDENTITY*/", `window.opencraftMobile=${JSON.stringify(identity)};`)
  .replace(/<\/body><\/html>$/u, resourcePolicyProbe + "</body></html>");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? path.join(os.tmpdir(), "opencraft-mobile-web-workbench");
await mkdir(output, { recursive: true });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/") { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  const config = { hosts: [{ hostId: "preview", label: "Preview server", kind: "remote-control", url: "wss://preview.example.test/appserver" }], builtinAgents: false, hypernode: false };
  response.end(url.searchParams.has("configured") ? html.replace("</head>", `<script type="application/json" id="opencraft-deployment-config">${JSON.stringify(config)}</script></head>`) : html);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const evidence: unknown[] = [];
try {
  for (const configured of [false, true]) for (const width of [390, 1024]) {
    const label = `${configured ? "configured" : "empty"}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, colorScheme: width === 390 ? "light" : "dark" });
    const resourceReads: string[] = [];
    const resourceBytes = new Map<string, number>();
    const websocketRequests: string[] = [];
    // This fixture has no live server or paid model. It validates document,
    // navigation and drafts independently of the server protocol handshake.
    await context.routeWebSocket("wss://preview.example.test/**", route => {
      route.onMessage(raw => {
        const request = JSON.parse(String(raw));
        // Saving uses the real disposable initialize preflight. Other sessions
        // remain intentionally unready; this fixture does not model a server.
        if (request.method === "initialize" && request.params?.clientInfo?.name === "opencraft-connection-preflight") {
          route.send(JSON.stringify({ id: request.id, result: { userAgent: "mobile-preflight-fixture" } }));
        }
      });
    });
    await context.exposeBinding("__readMobileResource", async (_source, id: string) => {
      assert(packagedIds.has(id), "native must reject unknown package IDs");
      resourceReads.push(id);
      const text = await readFile(path.join("apps/mobile/assets/mobile-resources", id + ".ocasset"), "utf8");
      resourceBytes.set(id, Buffer.byteLength(text));
      return text;
    });
    await context.addInitScript(() => {
      Object.assign(window, { __mobileMessages: [], ReactNativeWebView: { postMessage(raw: string) {
        const request = JSON.parse(raw);
        (window as any).__mobileMessages.push(request);
        if (request.type === "resource") void (window as any).__readMobileResource(request.resourceId).then((text: string) => {
          (window as any).__opencraftPackagedReceive({ ...request, text });
        });
      } } });
    });
    const page = await context.newPage();
    console.log("Mobile package: opening", width);
    const errors: string[] = [];
    const executableRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") console.error(message.text().slice(0, 600)); });
    page.on("websocket", socket => websocketRequests.push(socket.url()));
    page.on("request", request => { if (["script", "stylesheet", "font", "worker"].includes(request.resourceType()) && /^https?:/.test(request.url())) executableRequests.push(request.resourceType()); });
    await page.goto(`http://127.0.0.1:${address.port}/${configured ? "?configured=1" : ""}`, { waitUntil: "load", timeout: 90000 });
    console.log("Mobile package: document loaded", width, resourceReads.length);
    const resourcePolicy = await page.evaluate(() => (window as any).__mobileResourcePolicyProbe);
    assert.deepEqual(resourcePolicy, { dataBytes: [0, 97, 115, 109, 1, 0, 0, 0], blobBytes: [0, 97, 115, 109, 1, 0, 0, 0], wasmExports: [], javascriptEvalAllowed: false });
    await page.waitForFunction(() => (window as any).__mobileMessages.some((message: any) => message.type === "ready" || message.type === "startup-error"), undefined, { timeout: 60000 });
    assert.equal(await page.evaluate(() => (window as any).__mobileMessages.some((message: any) => message.type === "startup-error")), false, "packaged startup must succeed");
    console.log("Mobile package: ready", width, resourceReads.length);
    const startupModules = resourceBytes.size;
    const startupModuleBytes = [...resourceBytes.values()].reduce((sum, size) => sum + size, 0);
    await page.locator(".app-shell-root").first().waitFor();
    assert.equal(await page.locator("#root > *").count() > 0, true);
    assert.equal(await page.locator("html").getAttribute("data-ui-density"), "touch");
    assert.deepEqual(errors, []);
    assert.deepEqual(executableRequests, [], "built document must not download executable/style/font resources");
    if (!configured) assert.deepEqual(websocketRequests, [], "unconfigured package must not connect to its synthetic origin");
    assert(websocketRequests.every(url => url === "wss://preview.example.test/appserver"), "only the explicitly configured fixture endpoint may connect");
    assert(resourceReads.length < packagedIds.size, "optional modules must remain unloaded at startup");
    await page.screenshot({ path: path.join(output, `${label}-initial.png`) });
    console.log("Mobile package: first view", (await page.locator("body").innerText()).slice(0, 1200));
    const editor = page.locator(".opencraft-composer-editor");
    const hasEditor = await editor.count() > 0;
    assert.equal(hasEditor, configured, "only an explicit Host should offer a Composer");
    if (hasEditor) await editor.fill("Keep this mobile draft · 保留输入");
    else {
      await page.getByRole("button", { name: "Connect a server", exact: true }).waitFor();
      assert.equal((await page.locator("body").innerText()).includes("HyperNode"), false);
    }
    await page.screenshot({ path: path.join(output, `${label}-draft.png`) });
    // Native visibility, resize and stale messages must keep the same tree.
    await page.evaluate(() => { (window as any).__keptWorkbench = document.querySelector(".app-shell-root"); (window as any).__keptEditor = document.querySelector(".opencraft-composer-editor"); });
    await page.evaluate(identity => {
      window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, type: "visibility", active: false } }));
      window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, runtimeId: "retired", type: "back" } }));
      window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, type: "visibility", active: true } }));
    }, identity);
    // Real settings navigation publishes back availability to the native host.
    const settings = page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true });
    if (!await settings.count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).first().click();
    await page.screenshot({ path: path.join(output, `${label}-settings.png`) });
    console.log("Source control bounds", await page.getByRole("button", { name: "Workspace source", exact: true }).boundingBox(), page.viewportSize());
    await page.getByRole("button", { name: "Workspace source", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).__mobileMessages.at(-1).type), "source-settings");
    await page.screenshot({ path: path.join(output, `${label}-settings-ready.png`) });
    await page.waitForFunction(() => (window as any).__mobileMessages.some((message: any) => message.type === "navigation" && message.canGoBack));
    await page.evaluate(identity => window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, type: "back" } })), identity);
    if (hasEditor) {
      await editor.waitFor();
      assert.equal(await editor.innerText(), "Keep this mobile draft · 保留输入");
    } else {
      const connect = page.getByRole("button", { name: "Connect a server", exact: true });
      await connect.waitFor();
      await connect.click();
      await page.getByRole("textbox", { name: "Secure WebSocket address" }).fill("https://example.org");
      await page.locator("form").getByRole("button", { name: "Connect a server", exact: true }).click();
      await page.getByText("The connection could not be saved. Check the address and try again.", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `${label}-connection.png`) });
      await page.evaluate(identity => window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, type: "back" } })), identity);
      await connect.waitFor();
    }
    await page.setViewportSize({ width: width === 390 ? 844 : 600, height: 600 });
    assert.equal(await page.evaluate(() => document.querySelector(".app-shell-root") === (window as any).__keptWorkbench), true);
    if (hasEditor) {
      assert.equal(await page.evaluate(() => document.querySelector(".opencraft-composer-editor") === (window as any).__keptEditor), true);
      assert.equal(await editor.innerText(), "Keep this mobile draft · 保留输入");
    }
    await page.setViewportSize({ width, height: 844 });
    // A first-party link asks native to open externally and cannot navigate the document.
    await page.evaluate(() => { const anchor = document.createElement("a"); anchor.href = "https://example.org/docs"; anchor.textContent = "External reference"; document.body.append(anchor); anchor.click(); anchor.remove(); });
    assert.equal(await page.evaluate(() => (window as any).__mobileMessages.at(-1).type), "external");
    assert.equal(new URL(page.url()).pathname, "/");
    await page.screenshot({ path: path.join(output, `${label}.png`) });
    evidence.push({ width, configured, errors, executableRequests, websocketRequests, hasEditor, startupModules, startupModuleBytes, loadedModules: resourceReads.length, totalModules: packagedIds.size, resourcePolicy, messages: await page.evaluate(() => (window as any).__mobileMessages.map((message: any) => message.type)), text: (await page.locator("body").innerText()).slice(0, 1200) });
    if (!configured) {
      await page.getByRole("button", { name: "Connect a server", exact: true }).click();
      await page.getByRole("textbox", { name: "Secure WebSocket address" }).fill("wss://preview.example.test/appserver");
      await page.locator("form").getByRole("button", { name: "Connect a server", exact: true }).click();
      await page.waitForFunction(() => (window as any).__mobileMessages.some((message: any) => message.type === "reload"));
    }
    await context.close();
  }
} finally {
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
console.log(JSON.stringify({ passed: evidence.length, output }));
