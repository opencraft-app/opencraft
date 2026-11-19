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
import { assetsShellSource as source } from "./assets-shell.fixture.mjs";
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
let browser, activePage;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [320, 390, 1200])
    for (const theme of ["light", "dark"]) {
      const touch = width < 600;
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/?theme=${theme}`,
      );
      await page.waitForFunction(
        () => !!window.assetsFixture?.registration,
        undefined,
        { timeout: 60000 },
      );
      const registration = await page.evaluate(() => window.assetsFixture.registration());
      assert.ok(!registration.settings.includes("tencentoa.identity.environment"), "ENV is no longer a separate Settings page");
      const live = page.locator(".page-stack__live");
      const button = async (name, container = live) => {
        const b = container.getByRole("button", { name, exact: true });
        if (touch) await b.tap();
        else {
          await b.focus();
          await page.keyboard.press("Enter");
        }
      };
      const field = (name) => live.getByLabel(name, { exact: true });
      const title = () =>
        live.getByRole("heading", { name: "个人凭据 ENV", exact: true });
      const open = async () => {
        await button("管理变量");
        await title().waitFor();
        await live.getByText("还没有环境变量", { exact: true }).waitFor();
      };
      await page.evaluate(() =>
        window.navigationProbe.openExtensionView(
          "tencentoa.identity.assets",
          "connections",
        ),
      );
      await live
        .getByRole("button", { name: "管理变量", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => window.assetsFixture.envReads),
        0,
        "ENV loads only when opened",
      );
      await page.screenshot({
        path: task + `env-connections-${width}-${theme}.png`,
      });
      await open();
      assert.equal(
        await page.evaluate(() => window.openedSettings),
        undefined,
        "No Settings navigation",
      );
      assert.equal(
        await page.evaluate(
          () => window.navigationProbe.getSnapshot().applicationRoute.viewId,
        ),
        "tencentoa.identity.assets",
      );
      await button("添加变量");
      await field("名称").fill("SERVICE_KEY");
      await field("值").fill("synthetic-secret");
      assert.equal(await field("值").getAttribute("type"), "password");
      // Switching tab/presentation keeps the same draft DOM and value.
      const input = await field("值").elementHandle();
      await live.getByRole("radio", { name: "环境", exact: true }).click();
      await live.getByRole("radio", { name: "连接", exact: true }).click();
      assert.equal(await field("值").inputValue(), "synthetic-secret");
      assert.equal(await input.evaluate((el) => el.isConnected), true);
      await button("返回列表");
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await button("继续编辑", dialog);
      assert.equal(await field("值").inputValue(), "synthetic-secret");
      await page.evaluate(() => window.navigationProbe.openChat());
      await dialog.waitFor();
      await button("继续编辑", dialog);
      assert.equal(await field("值").inputValue(), "synthetic-secret");
      await page.screenshot({ path: task + `env-draft-${width}-${theme}.png` });
      await page.evaluate(() => window.assetsFixture.failEnv("reserved"));
      await button("保存");
      await live
        .getByText("该名称由平台保留，请换一个名称", { exact: true })
        .waitFor();
      assert.equal(await field("值").inputValue(), "synthetic-secret");
      await page.evaluate(() => window.assetsFixture.failEnv("conflict"));
      await button("保存");
      await live.getByRole("alert").waitFor();
      assert.equal(await field("值").inputValue(), "synthetic-secret");
      await page.screenshot({ path: task + `env-error-${width}-${theme}.png` });
      await page.evaluate(() => window.assetsFixture.delayEnv(700));
      const before = await page.evaluate(() => window.assetsFixture.envPosts);
      await button("保存");
      await page.waitForFunction(
        (n) => window.assetsFixture.envPosts === n + 1,
        before,
      );
      assert.equal(
        await live
          .getByRole("button", { name: "返回列表", exact: true })
          .isDisabled(),
        true,
      );
      await page.evaluate(() => window.navigationProbe.openChat());
      assert.equal(
        await page.getByRole("alertdialog").count(),
        0,
        "Cannot discard an in-flight write",
      );
      await page.waitForFunction(
        () =>
          !document.querySelector('.page-stack__live input[type="password"]'),
      );
      assert.equal(
        await page.evaluate(() => window.assetsFixture.envPosts),
        before + 1,
        "one explicit save",
      );
      assert.doesNotMatch(await live.innerText(), /synthetic-secret/);
      await button("修改 SERVICE_KEY");
      assert.equal(await field("值").inputValue(), "");
      await button("取消");
      // Scoped project editing and inherited secret projection reuse the same shared editor.
      await live.getByRole("combobox", { name: "作用域", exact: true }).selectOption("project-a");
      await live.getByText("INHERITED_KEY", { exact: true }).waitFor();
      await page.screenshot({
        path: task + `env-project-${width}-${theme}.png`,
      });
      await button("添加变量");
      await field("名称").fill("DISCARDED_KEY");
      await field("值").fill("discard-me");
      await button("返回列表");
      await dialog.waitFor();
      await button("放弃修改", dialog);
      await live
        .getByRole("button", { name: "管理变量", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => window.assetsFixture.envPosts),
        before + 1,
      );
      await button("管理变量");
      await title().waitFor();
      await live.getByText("SERVICE_KEY", { exact: true }).waitFor();
      // Legacy location uses the same Assets composition rather than another settings editor.
      await button("返回列表");
      await page.evaluate(() =>
        window.navigationProbe.openExtensionView(
          "tencentoa.identity.environment.view",
        ),
      );
      await title().waitFor();
      await live.getByText("SERVICE_KEY", { exact: true }).waitFor();
      await button("添加变量");
      await field("名称").fill("OLD_ACCOUNT");
      await field("值").fill("old-account-secret");
      await page.evaluate(() => window.assetsFixture.delayEnv(700));
      await button("保存");
      await page.evaluate(() => window.assetsFixture.switchAccount());
      await live.getByText("还没有环境变量", { exact: true }).waitFor();
      await page.waitForTimeout(850);
      assert.doesNotMatch(
        await live.innerText(),
        /OLD_ACCOUNT|old-account-secret|SERVICE_KEY/,
      );
      assert.equal(
        await field("值").count(),
        0,
        "Account change removes draft secrets",
      );
      const size = await live.evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth,
      }));
      assert.ok(size.scroll <= size.width + 1, "No route horizontal overflow");
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          width,
          theme,
          touch,
          inline: true,
          lazyLoad: true,
          draftGuard: true,
          pendingGuard: true,
          scopes: true,
          masked: true,
          errorsRetainDraft: true,
          legacySameUI: true,
          accountFenced: true,
        }),
      );
      await context.close();
    }
} catch (error) {
  await activePage
    ?.screenshot({ path: task + "env-failure.png" })
    .catch(() => {});
  fs.writeFileSync(
    task + "env-failure.txt",
    (await activePage
      ?.locator("body")
      .innerText()
      .catch(() => "")) ?? "",
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
