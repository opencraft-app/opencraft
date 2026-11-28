import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SUMMARY_OUTPUT ?? ".local/sidebar-activity-summary";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", cacheDir: `${output}/vite-cache`,
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "summary-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => { if (req.url !== "/") return next(); res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/sidebar-activity-summary.tsx"></script>'); });
  } }],
});
await mkdir(output, { recursive: true });
await vite.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const evidence: unknown[] = [];
try {
  for (const [theme, touch, reduced] of [["light", false, false], ["dark", true, false], ["lavender", false, true]] as const) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1100, height: 950 }, hasTouch: touch, isMobile: touch, reducedMotion: reduced ? "reduce" : "no-preference" });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(60000); page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(theme => { (window as any).__name = (value: unknown) => value; localStorage.setItem("opencraft.appearance-theme", theme); }, theme);
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Main draft").waitFor();
    if (touch) await page.locator('[data-chrome-action-id="sidebar-toggle"][data-chrome-action-host-role="persistent"]').tap();
    const region = (name: string) => page.getByRole("region", { name, exact: true });
    const heading = (name: string) => region(name).locator(".sidebar-thread-group-toggle").first();
    const counts = (name: string) => heading(name).locator("[data-activity-kind]").evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute("data-activity-kind"), Number(node.textContent)])));
    const check = async (name: string, expected: Record<string, number>) => {
      await page.waitForFunction(({ name, expected }) => {
        const nodes = [...document.querySelectorAll<HTMLElement>("section.sidebar-activity-group")].find(node => node.getAttribute("aria-label") === name)?.querySelector(".sidebar-thread-group-toggle")?.querySelectorAll("[data-activity-kind]");
        return nodes && JSON.stringify(Object.fromEntries([...nodes].map(node => [node.getAttribute("data-activity-kind"), Number(node.textContent)]))) === JSON.stringify(expected);
      }, { name, expected });
      assert.deepEqual(await counts(name), expected);
    };
    const switcher = page.getByRole("radiogroup", { name: "对话", exact: true });
    const recentOption = switcher.getByRole("radio", { name: /最近/ });
    const privateOption = switcher.getByRole("radio", { name: /私密/ });
    await switcher.waitFor(); assert.equal(await switcher.getByRole("radio", { name: /我的/ }).count(), 0);
    await check("置顶", { unread: 3, attention: 2, running: 3 });
    await check("最近", { unread: 2, running: 1 });
    const attention = page.locator('.sidebar-activity-group').filter({ has: page.locator('.sidebar-thread-group-label', { hasText: '等你处理' }) });
    assert.equal(await attention.locator('[data-activity-kind="attention"]').first().textContent(), "2");
    assert.equal(await privateOption.locator(".sidebar-activity-summary").count(), 0);
    if (touch) await privateOption.tap(); else await privateOption.click();
    await region("私密").waitFor(); assert.equal(await page.getByRole("region", { name: "我的", exact: true }).count(), 0);
    if (touch) await recentOption.tap(); else await recentOption.click();
    await region("置顶").waitFor();
    const dimensions = async () => heading("置顶").evaluate(node => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width }));
    const before = await dimensions();
    await heading("置顶").scrollIntoViewIfNeeded();
    if (touch) await heading("置顶").tap(); else { await heading("置顶").focus(); await heading("置顶").press("Enter"); }
    await check("置顶", { unread: 3, attention: 2, running: 3 });
    await heading("置顶").click();
    await check("置顶", { unread: 3, attention: 2, running: 3 });
    const style = await heading("置顶").evaluate(node => {
      const summary = node.querySelector(".sidebar-activity-summary")!, root = node.getBoundingClientRect(), label = node.querySelector(".sidebar-thread-group-label")!.getBoundingClientRect(), box = summary.getBoundingClientRect();
      const marker = (kind: string) => getComputedStyle(node.querySelector(`[data-activity-kind="${kind}"] .sidebar-activity-item__status`)!);
      return { fits: box.right <= root.right && box.left >= label.right, blue: marker("unread").backgroundColor, gray: marker("attention").backgroundColor, spin: marker("running").animationName, described: !!node.getAttribute("aria-describedby"), rootHeight: root.height };
    });
    assert.ok(style.fits); assert.notEqual(style.blue, style.gray); assert.equal(style.described, true);
    assert.equal(style.spin === "none", reduced); if (touch) assert.ok(style.rootHeight >= 44);
    await page.screenshot({ path: `${output}/${theme}-${touch ? "touch" : "pointer"}.png` });
    await page.evaluate(() => (window as any).sidebarSummaryFixture.patch("pin-run", { status: "ready", unread: true }));
    await check("置顶", { unread: 4, attention: 2, running: 2 });
    await page.evaluate(() => (window as any).sidebarSummaryFixture.patch("pin-later", { unread: false }));
    await check("置顶", { unread: 3, attention: 2, running: 2 });
    assert.deepEqual(await dimensions(), before, "counts must retain heading geometry");
    await page.getByRole("searchbox").fill("最近会话 11");
    await page.waitForFunction(() => {
      const radio = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="对话"] [role="radio"][data-value="recent"]');
      const nodes = radio?.querySelectorAll("[data-activity-kind]");
      return nodes && JSON.stringify(Object.fromEntries([...nodes].map(node => [node.getAttribute("data-activity-kind"), Number(node.textContent)]))) === JSON.stringify({ unread: 1 });
    });
    assert.deepEqual(await recentOption.locator("[data-activity-kind]").evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute("data-activity-kind"), Number(node.textContent)]))), { unread: 1 });
    await page.getByRole("searchbox").fill("");
    await check("最近", { unread: 2, running: 1 });
    await page.evaluate(() => (window as any).sidebarSummaryFixture.preferences.set("sidebar.serverFilter", { serverId: "local", label: "Local" }));
    await check("置顶", { unread: 2, attention: 2, running: 2 });
    await page.evaluate(() => (window as any).sidebarSummaryFixture.preferences.set("sidebar.serverFilter", { serverId: "", label: "" }));
    await check("置顶", { unread: 3, attention: 2, running: 2 });
    await page.evaluate(() => { const f = (window as any).sidebarSummaryFixture; f.setRows(f.initial.map((row: any) => ({ ...row, status: "ready", unread: false, goalActive: false }))); });
    await check("置顶", {}); await check("最近", {});
    assert.deepEqual(await dimensions(), before); assert.equal(await heading("置顶").getAttribute("aria-describedby"), null);
    assert.equal(await page.getByLabel("Main draft").inputValue(), "保留草稿"); assert.deepEqual(errors, []);
    evidence.push({ theme, touch, reduced, style, completeTreeCounts: true, liveUpdates: true, filters: true, geometryStable: true });
    await context.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, scenarios: evidence.length, output }));
} finally { await browser.close(); await vite.close(); }
