import assert from "node:assert/strict";
import test from "node:test";

test("mobile member bootstrap keeps optional authorization failures out of Vite release recovery", { timeout: 120_000 }, async () => {
  const { build } = await import("vite");
  const { chromium } = await import("playwright");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, extname, resolve } = await import("node:path");
  const { createServer } = await import("node:http");
  const root = await mkdtemp(join(tmpdir(), "model-policy-bootstrap-"));
  const html = await readFile("apps/workbench-web/index.html", "utf8");
  const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]).find(s => s.includes("isResizeObserverDeliveryWarning"))!;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    for (const broken of [false, true]) {
      const outDir = join(root, broken ? "before" : "after");
      await build({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
        build: { outDir, emptyOutDir: true, minify: false, rollupOptions: { input: "optional-probe-entry", output: { entryFileNames: "entry.js" } } },
        plugins: [{ name: "optional-probe-fixture", enforce: "pre", resolveId(id) { return id === "optional-probe-entry" ? "\0optional-probe-entry" : null; },
          load(id) { if (id !== "\0optional-probe-entry") return null; return `
            import {ExtensionSupervisor} from ${JSON.stringify(resolve("packages/extension-runtime/src/index.ts"))};
            import {createHeadlessModelServicesExtension} from ${JSON.stringify(resolve("plugins/builtin-agents/src/index.ts"))};
            const supervisor=new ExtensionSupervisor({platform:'web',internalContributions:{platformViewRenderer:{prepare(){return {commit:()=>()=>{}};}}}});
            await supervisor.activate(createHeadlessModelServicesExtension({hostId:'fixture',requestHost:async()=>({data:[]}),fetcher:()=>fetch('/probe'+location.search)}));
            const pages=supervisor.contributions.getSnapshot().settingsPages.map(p=>p.contribution.id);
            document.body.dataset.pages=JSON.stringify(pages);document.body.dataset.ready='true';`;
          },
          transform(code, id) { if (broken && id.endsWith("/plugins/builtin-agents/src/index.ts")) return code.replace(".readModelPolicy(options.fetcher).catch(()=>null)", ".readModelPolicy(options.fetcher)"); },
        }],
      });
      let mode = "403";
      const server = createServer(async (req, res) => {
        if (req.url?.startsWith("/probe")) {
          if (mode === "network") { req.socket.destroy(); return; }
          res.writeHead(mode === "member" || mode === "admin" ? 200 : Number(mode), { "content-type": "application/json" });
          res.end(JSON.stringify({ canManage: mode === "admin", revision: 0, rules: [] })); return;
        }
        if (req.url === "/") {
          res.setHeader("content-type", "text/html");res.end(`<html><head><meta name="opencraft-build-id" content="fixture"></head><body><script>window.preloadErrors=[];addEventListener('vite:preloadError',e=>window.preloadErrors.push(e.payload.message));</script><script>${bootstrap}</script><script type="module" src="/entry.js"></script></body></html>`);return;
        }
        try { const file = join(outDir, new URL(req.url!, "http://fixture").pathname);res.setHeader("content-type", extname(file) === ".js" ? "text/javascript" : "text/css");res.end(await readFile(file)); }
        catch { res.writeHead(404);res.end(); }
      });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      try {
        for (mode of broken ? ["403"] : ["member", "401", "403", "404", "network", "admin"]) {
          const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
          try {
            await page.goto(`http://127.0.0.1:${(server.address() as any).port}/`);
            await page.waitForSelector('body[data-ready="true"]');
            const errors = await page.evaluate(() => (window as any).preloadErrors as string[]);
            if (broken) { assert.ok(errors.includes("Unable to load model restrictions"), "negative control must reproduce the production preload failure"); await page.locator("[data-recovery-title]").waitFor(); }
            else {
              assert.deepEqual(errors, [], mode);
              const pages = JSON.parse(await page.locator("body").getAttribute("data-pages") ?? "[]");
              assert.equal(pages.includes("opencraft.headless-model-services.policy"), mode === "admin", mode);
              assert.ok(pages.includes("opencraft.headless-model-services"), "ordinary settings must finish registration");
              assert.equal(await page.locator("[data-recovery-title]").count(), 0, mode);
            }
          } finally { await page.close(); }
        }
      } finally { await new Promise<void>(done => server.close(() => done())); }
    }
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
