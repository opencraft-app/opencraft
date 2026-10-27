import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/draft-toolbar";
await mkdir(output, { recursive: true });
const fixtureCss = process.env.OPENCRAFT_SMOKE_CSS ? await readFile(process.env.OPENCRAFT_SMOKE_CSS, "utf8") : null;
const vite = await createServer({ configFile: false, root: process.cwd(), cacheDir: "node_modules/.vite-draft-toolbar", logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "draft-toolbar", resolveId: id => id === "/draft-toolbar.css" ? id : null,
load: id => id === "/draft-toolbar.css" ? fixtureCss : null,
transform(code, id) { return fixtureCss !== null && id.endsWith("/tests/fixtures/home-composer-focus.tsx")
  ? code.replace('import "../../apps/workbench-web/src/styles/app.scss";', 'import "/draft-toolbar.css";') : null; },
configureServer(server) { server.middlewares.use((req, res, next) => {
  if (!req.url?.startsWith("/?")) return next();
  res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/home-composer-focus.tsx"></script>');
}); } }] });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const evidence: unknown[] = [];
try {
  for (const width of [320, 390, 430]) for (const theme of ["light", "dark"]) for (const policy of ["user", "session", "host-default"]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
    await context.addInitScript("window.__name = value => value");
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("PAGEERROR", error.message); });
    await page.goto(`${vite.resolvedUrls!.local[0]}?toolbar&theme=${theme}&policy=${policy}${width === 320 ? "&longPath" : ""}`);
    const editor = page.locator(".opencraft-composer-editor"); await editor.waitFor(); console.log("MOUNT", width, theme, policy);
    await editor.evaluate(element => { (window as any).keptEditor = element; });
    const geometry = () => page.locator(".opencraft-composer-shell").evaluate(shell => {
      const rect = shell.getBoundingClientRect();
      const header = shell.querySelector(".opencraft-composer-chrome-header")!.getBoundingClientRect();
      const input = shell.querySelector(".opencraft-composer-input-row")!.getBoundingClientRect();
      const footer = shell.querySelector(".opencraft-composer-footer")!.getBoundingClientRect();
      const buttons = Array.from(shell.querySelectorAll<HTMLElement>(".opencraft-composer-footer button")).filter(button => button.offsetWidth && button.offsetHeight).map(button => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { label: button.title || button.getAttribute("aria-label") || button.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, reachable: hit === button || button.contains(hit) };
      });
      return { shell: rect.toJSON(), header: header.toJSON(), input: input.toJSON(), footer: footer.toJSON(), buttons, position: getComputedStyle(shell.querySelector(".opencraft-composer-footer__controls")!).position };
    });
    await page.waitForTimeout(180);
    const initial = await geometry();
    const check = (g: Awaited<ReturnType<typeof geometry>>) => {
      assert(g.header.bottom <= g.input.top + 1, "context owns its own row");
      assert(g.input.bottom <= g.footer.top + 1, "input owns its own row");
      assert.notEqual(g.position, "absolute", "controls participate in footer geometry");
      for (const button of g.buttons.filter(b => !["Select machine", "Select project"].includes(b.label ?? ""))) {
        assert(button.left >= g.shell.left - 1 && button.right <= g.shell.right + 1, JSON.stringify(button));
      }
    };
    check(initial);
    if (width === 390 && policy === "session") await page.screenshot({ path: `${output}/${theme}-initial.png` });
    const permission = page.locator(".opencraft-composer-mode--permissions");
    assert(await permission.isVisible());
    assert(initial.buttons.find(b => b.label?.includes("access") || b.label?.includes("访问"))?.reachable, "permission can be hit");
    await permission.click();
    await page.locator(".opencraft-composer-selection-menu--permissions").waitFor();
    await page.locator(".opencraft-composer-selection-menu--permissions [role=menuitem]").last().click();
    if (policy !== "host-default") {
      await page.locator(".opencraft-composer-mode--intelligence").click();
      await page.locator(".opencraft-composer-selection-menu--intelligence[data-state=open]").waitFor();
      await page.keyboard.press("Escape");
    }
    await editor.fill("保留当前草稿"); check(await geometry());
    await page.setViewportSize({ width: 320, height: 420 }); await page.waitForTimeout(80); check(await geometry());
    assert.equal(await editor.innerText(), "保留当前草稿");
    assert(await editor.evaluate(element => element === (window as any).keptEditor));
    await editor.fill(""); await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(100); check(await geometry());
    assert.equal((await geometry()).shell.height, initial.shell.height);
    if (width === 390 && policy === "session") await page.screenshot({ path: `${output}/${theme}.png` });
    assert.deepEqual(errors, []);
    evidence.push({ width, theme, policy, initial }); console.log("PASS", width, theme, policy);
    await context.close();
  }
  await writeFile(`${output}/geometry.json`, JSON.stringify(evidence, null, 2));
} finally { await browser.close(); await vite.close(); }
