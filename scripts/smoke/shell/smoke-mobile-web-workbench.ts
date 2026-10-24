import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";

const identity = { version: 1, runtimeId: "browser-native-boundary" };
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
const html = (await readFile("apps/workbench-expo/assets/mobile-workbench.html", "utf8"))
  .replace("/*OPENCRAFT_MOBILE_IDENTITY*/", `window.opencraftMobile=${JSON.stringify(identity)};`)
  .replace(/<\/body><\/html>$/u, resourcePolicyProbe + "</body></html>");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? path.join(os.tmpdir(), "opencraft-mobile-web-workbench");
await mkdir(output, { recursive: true });
const server = createServer((request, response) => {
  if (request.url !== "/") { response.writeHead(404); response.end(); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const evidence: unknown[] = [];
try {
  for (const width of [390, 1024]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, colorScheme: width === 390 ? "light" : "dark" });
    await context.addInitScript(() => {
      Object.assign(window, { __mobileMessages: [], ReactNativeWebView: { postMessage(raw: string) { (window as any).__mobileMessages.push(JSON.parse(raw)); } } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const executableRequests: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (["script", "stylesheet", "font", "worker"].includes(request.resourceType()) && /^https?:/.test(request.url())) executableRequests.push(request.resourceType()); });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load", timeout: 90000 });
    const resourcePolicy = await page.evaluate(() => (window as any).__mobileResourcePolicyProbe);
    assert.deepEqual(resourcePolicy, { dataBytes: [0, 97, 115, 109, 1, 0, 0, 0], blobBytes: [0, 97, 115, 109, 1, 0, 0, 0], wasmExports: [], javascriptEvalAllowed: false });
    await page.waitForFunction(() => (window as any).__mobileMessages.some((message: any) => message.type === "ready"), undefined, { timeout: 60000 });
    await page.locator(".app-shell-root").first().waitFor();
    assert.equal(await page.locator("#root > *").count() > 0, true);
    assert.equal(await page.locator("html").getAttribute("data-ui-density"), "touch");
    assert.deepEqual(errors, []);
    assert.deepEqual(executableRequests, [], "built document must not download executable/style/font resources");
    const editor = page.locator(".opencraft-composer-editor");
    await editor.fill("Keep this mobile draft · 保留输入");
    await page.screenshot({ path: path.join(output, `${width}-initial.png`) });
    // Native visibility, resize and stale messages must keep the same tree.
    await page.evaluate(() => { (window as any).__keptWorkbench = document.querySelector(".app-shell-root"); (window as any).__keptEditor = document.querySelector(".opencraft-composer-editor"); });
    await page.evaluate(identity => {
      window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, type: "visibility", active: false } }));
      window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, runtimeId: "retired", type: "back" } }));
      window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, type: "visibility", active: true } }));
    }, identity);
    await page.setViewportSize({ width: width === 390 ? 844 : 600, height: 600 });
    assert.equal(await page.evaluate(() => document.querySelector(".app-shell-root") === (window as any).__keptWorkbench), true);
    assert.equal(await page.evaluate(() => document.querySelector(".opencraft-composer-editor") === (window as any).__keptEditor), true);
    assert.equal(await editor.innerText(), "Keep this mobile draft · 保留输入");
    // Real settings navigation publishes back availability to the native host.
    const settings = page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true });
    if (!await settings.count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).first().click();
    await page.waitForFunction(() => (window as any).__mobileMessages.some((message: any) => message.type === "navigation" && message.canGoBack));
    await page.evaluate(identity => window.dispatchEvent(new CustomEvent("opencraft-mobile", { detail: { ...identity, type: "back" } })), identity);
    await editor.waitFor();
    assert.equal(await editor.innerText(), "Keep this mobile draft · 保留输入");
    // A first-party link asks native to open externally and cannot navigate the document.
    await page.evaluate(() => { const anchor = document.createElement("a"); anchor.href = "https://example.org/docs"; anchor.textContent = "External reference"; document.body.append(anchor); anchor.click(); anchor.remove(); });
    assert.equal(await page.evaluate(() => (window as any).__mobileMessages.at(-1).type), "external");
    assert.equal(new URL(page.url()).pathname, "/");
    await page.screenshot({ path: path.join(output, `${width}.png`) });
    evidence.push({ width, errors, executableRequests, resourcePolicy, messages: await page.evaluate(() => (window as any).__mobileMessages.map((message: any) => message.type)), text: (await page.locator("body").innerText()).slice(0, 1200) });
    await context.close();
  }
} finally {
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
console.log(JSON.stringify({ passed: evidence.length, output }));
