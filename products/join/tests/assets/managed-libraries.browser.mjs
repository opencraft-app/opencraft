import fs from "node:fs";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const task =
    process.env.OPENCRAFT_SYNC_UI_OUTPUT ??
    process.cwd() + "/.local/assets-evidence/",
  root = process.cwd();
fs.mkdirSync(task, { recursive: true });
const { createServer } = await import(
  pathToFileURL(root + "/node_modules/vite/dist/node/index.js")
);
const { chromium } = await import(
  pathToFileURL(root + "/node_modules/playwright/index.mjs")
);
import { assetsShellSource as baseSource } from "./assets-shell.fixture.mjs";
const source = baseSource
  .replace(
    "import{initializeAppearanceTheme,setThemePreference}",
    "import{initializeAppearanceTheme,setThemePreference,setAppearanceThemeId}",
  )
  .replace(
    "inputRuntime.start();",
    "inputRuntime.start();window.catalogTheme={mode:setThemePreference,skin:setAppearanceThemeId};",
  );
const server = await createServer({
  root,
  configFile: false,
  cacheDir: task + "vite",
  publicDir: root + "/apps/workbench-web/public",
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  optimizeDeps: {
    include: [
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-model",
      "prosemirror-transform",
      "prosemirror-commands",
      "prosemirror-history",
      "prosemirror-keymap",
      "prosemirror-inputrules",
      "prosemirror-schema-list",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@dnd-kit/utilities",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "motion/react",
      "framer-motion",
      "@tanstack/react-query",
      "react-intl",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-alert-dialog",
      "tslib",
    ],
  },
  plugins: [
    {
      name: "navigation-probe",
      resolveId: (id) => (id === "/navigation-probe.tsx" ? id : null),
      load: (id) => (id === "/navigation-probe.tsx" ? source : null),
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (
            req.url?.startsWith("/@") ||
            req.url?.startsWith("/node_modules") ||
            req.url?.startsWith("/apps/") ||
            req.url?.startsWith("/packages/") ||
            req.url?.startsWith("/plugins/") ||
            req.url?.startsWith("/navigation-probe.tsx") ||
            req.url?.startsWith("/products/")
          )
            return next();
          if (req.headers.accept?.includes("text/html")) {
            res.setHeader("content-type", "text/html");
            res.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/navigation-probe.tsx"></script>',
            );
          } else next();
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: width < 600,
      isMobile: width < 600,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      "http://127.0.0.1:" + server.httpServer.address().port + "/?theme=light",
      { waitUntil: "networkidle" },
    );
    await page.waitForFunction(() => !!window.assetsFixture?.registration);
    await page.evaluate(() => {
      const f = window.assetsFixture;
      f.enablePlatform();
      f.member();
      f.publicSnapshot.environments = [
        {
          id: "library-environment",
          name: "浏览器开发环境",
          templateId: "browser-template",
          credentialId: "hidden",
        },
      ];
      Object.assign(f.snapshot, {
        libraryRevision: 1,
        libraries: [
          {
            id: "beijing-nfs",
            name: "北京共享资料库",
            kind: "nfs",
            managedBy: "e2b",
            source: "platform",
            mountPath: "/shared",
            environmentIds: ["library-environment"],
            status: "configured",
            verifiedAt: "2026-11-18T00:00:00.000Z",
          },
        ],
      });
      window.navigationProbe.openExtensionView("tencentoa.identity.assets");
    });
    // The actual Assets view and actual shell are mounted by the shared fixture.
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    const tab = page.getByRole("radio", { name: "资料库", exact: true });
    await tab.waitFor();
    if (width < 600) await tab.tap();
    else await tab.click();
    const row = page.getByRole("button", { name: /北京共享资料库/ });
    await row.waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "添加连接", exact: true })
        .isVisible(),
      false,
    );
    await page.getByText("北京共享资料库 · 接入详情", { exact: true }).click();
    await page
      .getByText(
        "目前供运行在上述 E2B 环境中的助理使用；本机普通会话尚未接入此挂载。",
        { exact: true },
      )
      .waitFor();
    await page.screenshot({
      path: task + "/library-" + width + ".png",
      fullPage: true,
    });
    await row.click();
    assert.equal(
      await page
        .getByRole("radio", { name: "环境", exact: true })
        .getAttribute("aria-checked"),
      "true",
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("managed-library-browser: passed");
} finally {
  await browser?.close();
  await server.close();
}
