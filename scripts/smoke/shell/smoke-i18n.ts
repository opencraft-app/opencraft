import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { build } from "esbuild";

const { chromium, _electron } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-i18n-test", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "i18n-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== "/") return next();
    res.setHeader("content-type", "text/html");
    res.end('<html lang="en-US"><head><title>OpenCraft locale verification</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/i18n.tsx"></script></body></html>');
  }); } }],
});
let browser: any, desktop: any;
try {
  await vite.listen();
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  let page: any;
  if (process.env.OPENCRAFT_I18N_ELECTRON_EXECUTABLE) {
    const profile = await mkdtemp(join(tmpdir(), "opencraft-locale-electron-"));
    await build({ entryPoints: ["tests/fixtures/i18n-electron.ts"], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: join(profile, "main.cjs") });
    await build({ entryPoints: ["apps/workbench-electron/src/preload.ts"], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: join(profile, "preload.cjs") });
    desktop = await _electron.launch({ executablePath: process.env.OPENCRAFT_I18N_ELECTRON_EXECUTABLE, args: [join(profile, "main.cjs")], timeout: 20000, env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
      OPENCRAFT_LOCALE_PROFILE: profile, OPENCRAFT_LOCALE_SMOKE_URL: url,
    } });
    page = await desktop.firstWindow({ timeout: 20000 });
  } else {
    browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
    page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
  }
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript("window.__name = value => value");
  await page.goto(url);
  const editor = page.locator(".ProseMirror");
  await editor.waitFor();
  await editor.click(); await page.keyboard.type("draft survives");
  await page.evaluate(() => { (window as any).__originalEditor = document.querySelector(".ProseMirror"); });
  await page.evaluate(() => (window as any).__localeFixture.switch("zh-CN"));
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN" && document.querySelector("[data-imperative]")?.textContent === "设置");
  if (desktop) {
    await page.evaluate(() => (window as any).opencraftDesktop.locale.setApplicationLocale("zh-CN"));
    assert.deepEqual(await desktop.evaluate(() => (globalThis as any).__localeNativeProbe()), ["打开 OpenCraft", "", "退出 OpenCraft"]);
  }
  const menu = page.locator("[data-settings-menu]");
  assert.equal(await menu.locator('[aria-current="page"]').textContent(), "模型服务");
  assert.match(await menu.textContent(), /应用.*聊天.*外观.*插件.*已归档会话.*服务器.*模型服务/s);
  assert.match(await menu.textContent(), /Legacy plugin/);
  assert.equal(await editor.getAttribute("aria-label"), "告诉我接下来想做点什么");
  assert.equal(await editor.textContent(), "draft survives");
  assert.equal(await page.evaluate(() => document.activeElement === (window as any).__originalEditor), true);
  assert.equal(await page.evaluate(() => document.querySelector(".ProseMirror") === (window as any).__originalEditor), true);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  assert.equal(await editor.locator(".opencraft-composer-placeholder").getAttribute("data-placeholder"), "告诉我接下来想做点什么");
  assert.equal(await page.locator("[data-independent]").textContent(), "Settings");
  await page.evaluate(() => (window as any).__localeFixture.flush());
  await page.reload(); await editor.waitFor();
  assert.equal(await page.locator("#workbench-language").inputValue(), "zh-CN");
  const menuNode = await menu.locator('[aria-current="page"]').elementHandle();
  await page.evaluate(() => { (window as any).__menuRegistry = (window as any).__localeFixture.contributions.getSnapshot(); });
  await page.selectOption("#workbench-language", "en-US");
  await page.waitForFunction(() => document.querySelector("[data-imperative]")?.textContent === "Settings");
  assert.equal(await menu.locator('[aria-current="page"]').textContent(), "Model services");
  assert.equal(await menuNode!.evaluate((node: Element) => node === document.querySelector('[data-settings-menu] [aria-current="page"]')), true);
  assert.equal(await page.evaluate(() => (window as any).__menuRegistry === (window as any).__localeFixture.contributions.getSnapshot()), true);
  assert.match(await menu.textContent(), /Application.*Chat.*Appearance.*Plugins.*Archived conversations.*Server.*Model services/s);
  await page.selectOption("#workbench-language", "");
  await page.evaluate(() => (window as any).__localeFixture.inherited("ar-EG"));
  await page.waitForFunction(() => document.documentElement.dir === "rtl");
  await page.evaluate(() => (window as any).__localeFixture.inherited("en-US"));
  await page.waitForFunction(() => document.documentElement.dir === "ltr");
  await page.selectOption("#workbench-language", "zh-CN");
  await page.waitForFunction(() => document.querySelector("[data-imperative]")?.textContent === "设置");
  // Actual shared UI consumers update in place, including an already-open modal.
  const shared = page.locator("[data-shared-i18n]");
  await shared.getByRole("button", { name: "展开表格", exact: true }).waitFor();
  assert.equal(await shared.getByRole("button", { name: "取消语音输入", exact: true }).count(), 1);
  await shared.getByRole("button", { name: "查看并移除", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText("移除尚未确认送达的消息？", { exact: true }).waitFor();
  await page.evaluate(() => { (window as any).__i18nDialog = document.querySelector('[role="alertdialog"]'); });
  await page.evaluate(() => (window as any).__localeFixture.switch("en-US"));
  await dialog.getByText("Discard message with unconfirmed delivery?", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('[role="alertdialog"]') === (window as any).__i18nDialog), true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await shared.getByText("User-authored queue message", { exact: true }).textContent(), "User-authored queue message");
  assert.equal(await shared.getByRole("button", { name: "Cancel voice input", exact: true }).count(), 1);
  await shared.getByRole("button", { name: "Expand table", exact: true }).click();
  const tableDialog = page.getByRole("dialog", { name: "Table preview", exact: true });
  await tableDialog.waitFor();
  await page.evaluate(() => { (window as any).__i18nTable = document.querySelector('.chat-table-preview[open]'); });
  await page.evaluate(() => (window as any).__localeFixture.switch("zh-CN"));
  const localizedTableDialog = page.getByRole("dialog", { name: "表格预览", exact: true });
  await localizedTableDialog.waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.chat-table-preview[open]') === (window as any).__i18nTable), true);
  assert.match(await localizedTableDialog.textContent(), /User heading.*User cell/s);
  await localizedTableDialog.getByRole("button", { name: "关闭表格预览", exact: true }).click();
  await shared.getByRole("button", { name: "预览图片", exact: true }).click();
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor();
  await page.evaluate(() => (window as any).__localeFixture.switch("en-US"));
  await page.getByRole("button", { name: "Close image preview", exact: true }).click();
  await page.evaluate(() => (window as any).__localeFixture.switch("zh-CN"));
  // Host result labels translate; native output and the reader's work stay intact.
  const commandResults = page.locator("[data-command-results]");
  const reading = commandResults.locator('[data-command-result="reading"] pre');
  await reading.waitFor();
  const rawOutput = await reading.textContent();
  assert.match(rawOutput, /^Success\nNo output\n/);
  await editor.fill("command draft");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.keyboard.press("End");
  await page.keyboard.down("Shift"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.up("Shift");
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "aft", "establish the selection before switching language");
  await reading.evaluate((node: HTMLElement) => { node.scrollTop = 120; node.scrollLeft = 80; });
  await page.waitForFunction(() => { const node = document.querySelector<HTMLElement>('[data-command-result="reading"] pre'); return node?.scrollTop === 120 && node.scrollLeft === 80; });
  await page.evaluate(() => { (window as any).__commandLog = document.querySelector('[data-command-result="reading"] pre'); (window as any).__commandEditor = document.querySelector('.ProseMirror'); });
  const commandScreenshots = await mkdtemp(join(tmpdir(), "opencraft-command-locale-"));
  for (const [language, labels] of Object.entries({
    "zh-CN": { empty: "无输出", success: "成功", stopped: "已停止", failed: "退出码 7", unknown: "退出码未知", unavailable: "执行结果不可用", missing: "结果未知" },
    "en-US": { empty: "No output", success: "Success", stopped: "Stopped", failed: "Exit code 7", unknown: "Exit code unknown", unavailable: "Execution result unavailable", missing: "Result unknown" },
  })) {
    await page.evaluate((value: string) => (window as any).__localeFixture.switch(value), language);
    await page.waitForFunction((value: string) => document.documentElement.lang === value, language);
    console.log("Command result labels:", language, JSON.stringify(await commandResults.locator('.thread-shell-output__footer').allTextContents()));
    for (const [id, footer] of Object.entries({ success: labels.success, stopped: labels.stopped, failed: labels.failed, unknown: labels.unknown, missing: labels.missing })) {
      const result = commandResults.locator(`[data-command-result="${id}"]`);
      assert.equal((await result.locator('.thread-shell-output__footer').textContent())?.trim(), footer);
      assert.equal(await result.locator('pre').textContent(), id === "missing" ? labels.unavailable : labels.empty);
    }
    assert.equal(await reading.textContent(), rawOutput, "native stdout is never translated");
    assert.deepEqual(await reading.evaluate((node: HTMLElement) => ({ top: node.scrollTop, left: node.scrollLeft, same: node === (window as any).__commandLog })), { top: 120, left: 80, same: true });
    assert.equal(await editor.textContent(), "command draft");
    assert.deepEqual(await page.evaluate(() => ({ same: document.querySelector('.ProseMirror') === (window as any).__commandEditor, focused: document.activeElement === (window as any).__commandEditor, selection: window.getSelection()?.toString() })), { same: true, focused: true, selection: "aft" });
    await commandResults.screenshot({ path: join(commandScreenshots, `${language}.png`) });
  }
  console.log(`PASS localized command results and unchanged stdout, log/editor identity, both scroll axes, draft, focus and selection. Screenshots: ${commandScreenshots}`);
  await page.evaluate(() => (window as any).__localeFixture.switch("zh-CN"));
  const output = await mkdtemp(join(tmpdir(), "opencraft-i18n-"));
  await page.screenshot({ path: join(output, "zh-CN.png") });
  assert.deepEqual(errors, []);
  console.log(`PASS ${desktop ? "Electron with production preload and native Menu" : "Chromium"}: real Composer/Intl/Settings/IndexedDB, live language switch, shared dictation/queue/image/table controls and open-dialog continuity, draft/focus/undo continuity, independent roots, persistence and RTL. Screenshot: ${output}/zh-CN.png`);
} finally { await desktop?.close(); await browser?.close(); await vite.close(); }
