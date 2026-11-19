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
const { assetsShellSource: source } = await import(pathToFileURL(root + "/products/join/tests/assets/assets-shell.fixture.mjs"));
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
  await server.listen(); browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for(const width of [320,390,1200]) for(const theme of ['light','dark']) {
    const touch=width<600;
    const context=await browser.newContext({viewport:{width,height:844},hasTouch:touch,isMobile:touch});
    const page=await context.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(60000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?theme='+theme);
    await page.waitForFunction(()=>typeof window.assetsFixture?.registration==='function',undefined,{timeout:60000});
    await page.evaluate(()=>{window.assetsFixture.failRead();window.navigationProbe.openExtensionView('tencentoa.identity.assets')});
    const live=page.locator('.page-stack__live');
    const button=async(name,container=page)=>{const b=container.getByRole('button',{name,exact:true});await b.waitFor();await page.waitForFunction(el=>!el.disabled,await b.elementHandle());if(touch)await b.tap();else{await b.focus();await page.keyboard.press('Enter')}};
    const field=name=>live.getByRole('textbox',{name,exact:true});
    const summary=label=>live.locator('summary').filter({hasText:new RegExp('^'+label+'$')}).filter({visible:true});
    await live.getByRole('radio',{name:'连接',exact:true}).click();
    await live.getByText(/^暂时无法读取云端环境和 E2B 连接/).filter({visible:true}).waitFor();
    assert.equal(await live.getByText(/^暂时无法读取云端环境和 E2B 连接/).filter({visible:true}).count(),1);
    assert.doesNotMatch(await live.innerText(),/草稿已保留|写入/);
    await button('添加连接');
    assert.equal(await page.getByRole('button',{name:'选择 E2B',exact:true}).isDisabled(),true);
    await button('选择 工蜂');
    await field('账号').fill('recovery-user');
    await page.evaluate(()=>window.assetsFixture.delayGit(600));
    const before=await page.evaluate(()=>window.assetsFixture.gitPosts);
    await field('提交邮箱').press('Enter');
    await live.getByRole('button',{name:'保存中…',exact:true}).waitFor();
    assert.equal(await live.getByRole('button',{name:'返回列表',exact:true}).isDisabled(),true);
    assert.equal(await live.getByText('已保存。',{exact:true}).count(),0);
    await live.getByText('已保存。',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.assetsFixture.gitPosts),before+1);
    await field('提交姓名').fill('Changed name');
    assert.equal(await live.getByText('已保存。',{exact:true}).count(),0);
    await button('保存连接');await live.getByText('已保存。',{exact:true}).waitFor();
    await summary('更多设置').click();await button('解除绑定');
    await page.getByRole('alertdialog').getByText(/不会删除代码仓库/).waitFor();
    await button('取消',page.getByRole('alertdialog'));await summary('更多设置').click();
    // A successful identity write followed by a failed tools-token write is not full success.
    await live.getByLabel('工具访问令牌',{exact:true}).fill('tai_fixture');
    await page.evaluate(()=>window.assetsFixture.failMcp());
    await button('保存连接');await live.getByRole('alert').filter({hasText:'凭据服务暂时不可用'}).waitFor();
    assert.equal(await live.getByText('已保存。',{exact:true}).count(),0);
    assert.equal(await live.getByLabel('工具访问令牌',{exact:true}).inputValue(),'tai_fixture');
    await button('保存连接');await live.getByText('已保存。',{exact:true}).waitFor();
    await button('返回列表');
    // E2B reads remain independently recoverable; a Git read error must not block E2B.
    await page.evaluate(()=>{window.assetsFixture.restoreRead();window.assetsFixture.gitReadFailure(true)});
    await button('刷新');await live.getByRole('alert').filter({hasText:'凭据服务暂时不可用'}).waitFor();
    await button('添加连接');await button('选择 E2B');
    await field('名称').fill('Recovery E2B');await live.getByLabel('访问密钥',{exact:true}).fill('fixture-key');
    await summary('高级设置').click();const api=field('API 地址'),domain=field('沙盒域名');
    await api.fill('invalid-url');await domain.fill('');await summary('高级设置').click();
    const posts=await page.evaluate(()=>window.assetsFixture.posts);
    await button('保存');await api.waitFor();
    await page.waitForFunction(id=>document.activeElement?.id===id,await api.getAttribute('id'));
    assert.equal(await api.evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.evaluate(()=>window.assetsFixture.posts),posts);
    await api.fill('https://api.e2b.dev');await summary('高级设置').click();await button('保存');await domain.waitFor();
    await page.waitForFunction(id=>document.activeElement?.id===id,await domain.getAttribute('id'));
    assert.equal(await domain.evaluate(el=>el===document.activeElement),true);
    await domain.fill('https://e2b.dev');await summary('高级设置').click();
    await page.evaluate(()=>window.assetsFixture.delayCatalog(600));
    await button('保存');await live.getByRole('button',{name:'保存中…',exact:true}).waitFor();
    assert.equal(await live.getByRole('button',{name:'返回列表',exact:true}).isDisabled(),true);
    await live.getByRole('button',{name:'管理 Recovery E2B',exact:true}).waitFor();
    await page.evaluate(()=>{window.assetsFixture.delayCatalog(0);window.assetsFixture.gitReadFailure(false)});await button('刷新');
    const search=field('按名称查找');await search.fill('nothing-matches');await button('清除筛选');
    await page.waitForFunction(el=>el===document.activeElement,await search.elementHandle());
    assert.equal(await search.evaluate(el=>el===document.activeElement),true);
    await page.screenshot({path:task+'recovery-'+width+'-'+theme+'.png'});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({width,theme,providerIsolation:true,hiddenValidationRevealed:true,clearFocus:true,gitEnterAndFeedback:true,partialWriteNotSuccess:true,unbindExplanation:true,pendingWriteGuard:true}));
    await context.close();
  }
} finally {await browser?.close();await server.close();}
