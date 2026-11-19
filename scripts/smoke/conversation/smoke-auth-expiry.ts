import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { createWorkbenchWebConfig } from "../../../apps/workbench-web/vite.config";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/auth-expiry-smoke";
await mkdir(output, { recursive: true });
const hosts = JSON.stringify([
  { hostId: "opencraft-server", label: "Recovery fixture", kind: "local", url: "/appserver" },
]);
const common = createWorkbenchWebConfig(
  { mode: "development", command: "serve" },
  { hyperNode: false, builtinAgents: false },
);
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: "node_modules/.vite-auth-expiry",
  optimizeDeps: {
    ...common.optimizeDeps,
    include: [
      ...(common.optimizeDeps?.include ?? []),
      "@opencraft/browser-core/presentation",
      "@opencraft/browser-core/metadata-sync",
      "@opencraft/browser-core/metadata-merge",
    ],
  },
  define: {
    "process.env.NEXT_PUBLIC_REGION": '"cn"',
    "process.env.NEXT_PUBLIC_PREVIEW_LOCALES": '""',
    "import.meta.env.VITE_INCLUDE_HYPERNODE_PLUGIN": '"false"',
    "import.meta.env.VITE_INCLUDE_BUILTIN_AGENTS_PLUGIN": '"false"',
    "import.meta.env.VITE_INCLUDE_HEADLESS_APPHOST": '"true"',
    "import.meta.env.VITE_APPSERVER_HOSTS_JSON": JSON.stringify(hosts),
  },
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "auth-expiry-workbench",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/auth-expiry-workbench.tsx"></script></body></html>',
            );
          } else next();
        });
      },
    },
  ],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const rows: unknown[] = [];
  for (const width of [390, 1280])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: width === 390,
        isMobile: width === 390,
      });
      let authenticated = true,
        allocations = 0;
      const wires = new Set<any>();
      await context.route("**/__opencraft*/**", async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/__opencraft_access/admission")
          await route.fulfill({
            status: authenticated ? 204 : 401,
            body: authenticated ? "" : '{"error":"authentication_required"}',
            contentType: "application/json",
          });
        else await route.fulfill({ status: 404, body: "{}" });
      });
      await context.routeWebSocket("**/apphost?*", (wire: any) => {
        allocations++;
        wires.add(wire);
        wire.onMessage((raw: string) => {
          const frame = JSON.parse(raw);
          if (frame.type === "hello")
            wire.send(
              JSON.stringify({
                type: "ready",
                protocolVersion: 2,
                services: ["appserver"],
                capabilities: { connectionProbe: true },
              }),
            );
          else if (frame.requestId) {
            wire.send(
              JSON.stringify({
                type: "response",
                requestId: frame.requestId,
                ok: true,
                result: frame.type === "host/connect" ? { hostId: frame.hostId, generation: 1 } : null,
              }),
            );
            if (frame.type !== "host/send") return;
            const request = JSON.parse(frame.frame);
            if (request.id === undefined) return;
            const result =
              request.method === "initialize"
                ? { codexHome: "/synthetic", platformFamily: "unix", platformOs: "linux", userAgent: "auth-smoke" }
                : request.method.endsWith("/list")
                  ? { data: [], nextCursor: null }
                  : undefined;
            const reply =
              result === undefined
                ? { id: request.id, error: { code: -32601, message: "Unsupported synthetic engine method" } }
                : { id: request.id, result };
            wire.send(
              JSON.stringify({
                type: "host/frame",
                hostId: frame.hostId,
                generation: frame.generation,
                frame: JSON.stringify(reply),
              }),
            );
          }
        });
      });
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (error: Error) => {
        errors.push(error.message);
        console.error(error.stack);
      });
      await page.addInitScript("window.__name=value=>value");
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?theme=${theme}`, {
        timeout: 90_000,
      });
      try {
        await Promise.race([
          page.waitForFunction(() => (window as any).authRecovery?.snapshot().phase === "ready", undefined, {
            timeout: 60_000,
          }),
          new Promise((_, reject) => page.once("pageerror", reject)),
        ]);
      } catch (error) {
        console.error("auth smoke startup", await page.locator("body").innerText(), errors);
        await page.screenshot({ path: `${output}/startup-failure.png` });
        throw error;
      }
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.fill("Keep this unsent draft across authentication expiry");
      await page.evaluate(() => {
        (window as any).originalAuthEditor = document.querySelector('[contenteditable="true"]');
      });
      // Exercise manual fallback after this tab already attempted automatic authentication.
      await page.evaluate(() => sessionStorage.setItem("opencraft.admission-reload", "1"));
      authenticated = false;
      for (const wire of wires) wire.close({ code: 1012, reason: "synthetic session expiry" });
      try {
        await page.getByRole("button", { name: "Open sign-in", exact: true }).waitFor();
      } catch (error) {
        console.error(
          "auth smoke failure",
          await page.evaluate(() => (window as any).authRecovery.snapshot()),
          await page.locator("body").innerText(),
        );
        await page.screenshot({ path: `${output}/admission-failure.png` });
        throw error;
      }
      const count = allocations;
      await page.evaluate(() => {
        window.dispatchEvent(new Event("online"));
        window.dispatchEvent(new Event("pageshow"));
      });
      await page.waitForTimeout(1_200);
      assert.equal(allocations, count, "expired login cannot keep allocating sockets");
      assert.match(await editor.innerText(), /Keep this unsent draft/);
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[contenteditable="true"]') === (window as any).originalAuthEditor,
        ),
        true,
      );
      const currentUrl = page.url();
      // Inspect the explicit login action without navigating away or authenticating
      // a real account. The original editor and Application must remain mounted.
      await page.evaluate(() => {
        (window as any).loginOpen = [];
        window.open = ((...args: any[]) => {
          (window as any).loginOpen.push(args);
          return null;
        }) as any;
      });
      await page.getByRole("button", { name: "Open sign-in", exact: true }).click();
      assert.equal(page.url(), currentUrl);
      assert.deepEqual(await page.evaluate(() => (window as any).loginOpen[0]), [
        currentUrl,
        "_blank",
        "noopener,noreferrer",
      ]);
      await page.screenshot({ path: `${output}/expired-${width}-${theme}.png` });
      authenticated = true;
      await page.getByRole("button", { name: "Retry connection", exact: true }).click();
      await page.waitForFunction(() => (window as any).authRecovery.snapshot().phase === "ready");
      assert.match(await editor.innerText(), /Keep this unsent draft/);
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[contenteditable="true"]') === (window as any).originalAuthEditor,
        ),
        true,
      );
      assert.equal(await page.getByRole("button", { name: "Open sign-in", exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      rows.push({ width, theme, touch: width === 390, preservedEditor: true, stoppedRetry: true, recovered: true });
      await context.close();
    }
  await writeFile(`${output}/results.json`, JSON.stringify(rows, null, 2));
  console.log(JSON.stringify({ passed: true, output, scenarios: rows.length }));
} finally {
  await browser?.close();
  await vite.close();
}
