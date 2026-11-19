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
let browser, activePage, activeErrors;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [320, 390, 1200])
    for (const theme of ["light", "dark"]) {
      const touch = width < 600,
        context = await browser.newContext({
          viewport: { width, height: 844 },
          hasTouch: touch,
          isMobile: touch,
        }),
        page = await context.newPage(),
        errors = [];
      activePage = page;
      activeErrors = errors;
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(60000);
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (message) => {
        if (message.type() === "error")
          console.error("Assets fixture console:", message.text());
      });
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
      const registration = await page.evaluate(() =>
        window.assetsFixture.registration(),
      );
      assert.equal(registration.extension?.status, "active");
      for (const id of [
        "tencentoa.identity.assets",
        "tencentoa.identity.assets.entry",
      ]) {
        const view = registration.views.find((view) => view.id === id);
        assert.ok(view, `Real TencentOA activation must register ${id}`);
        assert.equal(view.owner, "tencentoa.identity");
        assert.equal(view.hasRenderer, true);
        if (id === "tencentoa.identity.assets")
          assert.equal(view.keepConversationSidebar, true);
      }
      const catalog = registration.catalogs.find(
        (catalog) => catalog.id === "tencentoa.identity.assets.catalog",
      );
      assert.ok(
        catalog,
        "Real TencentOA activation must register the Assets catalog",
      );
      assert.equal(catalog.owner, "tencentoa.identity");
      assert.equal(catalog.viewId, "tencentoa.identity.assets.entry");
      assert.equal(catalog.presentation, "entry");
      // Identity mounts only identity/SSH ingress, not either Git editor or its reads.
      const live = page.locator(".page-stack__live");
      const disclosure = async (name) => {
        const target = live
          .locator("summary")
          .filter({ hasText: new RegExp("^" + name + "$") })
          .filter({ visible: true });
        if (touch) await target.tap();
        else {
          await target.focus();
          await page.keyboard.press("Enter");
        }
      };
      assert.equal(await page.evaluate(() => window.assetsFixture.sshReads), 0);
      const developerPage = registration.settingsPages.find(item => item.id === "tencentoa.identity.employee");
      assert.equal(developerPage.titleMessage.id, "ioa.identity.developerOptions");
      await page.evaluate(() => window.navigationProbe.openExtensionView("tencentoa.identity.employee-view"));
      await live.getByRole("heading", { name: "开发者选项", exact: true }).waitFor();
      await live.getByRole("button", { name: "显示私钥", exact: true }).waitFor();
      assert.ok((await page.evaluate(() => window.assetsFixture.sshReads)) > 0);
      assert.equal(await live.locator("pre").count(), 0);
      assert.doesNotMatch(await live.innerText(), /当前账号|管理连接|OPENSSH/);
      assert.equal(await live.locator('input[type="password"]').count(), 0);
      assert.equal(await page.evaluate(() => window.assetsFixture.gitReads), 0);
      await page.screenshot({ path: task + "developer-ssh-" + width + "-" + theme + ".png" });
      const reveal = live.getByRole("button", { name: "显示私钥", exact: true });
      if (touch) await reveal.tap();
      else { await reveal.focus(); await page.keyboard.press("Enter"); }
      await live.locator("pre").filter({ hasText: "fixture-private-material" }).waitFor();
      await live.getByRole("button", { name: "隐藏私钥", exact: true }).click();
      assert.equal(await live.locator("pre").count(), 0);
      await live.getByRole("button", { name: "重新生成密钥", exact: true }).click();
      await live.getByRole("button", { name: "确认重新生成", exact: true }).waitFor();
      await live.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await live.getByRole("button", { name: "确认重新生成", exact: true }).count(), 0);
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(geometry.scroll <= geometry.width + 1, "SSH page must not overflow horizontally");
      if (process.env.OPENCRAFT_SSH_ONLY === "1") {
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({width,theme,touch,sshDirectEntry:true,privateKeyExplicitReveal:true,regenerationConfirmation:true}));
        await context.close();
        continue;
      }
      // Exercise the direct Assets connection ingress.
      await page.evaluate(() => window.navigationProbe.openExtensionView("tencentoa.identity.assets", "connections"));
      await live
        .getByRole("radio", { name: "连接", exact: true, checked: true })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            window.navigationProbe.getSnapshot().applicationRoute.resourceUri,
        ),
        "connections",
      );
      assert.doesNotMatch(
        await live.innerText(),
        /https?:|git\.woa\.com|MCP|SSH|VFS/,
      );
      await page.screenshot({
        path: task + "connections-default-" + width + "-" + theme + ".png",
      });
      assert.equal(await live.getByRole("textbox", { name: "按名称查找", exact: true }).count(), 0);
      assert.equal(await live.getByRole("button", { name: "管理 GitHub", exact: true }).count(), 0);
      const emptyAccountAction = live.getByRole("button", { name: "添加账号", exact: true });
      if (touch) await emptyAccountAction.tap();
      else { await emptyAccountAction.focus(); await page.keyboard.press("Enter"); }
      await page.getByRole("dialog", { name: "选择服务类型", exact: true }).waitFor();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await emptyAccountAction.evaluate(el => el === document.activeElement), true);
      await page.getByRole("button", { name: "添加连接", exact: true }).click();
      await page.getByRole("dialog", { name: "选择服务类型", exact: true }).waitFor();
      await page.getByRole("dialog", { name: "选择服务类型", exact: true }).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
      await page.screenshot({ path: task + "native-provider-picker-" + width + "-" + theme + ".png" });
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "添加连接", exact: true }).evaluate(el => el === document.activeElement), true);
      await page.getByRole("button", { name: "添加连接", exact: true }).click();
      const manageGithub = page.getByRole("button", {
        name: "选择 GitHub",
        exact: true,
      });
      if (touch) await manageGithub.tap();
      else {
        await manageGithub.focus();
        await page.keyboard.press("Enter");
      }
      await live
        .getByRole("heading", { name: "GitHub 连接", exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const editor = document.querySelector('.page-stack__live .join-assets__editor:not([hidden])');
        return editor?.contains(document.activeElement) && document.activeElement?.tagName === 'BUTTON';
      });
      assert.doesNotMatch(
        await live.innerText(),
        /github\.com|签名指纹|签名公钥|SSH/,
      );
      await live.getByRole("heading", { name: "账号信息", exact: true }).waitFor();
      await live.getByRole("heading", { name: "访问凭据", exact: true }).waitFor();
      await page.screenshot({ path: task + "grouped-github-editor-" + width + "-" + theme + ".png" });
      const accountInput = live.getByRole("textbox", {
        name: "账号",
        exact: true,
      });
      await accountInput.evaluate((el) => {
        window.originalGitInput = el;
      });
      await disclosure("更多设置");
      await live.getByText("提交验证", { exact: true }).waitFor();
      await disclosure("更多设置");
      assert.equal(
        await accountInput.evaluate((el) => el === window.originalGitInput),
        true,
      );
      assert.equal(
        await live
          .getByRole("heading", { name: "工蜂连接", exact: true })
          .count(),
        0,
      );
      await live
        .getByRole("textbox", { name: "账号", exact: true })
        .fill("github-user");
      await live
        .getByRole("textbox", { name: "提交姓名", exact: true })
        .fill("GitHub User");
      await live
        .getByRole("textbox", { name: "提交邮箱", exact: true })
        .fill("github-user@example.com");
      await live
        .getByLabel("个人访问令牌", { exact: true })
        .fill("fixture-github-token");
      const saveGithub = live.getByRole("button", {
        name: "保存连接",
        exact: true,
      });
      if (touch) await saveGithub.tap();
      else {
        await saveGithub.focus();
        await page.keyboard.press("Enter");
      }
      await page.waitForFunction(
        () =>
          window.assetsFixture.gitSnapshot.hosts["github.com"].identity
            ?.username === "github-user",
      );
      assert.equal(
        await page.evaluate(
          () => window.assetsFixture.gitSnapshot.hosts["git.woa.com"].revision,
        ),
        0,
      );
      await page.waitForFunction(
        () =>
          !document.querySelector('.page-stack__live input[type="password"]')
            ?.value,
      );
      assert.equal(
        JSON.stringify(
          await page.evaluate(() => window.assetsFixture.gitSnapshot),
        ).includes("fixture-github-token"),
        false,
      );
      await page.screenshot({
        path: task + "github-" + width + "-" + theme + ".png",
      });
      await page.evaluate(() => window.navigationProbe.openChat());
      // The ordinary sidebar entrance still opens Environments, not the migrated deep link.
      const entry = page
        .locator('[data-catalog-presentation="entry"]')
        .getByRole("button", { name: "资产", exact: true });
      if (!(await entry.isVisible())) {
        await page
          .getByRole("button", { name: /侧栏|侧边栏|sidebar/i })
          .first()
          .click();
      }
      await page.screenshot({
        path: task + "sidebar-" + width + "-" + theme + ".png",
      });
      assert.ok(await page.locator('svg[data-section="assets"]').evaluate(el => parseFloat(getComputedStyle(el).width) > 0));
      assert.equal(
        await page
          .locator('svg[data-section="assets"]')
          .evaluate((el) => getComputedStyle(el).strokeWidth),
        "1.5px",
      );
      await entry.click();
      assert.equal(
        await page.evaluate(
          () => window.navigationProbe.getSnapshot().applicationRoute.viewId,
        ),
        "tencentoa.identity.assets",
      );
      await page.getByRole("heading", { name: "资产", exact: true }).waitFor();
      await live.getByRole("radio", { name: "环境", exact: true }).waitFor();
      assert.equal(await live.getByRole("button", { name: "管理助理记忆", exact: true }).count(), 0);
      assert.equal(
        await live.getByRole("radio", { name: "凭据库", exact: true }).count(),
        0,
      );
      const tab = async (name) => {
        const choice = live.getByRole("radio", { name, exact: true });
        if (touch) await choice.tap();
        else await choice.click();
      };
      const button = async (name, container = page) => {
        const target = container.getByRole("button", { name, exact: true });
        // Keyboard focus does not auto-wait for refresh to re-enable a control.
        // Do not send Enter to the previously focused button while this one is busy.
        await page.waitForFunction(el => !el.disabled, await target.elementHandle());
        if (touch) await target.tap();
        else {
          await target.focus();
          await page.keyboard.press("Enter");
        }
      };
      const field = (name) => live.getByRole("textbox", { name, exact: true });
      const confirm = () => page.getByRole("alertdialog");
      await live
        .getByRole("heading", { name: "平台提供", exact: true })
        .waitFor();
      assert.equal(await page.locator(".join-assets").getByRole("heading", { name: "资产", exact: true }).count(), 1,
        "One document title follows the same reading axis as the catalog");
      assert.equal(await live.locator('.settings-collection-row').getByRole('button').count(), 0,
        "destination rows must not nest action buttons");
      await page.screenshot({
        path: task + "catalog-default-" + width + "-" + theme + ".png",
      });
      await tab("环境");
      await live
        .getByRole("heading", { name: "平台提供", exact: true })
        .waitFor();
      await live.getByText("当前服务器", { exact: true }).waitFor();
      await live
        .getByText(
          "保存后，在助理设置中选用此环境；不会立即启动。",
          { exact: true },
        )
        .waitFor();
      assert.equal(
        await live
          .getByText("还没有云端环境。", { exact: true })
          .evaluate(
            (el) =>
              el.closest('.settings-control-group[data-appearance="card"]') !==
              null,
          ),
        false,
        "normal empty state must not nest an alert/card inside a card",
      );
      await page.screenshot({
        path: task + "plain-environments-" + width + "-" + theme + ".png",
      });
      const beforeNavigationPosts = await page.evaluate(
        () => window.assetsFixture.posts,
      );
      await button("查看助理");
      assert.equal(
        await page.evaluate(() => window.lastOpenedAssetsView),
        "opencraft.im.agents",
      );
      assert.equal(
        await page.evaluate(() => window.assetsFixture.posts),
        beforeNavigationPosts,
        "navigation must not create or apply an environment",
      );
      await page.evaluate(() =>
        window.navigationProbe.openExtensionView("tencentoa.identity.assets"),
      );
      await live
        .getByRole("heading", { name: "平台提供", exact: true })
        .waitFor();
      await tab("连接");
      await live
        .getByRole("heading", { name: "连接", exact: true })
        .waitFor();
      await live
        .getByText(
          "代码账号目前用于当前服务器。",
          { exact: true },
        )
        .waitFor();
      await page.screenshot({
        path: task + "plain-connections-" + width + "-" + theme + ".png",
      });
      await button("添加连接");
      await page
        .getByRole("button", { name: "选择 E2B", exact: true })
        .waitFor();
      const picker = page.getByRole('dialog', {name:'选择服务类型',exact:true});
      await picker.waitFor();
      await picker.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
      if (width <= 640) {
        const b=await picker.boundingBox();
        assert.ok(b && Math.abs(b.y+b.height-page.viewportSize().height)<3, 'mobile chooser must use the shared bottom sheet');
      }
      await button("选择 工蜂");
      await live
        .getByRole("heading", { name: "工蜂连接", exact: true })
        .waitFor();
      assert.equal(
        await live
          .getByRole("heading", { name: "GitHub 连接", exact: true })
          .count(),
        0,
      );
      await field("账号").fill("draftuser");
      await tab("环境");
      await button("查看助理");
      await confirm()
        .getByText("放弃未保存的修改？", { exact: true })
        .waitFor();
      await button("继续编辑", confirm());
      await button("继续编辑");
      assert.equal(
        await field("账号").inputValue(),
        "draftuser",
        "new destination must preserve the existing draft guard",
      );
      await page.evaluate(() => window.assetsFixture.advanceGit());
      await button("刷新");
      assert.equal(await field("账号").inputValue(), "draftuser");
      await button("保存连接");
      await live.getByRole("alert").filter({ hasText: "配置已被其他操作更新" }).waitFor();
      assert.equal(await field("账号").inputValue(), "draftuser");
      await tab("环境");
      await button("继续编辑");
      assert.equal(await field("账号").inputValue(), "draftuser");
      await button("返回列表");
      await confirm()
        .getByText("放弃未保存的修改？", { exact: true })
        .waitFor();
      await button("继续编辑", confirm());
      assert.equal(await field("账号").inputValue(), "draftuser");
      await button("返回列表");
      await button("放弃修改", confirm());
      await page
        .getByRole("button", { name: "添加连接", exact: true })
        .waitFor();

      // Environment-first onboarding creates its connection in context, then resumes the exact draft.
      await tab("环境");
      await button("添加云端环境");
      await live.getByRole("heading", { name: "基本信息", exact: true }).waitFor();
      await live.getByRole("heading", { name: "创建方式", exact: true }).waitFor();
      await field("名称").fill("开发环境");
      await field("环境模板").fill("template-one");
      await live
        .getByText("用于创建云端环境并承担使用费用，不是代码仓库账号。", {
          exact: true,
        })
        .waitFor();
      await page.screenshot({
        path: task + "plain-environment-editor-" + width + "-" + theme + ".png",
      });
      await button("新建 E2B 连接");
      await live.getByText("保存只记录配置，不会测试 E2B 是否可用。", { exact: true }).waitFor();
      await live.getByRole("heading", { name: "访问凭据", exact: true }).waitFor();
      await field("名称").fill("公司 E2B");
      await live
        .getByLabel("访问密钥", { exact: true })
        .fill("fixture-secret-not-for-output");
      await page.evaluate(() => window.assetsFixture.fail());
      await button("保存并返回环境");
      await live.getByText(/^暂时无法确认操作结果/).waitFor();
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).inputValue(),
        "fixture-secret-not-for-output",
      );
      await page.evaluate(() => window.assetsFixture.denyCustom());
      await button("保存并返回环境");
      await live
        .getByText("只有实例管理员能配置自定义 E2B 服务地址。", { exact: true })
        .waitFor();
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).inputValue(),
        "fixture-secret-not-for-output",
      );
      await tab("环境");
      await button("继续编辑");
      assert.equal(await field("名称").inputValue(), "公司 E2B");
      await page.evaluate(() => {
        window.assetInput = document.querySelector('input[type="password"]');
      });
      const size = page.viewportSize();
      await page.setViewportSize({
        width: width === 1200 ? 390 : 600,
        height: 844,
      });
      assert.equal(
        await page.evaluate(
          () =>
            window.assetInput ===
            document.querySelector('input[type="password"]'),
        ),
        true,
      );
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).inputValue(),
        "fixture-secret-not-for-output",
      );
      await page.setViewportSize(size);
      await page.screenshot({
        path: task + "connection-editor-" + width + "-" + theme + ".png",
      });
      await button("保存并返回环境");
      await live
        .getByRole("heading", { name: "添加云端环境", exact: true })
        .waitFor();
      assert.equal(await field("名称").inputValue(), "开发环境");
      assert.equal(await field("环境模板").inputValue(), "template-one");
      await live
        .getByRole("button", { name: "选择 E2B 连接", exact: true })
        .getByText("公司 E2B", { exact: true })
        .waitFor();
      await button("选择 E2B 连接");
      const connectionOption = page.getByRole("menuitemradio", {
        name: "公司 E2B",
        exact: true,
      });
      if (touch) await connectionOption.tap();
      else {
        await connectionOption.focus();
        await page.keyboard.press("Enter");
      }
      await button("保存");
      assert.equal(
        await page.evaluate(() =>
          JSON.stringify(window.assetsFixture.snapshot).includes(
            "fixture-secret-not-for-output",
          ),
        ),
        false,
      );
      await live
        .getByRole("button", { name: "管理 开发环境", exact: true })
        .waitFor();
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).count(),
        0,
      );
      assert.doesNotMatch(
        await live.innerText(),
        /local-codex|Host|VFS|MCP/,
      );
      await page.screenshot({
        path: task + "environments-" + width + "-" + theme + ".png",
      });

      // Cached refresh failure retains all rows and allows an explicit recovery.
      await page.evaluate(() => window.assetsFixture.failRead());
      await button("刷新");
      await live.getByText(/^暂时无法读取云端环境和 E2B 连接/).filter({visible:true}).waitFor();
      await live
        .getByRole("button", { name: "管理 开发环境", exact: true })
        .waitFor();
      await page.evaluate(() => window.assetsFixture.restoreRead());
      await button("刷新");
      await tab("连接");
      await button("管理 公司 E2B");
      // Service address disclosure preserves custom fields; key replacement is explicit.
      await disclosure("高级设置");
      await field("API 地址").waitFor();
      await disclosure("高级设置");
      await live
        .getByLabel("访问密钥", { exact: true })
        .fill("replacement-fixture-key");
      await button("保存");
      await confirm()
        .getByText("替换已保存的密钥？", { exact: true })
        .waitFor();
      await button("取消", confirm());
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).inputValue(),
        "replacement-fixture-key",
      );
      await button("保存");
      await button("替换密钥", confirm());
      await page
        .getByRole("button", { name: "添加连接", exact: true })
        .waitFor();
      await button("管理 公司 E2B");
      assert.equal(
        await live
          .getByRole("button", { name: "移除连接", exact: true })
          .isDisabled(),
        true,
      );
      await live
        .getByText("先修改或移除以下环境引用，才能移除此连接。", {
          exact: true,
        })
        .waitFor();
      await page.screenshot({
        path: task + "connection-usage-" + width + "-" + theme + ".png",
      });
      await button("管理");
      await button("移除环境");
      await confirm()
        .getByRole("button", { name: "取消", exact: true })
        .click();
      assert.equal(
        await live
          .getByRole("button", { name: "移除环境", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await button("移除环境");
      await button("确认移除", confirm());
      await tab("连接");
      await button("管理 公司 E2B");
      await button("移除连接");
      await button("确认移除", confirm());
      await page
        .getByRole("button", { name: "添加连接", exact: true })
        .waitFor();

      // Unknown create acknowledgment: preserve the original CAS and never rebase/replay.
      await button("添加连接");
      await button("选择 E2B");
      await field("名称").fill("回执未知");
      await live
        .getByLabel("访问密钥", { exact: true })
        .fill("another-fixture-secret");
      await page.evaluate(() => window.assetsFixture.lose());
      await button("保存");
      await live.getByText(/^暂时无法确认操作结果/).waitFor();
      await button("刷新");
      await button("保存");
      await live.getByText(/^配置已变更/).waitFor();
      assert.equal(await field("名称").inputValue(), "回执未知");
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).inputValue(),
        "another-fixture-secret",
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.assetsFixture.snapshot.credentials.filter(
              (c) => c.name === "回执未知",
            ).length,
        ),
        1,
      );
      await button("返回列表");
      await button("放弃修改", confirm());
      await field("按名称查找").fill("没有此项");
      await live
        .getByText("没有匹配的项目。", { exact: true })
        .filter({ visible: true })
        .waitFor();
      assert.equal(await live.getByRole("button", { name: "添加账号", exact: true }).count(), 0);
      await button("清除筛选");
      assert.equal(await field("按名称查找").inputValue(), "");
      await live
        .getByRole("button", { name: "管理 回执未知", exact: true })
        .waitFor();
      await page.screenshot({
        path: task + "connections-" + width + "-" + theme + ".png",
      });
      await button("管理变量");
      await live.getByRole("heading", { name: "个人凭据 ENV", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.openedSettings), undefined);
      await button("返回列表");
      // Source groups share the same editor and authorization owner.
      await page.evaluate(() => window.assetsFixture.enablePlatform());
      await button("刷新");
      await tab("环境");
      await button("添加环境");
      await field("名称").fill("平台开发环境");
      await field("环境模板").fill("platform-template");
      await button("来源");
      await page
        .getByRole("menuitemradio", { name: "平台提供", exact: true })
        .click();
      await button("新建 E2B 连接");
      assert.equal(
        await live.getByRole("button", { name: "来源", exact: true }).count(),
        0,
        "nested create inherits immutable source",
      );
      await field("名称").fill("平台 E2B");
      await live
        .getByLabel("访问密钥", { exact: true })
        .fill("platform-fixture-key");
      await button("保存并返回环境");
      await confirm().getByText("保存为平台提供？", { exact: true }).waitFor();
      await button("取消", confirm());
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).inputValue(),
        "platform-fixture-key",
      );
      await button("保存并返回环境");
      await button("确认保存", confirm());
      await live
        .getByRole("heading", { name: "添加云端环境", exact: true })
        .waitFor();
      assert.equal(await field("名称").inputValue(), "平台开发环境");
      assert.equal(await field("环境模板").inputValue(), "platform-template");
      await live
        .getByRole("button", { name: "选择 E2B 连接", exact: true })
        .getByText("平台 E2B", { exact: true })
        .waitFor();
      await button("保存");
      await button("确认保存", confirm());
      await live
        .getByRole("button", { name: "管理 平台开发环境", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => window.assetsFixture.publicSnapshot.revision),
        2,
      );
      await page.screenshot({
        path: task + "platform-environments-" + width + "-" + theme + ".png",
      });
      await tab("连接");
      await button("管理 平台 E2B");
      await live
        .getByLabel("访问密钥", { exact: true })
        .fill("clear-on-role-loss");
      await page.evaluate(() => window.assetsFixture.member());
      await button("刷新");
      await page
        .getByRole("button", { name: "添加连接", exact: true })
        .waitFor();
      assert.equal(await live.locator('input[type="password"]').count(), 0);
      assert.doesNotMatch(
        await live.innerText(),
        /平台 E2B|clear-on-role-loss/,
      );
      await tab("环境");
      await live.getByText("平台开发环境", { exact: true }).waitFor();
      assert.equal(
        await live
          .getByRole("button", { name: "管理 平台开发环境", exact: true })
          .count(),
        0,
      );
      await page.screenshot({
        path: task + "platform-member-" + width + "-" + theme + ".png",
      });
      await page.evaluate(() => window.assetsFixture.admin());
      await button("刷新");
      await tab("连接");
      await button("添加连接");
      await button("选择 E2B");
      await field("名称").fill("旧账号草稿");
      await live
        .getByLabel("访问密钥", { exact: true })
        .fill("private-draft-before-switch");
      await page.evaluate(() => window.assetsFixture.switchAccount());
      await page.waitForFunction(() =>
        document.querySelector('[data-value="environments"][aria-checked="true"]'),
      );
      await live.getByRole("radio", { name: "环境", exact: true }).waitFor();
      await tab("连接");
      assert.equal(
        await live.getByLabel("访问密钥", { exact: true }).count(),
        0,
      );
      assert.equal(
        await live.getByText("旧账号草稿", { exact: true }).count(),
        0,
      );
      assert.equal(
        await live.getByText("回执未知", { exact: true }).count(),
        0,
      );
      const dimensions = await live.evaluate((el) => ({
        scroll: el.scrollWidth,
        width: el.clientWidth,
      }));
      assert.ok(
        dimensions.scroll <= dimensions.width + 1,
        "Actual route must not horizontally overflow",
      );
      assert.equal(
        await page.evaluate(() => window.assetsFixture.deactivate()),
        true,
      );
      const retired = await page.evaluate(() =>
        window.assetsFixture.registration(),
      );
      assert.deepEqual(retired.views, []);
      assert.deepEqual(retired.catalogs, []);
      await page.waitForFunction(
        () => !document.querySelector('[data-catalog-presentation="entry"]'),
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          width,
          theme,
          actualShell: true,
          realExtensionActivation: true,
          actualSidebarEntry: true,
          consumerCopyAndOptionalTechnicalDetails: true,
          disclosureRetainsDraftNodes: true,
          connectionsDeepLink: true,
          githubSingleOwnerSave: true,
          contributionCleanup: true,
          touch,
          providerOnboarding: true,
          platformSingleCatalog: true,
          objectCatalogVisible: true,
          provisioningAndCodeAccountsDistinguished: true,
          assistantDestinationNotApply: true,
          destinationRetainsDraftGuard: true,
          platformAdminPublication: true,
          platformRoleLossClearsSecrets: true,
          environmentReturn: true,
          gitCASFenced: true,
          independentCredential: true,
          draftRetained: true,
          secretNotProjected: true,
          lostResponseNotDuplicated: true,
          accountFenced: true,
          cloud: "not-contacted",
        }),
      );
      await context.close();
    }
} catch (error) {
  if (activeErrors?.length)
    console.error("Assets fixture page errors:", activeErrors);
  await activePage?.screenshot({ path: task + "failure.png" }).catch(() => {});
  fs.writeFileSync(
    task + "failure.txt",
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
