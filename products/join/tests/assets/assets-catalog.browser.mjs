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
const evidence = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [390, 1440])
    for (const skin of ["opencraft.core.porcelain", "opencraft.core.frost"])
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          hasTouch: width < 600,
          isMobile: width < 600,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(30000);
        await page.goto(
          "http://127.0.0.1:" +
            server.httpServer.address().port +
            "/?theme=" +
            theme,
        );
        await page.waitForFunction(() => window.assetsFixture?.registration);
        await page.evaluate(
          ({ skin, theme }) => {
            window.catalogTheme.skin(skin);
            window.catalogTheme.mode(theme);
            const doc = window.assetsFixture.snapshot;
            doc.credentials.push({
              id: "e2b-example",
              name: "E2B 工作空间",
              apiUrl: "https://api.e2b.dev",
              sandboxUrl: "https://e2b.dev",
              generation: "fixture",
            });
            doc.environments.push(
              {
                id: "dev",
                name: "开发环境",
                templateId: "dev-workspace",
                credentialId: "e2b-example",
              },
              {
                id: "automation",
                name: "自动化环境",
                templateId: "automation",
                credentialId: "e2b-example",
              },
            );
            window.navigationProbe.openExtensionView(
              "tencentoa.identity.assets",
            );
          },
          { skin, theme },
        );
        const live = page.locator(".page-stack__live");
        await live
          .getByRole("button", { name: "管理 开发环境", exact: true })
          .waitFor();
        if (width === 1440)
          await page
            .getByRole("button", { name: /侧栏|侧边栏|sidebar/i })
            .first()
            .click();
        assert.equal(
          await live
            .getByRole("radio", { name: "环境", exact: true })
            .getAttribute("aria-checked"),
          "true",
        );
        assert.equal(
          await live.getByRole("radio", { name: "数据", exact: true }).count(),
          0,
        );
        const geometry = await live
          .locator(".join-assets")
          .evaluate((el) => ({
            overflow: el.scrollWidth > el.clientWidth + 1,
            background: getComputedStyle(el).backgroundColor,
            foreground: getComputedStyle(el).color,
            token: getComputedStyle(el)
              .getPropertyValue("--width-collection-document-max")
              .trim(),
          }));
        assert.equal(geometry.overflow, false);
        assert.ok(geometry.token);
        assert.notEqual(geometry.background, geometry.foreground);
        const image = width + "-" + skin.split(".").at(-1) + "-" + theme;
        await page.screenshot({ path: task + image + ".png" });
        // Existing keyboard category owner; focus and draft survive theme and capacity changes.
        await live.getByRole("radio", { name: "环境", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
        await live
          .getByRole("button", { name: "管理 E2B 工作空间", exact: true })
          .waitFor();
        await live.getByRole("radio", { name: "环境", exact: true }).click();
        const add = page.getByRole("button", { name: "添加环境", exact: true });
        if (width < 600) await add.tap();
        else await add.click();
        const name = live.getByRole("textbox", { name: "名称", exact: true });
        await name.fill("未保存的主题测试");
        await name.evaluate((el) => (el.dataset.continuity = "same"));
        await page.evaluate(() =>
          window.catalogTheme.mode(
            document.documentElement.dataset.theme === "dark"
              ? "light"
              : "dark",
          ),
        );
        await page.setViewportSize({
          width: width === 390 ? 430 : 1000,
          height: 900,
        });
        assert.equal(await name.inputValue(), "未保存的主题测试");
        assert.equal(await name.getAttribute("data-continuity"), "same");
        assert.equal(await page.evaluate(() => window.assetsFixture.posts), 0);
        if (width === 390 && skin.endsWith("porcelain") && theme === "light") {
      await live.getByRole("button", { name: "返回列表", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "放弃修改", exact: true }).click();
      await page.evaluate(() => {
        window.assetsFixture.snapshot.environments = [];
        window.assetsFixture.enablePlatform(); window.assetsFixture.member();
        window.assetsFixture.publicSnapshot.environments.push({id:"shared",name:"用于跨团队自动化任务与长期项目开发的共享环境",templateId:"shared-template-with-a-long-readable-name",credentialId:"hidden"});
      });
      await page.getByRole("button", {name:"刷新",exact:true}).click();
      await live.getByText("用于跨团队自动化任务与长期项目开发的共享环境",{exact:true}).waitFor();
      const personal=live.getByRole("region", {name:"我的环境",exact:true});
      assert.equal(await personal.locator('.settings-control-group').getAttribute('data-appearance'), 'plain');
      assert.equal(await live.locator('.join-assets').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
      await page.screenshot({path:task+'catalog-long-platform-only.png'});
      await page.evaluate(() => {
        window.assetsFixture.snapshot.environments=Array.from({length:7},(_,i)=>({id:'search-'+i,name:'环境 '+i,templateId:'template-'+i,credentialId:'e2b-example'}));
      });
      await page.getByRole("button", {name:"刷新",exact:true}).click();
      const search=live.getByRole('textbox',{name:'按名称查找',exact:true});await search.fill('not-found');
      await live.getByText('没有匹配的项目。',{exact:true}).filter({visible:true}).waitFor();
      await live.getByRole('button',{name:'清除筛选',exact:true}).click();
      assert.equal(await search.inputValue(),'');
      await live.getByRole('button',{name:'管理 环境 6',exact:true}).waitFor();
    }
    assert.deepEqual(errors, []);
        evidence.push({ width, skin, theme, geometry, draftPreserved: true });
        await context.close();
      }
  fs.writeFileSync(
    task + "catalog-evidence.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  await server.close();
}
