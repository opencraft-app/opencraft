import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium, _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let version = "1.0.0", apiVersion = 1, broken = false, unavailable = false, requests = 0;
const verifyTab = process.env.OPENCRAFT_VERIFY_EXTENSIONS_TAB === "1";
const server = await createServer({ configFile: false, define: { "process.env.NEXT_PUBLIC_REGION": '"cn"', "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""' }, esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "extension-proof", configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] === "/__extension-check") {
        res.setHeader("Content-Type", "text/html");
        res.end('<html><body><script type="module" src="/tests/fixtures/extension-lifecycle.ts"></script></body></html>');
      } else if (req.url?.startsWith("/candidate.mjs")) {
        requests++;
        if (unavailable) { res.statusCode = 503; res.end("offline"); return; }
        res.setHeader("Content-Type", "text/javascript");
        res.end(`export default {manifest:{manifestVersion:1,id:'example.browser',name:'Browser proof',version:'${version}',apiVersion:${apiVersion},trust:'trusted',platforms:['web'],activationEvents:['onStartupFinished']},activate(api){${broken ? "throw Error('broken update')" : `api.commands.register({id:'example.browser.run',title:'Run'},()=>'${version}')`}}}`);
      } else next();
    });
  },
}] });
await server.listen();
let browser: any;
let desktop: any;
try {
  let page: any;
  if (process.env.OPENCRAFT_EXTENSION_ELECTRON_EXECUTABLE) {
    const temporary = await mkdtemp(join(tmpdir(), "opencraft-extension-desktop-"));
    const main = join(temporary, "main.cjs");
    await writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(temporary, "profile"))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(`${server.resolvedUrls!.local[0]}__extension-check`)});});app.on('window-all-closed',()=>app.quit());`);
    desktop = await _electron.launch({ executablePath: process.env.OPENCRAFT_EXTENSION_ELECTRON_EXECUTABLE, args: [main], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")) });
    page = await desktop.firstWindow();
  } else {
    browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
    page = await browser.newPage();
  }
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`${server.resolvedUrls!.local[0]}__extension-check${verifyTab ? "?skills=1" : ""}`);
  await page.waitForSelector('body[data-ready="true"]');
  if (verifyTab) {
    await page.getByRole("radio", { name: "扩展", exact: true }).click();
    await page.getByText("Built-in example", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "选择技能安装位置" }).count(), 0);
    await page.getByLabel("从 URL 安装可信扩展").fill(`${server.resolvedUrls!.local[0]}candidate.mjs`);
    await page.getByRole("button", { name: "安装", exact: true }).click();
    await page.getByText("Browser proof", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看 Browser proof 详情" }).click();
    await page.getByText("安装来源", { exact: true }).waitFor();
    await page.getByRole("button", { name: "返回扩展列表" }).click();
    await page.getByLabel("搜索扩展").fill("Browser");
    assert.equal(await page.getByText("Built-in example", { exact: true }).count(), 0);
    await page.getByRole("radio", { name: "技能", exact: true }).click();
    await page.getByRole("radio", { name: "扩展", exact: true }).click();
    assert.equal(await page.getByLabel("搜索扩展").inputValue(), "Browser");
    await page.getByRole("switch", { name: "停用 Browser proof" }).click();
    await page.getByRole("switch", { name: "启用 Browser proof" }).waitFor();
    await page.evaluate(() => (window as any).extensionProof.developer(false));
    assert.equal(await page.getByLabel("从 URL 安装可信扩展").count(), 0);
    await page.getByRole("button", { name: "查看 Browser proof 详情" }).click();
    await page.getByRole("button", { name: "移除扩展", exact: true }).click();
    await page.getByRole("alertdialog", { name: "移除扩展" }).waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "移除扩展", exact: true }).click();
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await page.getByText("没有匹配的扩展。", { exact: true }).waitFor();
    await page.getByLabel("搜索扩展").fill("");
    await page.getByRole("button", { name: "查看 Built-in example 详情" }).click();
    assert.equal(await page.getByRole("button", { name: "移除扩展", exact: true }).count(), 0);
    await page.getByRole("button", { name: "返回扩展列表" }).click();
    await page.setViewportSize({ width: 480, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "/tmp/opencraft-skills-extensions.png" });
    console.log("PASS: Skills Extensions tab, unified inventory, details, preserved search, no Host selector, enable intent, developer install gate, confirmed removal, protected builtins");
  } else {
  await page.getByLabel("ES module URL").fill(`${server.resolvedUrls!.local[0]}candidate.mjs`);
  await page.getByRole("button", { name: "Install and enable" }).click();
  await page.getByText("1.0.0 · Active", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).extensionProof.run()), "1.0.0");
  version = "2.0.0"; broken = true;
  assert.match(await page.evaluate(async () => { try { await (window as any).extensionProof.reload(); return "unexpected success"; } catch (e) { return String(e); } }), /broken update/);
  unavailable = true;
  const before = requests;
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  assert.equal(requests, before);
  assert.equal(await page.evaluate(() => (window as any).extensionProof.run()), "1.0.0");
  unavailable = false; broken = false;
  await page.evaluate(() => (window as any).extensionProof.reload());
  assert.equal(await page.evaluate(() => (window as any).extensionProof.run()), "2.0.0");
  await page.evaluate(() => (window as any).extensionProof.toggle(false));
  await page.reload(); await page.waitForSelector('body[data-ready="true"]');
  assert.deepEqual(await page.evaluate(() => (window as any).extensionProof.snapshot()), [{ status: "disabled", enabled: false, version: "2.0.0" }]);
  await page.evaluate(() => (window as any).extensionProof.remove());
  assert.deepEqual(await page.evaluate(() => (window as any).extensionProof.snapshot()), []);
  apiVersion = 2;
  await page.getByLabel("ES module URL").fill(`${server.resolvedUrls!.local[0]}candidate.mjs`);
  await page.getByRole("button", { name: "Install and enable" }).click();
  await page.getByText("2.0.0 · Needs update — incompatible", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: Settings install and incompatibility UI; browser Blob ESM, IndexedDB restart, offline restore, failed/successful updates, disable and remove");
  }
} finally {
  await browser?.close();
  await desktop?.close();
  await server.close();
}
