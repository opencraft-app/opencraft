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
const { assetsShellSource: source } = await import(
  pathToFileURL(root + "/products/join/tests/assets/assets-shell.fixture.mjs")
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
  for (const width of [320, 390, 1200])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width < 600,
        hasTouch: width < 600,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const init = async () => {
        await page.goto(
          "http://127.0.0.1:" +
            server.httpServer.address().port +
            "/?theme=" +
            theme,
        );
        await page.waitForFunction(
          () => typeof window.assetsFixture?.registration === "function",
          undefined,
          { timeout: 60000 },
        );
        await page.evaluate(() =>
          window.navigationProbe.openExtensionView("tencentoa.identity.assets"),
        );
      };
      const live = page.locator(".page-stack__live");
      const b = async (name, where = page) => {
        const el = where.getByRole("button", { name, exact: true });
        await el.waitFor();
        await page.waitForFunction(
          (el) => !el.disabled,
          await el.elementHandle(),
        );
        if (width < 600) await el.tap();
        else {
          await el.focus();
          await page.keyboard.press("Enter");
        }
      };
      const field = (name) =>
        live.getByRole("textbox", { name, exact: true, includeHidden: true });
      const dialog = () => page.getByRole("alertdialog");
      const connection = async (provider) => {
        await live.getByRole("radio", { name: "连接", exact: true }).click();
        await b("添加连接");
        await b("选择 " + provider);
      };
      await init();
      await connection("E2B");
      await field("名称").fill("Unsaved draft");
      await live.getByLabel("访问密钥", { exact: true }).fill("fixture-secret");
      await page.evaluate(() => window.navigationProbe.openChat());
      await dialog().waitFor();
      assert.equal(await field("名称").inputValue(), "Unsaved draft");
      await b("继续编辑", dialog());
      await field("名称").waitFor();
      assert.equal(await field("名称").inputValue(), "Unsaved draft");
      await page.evaluate(() => window.history.back());
      await dialog().waitFor();
      await b("继续编辑", dialog());
      assert.equal(await field("名称").inputValue(), "Unsaved draft");
      await page.evaluate(() => window.assetsFixture.failRead());
      await b("刷新");
      await live
        .getByText(/^暂时无法读取云端环境和 E2B 连接/)
        .filter({ visible: true })
        .waitFor();
      assert.equal(
        await live
          .getByText(/^暂时无法读取云端环境和 E2B 连接/)
          .filter({ visible: true })
          .count(),
        1,
      );
      await page.evaluate(() => window.navigationProbe.openChat());
      await dialog().waitFor();
      await b("放弃修改", dialog());
      await page.waitForFunction(
        () =>
          window.navigationProbe.getSnapshot().applicationRoute.kind ===
          "conversation",
      );
      await page.evaluate(() => window.navigationProbe.back());
      await live.getByRole("radio", { name: "连接", exact: true }).waitFor();
      assert.equal(await field("名称").count(), 0);
      await init();
      await connection("工蜂");
      await field("账号").fill("local-user");
      await b("保存连接");
      await live.getByText("已保存。", { exact: true }).waitFor();
      await field("提交姓名").fill("Local edit");
      await page.evaluate(() => window.assetsFixture.advanceGit());
      await b("保存连接");
      await live
        .getByText("配置已被其他操作更新。请加载最新配置后再编辑。", {
          exact: true,
        })
        .waitFor();
      await b("加载最新配置");
      await b("取消", dialog());
      assert.equal(await field("提交姓名").inputValue(), "Local edit");
      await b("加载最新配置");
      await page.evaluate(() => window.assetsFixture.gitReadFailure(true));
      await b("加载最新配置", dialog());
      await dialog().getByRole("alert").waitFor();
      assert.equal(await field("提交姓名").inputValue(), "Local edit");
      await page.evaluate(() => window.assetsFixture.gitReadFailure(false));
      await b("加载最新配置", dialog());
      await page.waitForFunction(
        () => !document.querySelector("[role=alertdialog]"),
      );
      assert.equal(await field("提交姓名").inputValue(), "Remote");
      await page.waitForFunction(el => document.activeElement === el, await field("账号").elementHandle());
      await field("提交姓名").fill("Reviewed edit");
      await b("保存连接");
      await live.getByText("已保存。", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            window.assetsFixture.gitSnapshot.hosts["git.woa.com"].identity.name,
        ),
        "Reviewed edit",
      );
      await live
        .getByLabel("工具访问令牌", { exact: true })
        .fill("tai_fixture");
      await b("保存连接");
      await live.getByText("已保存。", { exact: true }).waitFor();
      await live
        .locator("summary")
        .filter({ hasText: /^更多设置$/ })
        .filter({ visible: true })
        .click();
      await b("解除绑定");
      await page.evaluate(() => window.assetsFixture.failMcp());
      await b("确认删除", dialog());
      await dialog().getByRole("alert").waitFor();
      await dialog()
        .getByText("提交身份及本地密钥已移除。", { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => window.assetsFixture.gitSnapshot.gongfengMcp.configured,
        ),
        true,
      );
      const clears = await page.evaluate(
        () =>
          window.assetsFixture.gitActions.filter((a) => a === "clear").length,
      );
      await page.screenshot({
        path: task + "unbind-recovery-" + width + "-" + theme + ".png",
      });
      await b("确认删除", dialog());
      await page.waitForFunction(
        () => !document.querySelector("[role=alertdialog]"),
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.assetsFixture.gitActions.filter((a) => a === "clear").length,
        ),
        clears,
      );
      assert.equal(
        await page.evaluate(
          () => window.assetsFixture.gitSnapshot.gongfengMcp.configured,
        ),
        false,
      );
      // An account switch retires the pending navigation and all old-account drafts.
      await field("账号").fill("old-account-draft");
      await page.evaluate(() => window.navigationProbe.openChat());
      await dialog().waitFor();
      await page.evaluate(() => window.assetsFixture.switchAccount());
      await page.waitForFunction(
        () => !document.querySelector("[role=alertdialog]"),
      );
      assert.equal(await field("账号").count(), 0);
      assert.equal(
        await page.evaluate(
          () => window.navigationProbe.getSnapshot().applicationRoute.kind,
        ),
        "extension-view",
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          width,
          theme,
          routeLeaveGuard: true,
          browserBackCancel: true,
          confirmedLeave: true,
          visibleReadFailure: true,
          conflictRecovery: true,
          failedReloadKeepsDraft: true,
          partialUnbindRetry: true,
          accountRetiresPendingNavigation: true,
        }),
      );
      await context.close();
    }
} finally {
  await browser?.close();
  await server.close();
}
