import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = process.cwd(),
  out =
    process.env.OPENCRAFT_FORWARDED_OUTPUT ??
    root + '/.local/forwarded-record-evidence/';
fs.mkdirSync(out, { recursive: true });
const { createServer } = await import(
    pathToFileURL(root + '/node_modules/vite/dist/node/index.js')
  ),
  { chromium } = await import(
    pathToFileURL(root + '/node_modules/playwright/index.mjs')
  );
// Reuse the actual registered Inbox/channel route and AppShell fixture, not a stand-alone card mock.
const fixture = fs.readFileSync(
    root + '/tests/extensions/channel-recovery.browser.mjs',
    'utf8',
  ),
  begin = fixture.indexOf('const source=') + 'const source='.length,
  end = fixture.indexOf('\nconst server', begin);
assert.ok(begin > 10 && end > begin);
let source = Function(
  'return ' + fixture.slice(begin, end).replace(/;\s*$/u, ''),
)();
const record = {
  version: 1,
  title: '群聊的聊天记录',
  entries: [
    {
      path: '1',
      sender: { id: 'T62450049A', name: 'cissymao' },
      at: Date.parse('2026-11-13T00:14:00+08:00'),
      parts: [
        {
          kind: 'text',
          text: '@skipzhang 哥，可以辛苦看一下这两个接口为什么一直超时吗？',
        },
        { kind: 'image', resource: '1.2', name: '告警截图.png' },
      ],
    },
    {
      path: '2',
      sender: { id: 'T62450049A', name: 'cissymao' },
      at: Date.parse('2026-11-13T00:14:05+08:00'),
      parts: [{ kind: 'text', text: '昨天到今天一直告警' }],
    },
    {
      path: '3',
      sender: { id: 'T62450049A', name: 'cissymao' },
      at: Date.parse('2026-11-13T00:18:00+08:00'),
      parts: [
        {
          kind: 'text',
          text: '实例地址：192.0.2.10:8095 和 192.0.2.11:8095\n被调接口：qcloud.saas.checkSaaSAccountExist\n调用方标识：caller / componentName = WACCOUNT',
        },
        { kind: 'file', name: '排查信息.txt', resource: '3.2' },
      ],
    },
    ...Array.from({ length: 54 }, (_, i) => ({
      path: String(i + 4),
      sender: {
        id: i % 2 ? 'owner' : 'colleague',
        name: i % 2 ? 'skipzhang' : 'lisi',
      },
      at: Date.parse('2026-11-13T00:20:00+08:00') + i * 60000,
      parts: [
        {
          kind: 'text',
          text:
            i === 0
              ? '**普通文字，不是标题**\n<script>window.recordInjected=true</script>\nhttps://never-fetch.invalid/test'
              : '排查消息 ' + i,
        },
      ],
    })),
  ],
};
const text =
  '[聊天记录] 群聊的聊天记录\n11-13 00:14 cissymao: @skipzhang 哥，可以辛苦看一下这两个接口为什么一直超时吗\n11-13 00:14 cissymao: 昨天到今天一直告警\n11-13 00:18 cissymao: 实例地址与调用信息';
const document = Buffer.from(JSON.stringify(record)),
  { default: sharp } = await import(
    pathToFileURL(createRequire(root + '/package.json').resolve('sharp'))
  ),
  png = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="220"><rect width="480" height="220" fill="#f7f9fc"/><text x="24" y="40" font-family="sans-serif" font-size="18" fill="#243448">API latency · fixture</text><path d="M24 170H450 M24 75V170" stroke="#c5ceda" fill="none"/><path d="M24 155L80 145L120 152L160 120L200 125L240 55L280 70L320 40L360 65L405 35L450 45" stroke="#d66060" stroke-width="3" fill="none"/><text x="24" y="200" font-family="sans-serif" font-size="12" fill="#69788c">2 endpoints · timeout alerts</text></svg>',
    ),
  )
    .png()
    .toBuffer();
const messages = [
  {
    sequence: 1,
    messageId: 'forward',
    author: 'external',
    sender: {
      id: 'owner',
      displayName: 'skipzhang',
      kind: 'external',
      isSelf: true,
    },
    text,
    at: Date.now() - 40000,
    status: 'received',
    attachment: {
      name: record.title + '.chat-record.json',
      type: 'application/vnd.opencraft.chat-record+json',
      size: document.length,
    },
  },
  {
    sequence: 2,
    messageId: 'caption',
    author: 'owner',
    sender: {
      id: 'owner',
      displayName: 'skipzhang',
      kind: 'external',
      isSelf: true,
    },
    text: '查查',
    at: Date.now() - 35000,
    status: 'received',
  },
  {
    sequence: 3,
    messageId: 'old',
    author: 'external',
    sender: { id: 'someone', displayName: '另一位同事', kind: 'external' },
    text: '[聊天记录] 较早的聊天记录\n11-12 09:00 T62450049A: 这是旧版文本存档\n原始结构未被保留下来，不凭空还原。',
    at: Date.now() - 30000,
    status: 'received',
  },
];
const inject = `
window.recordFixture??={fail:false,deny:false,reads:0};
if(method==='opencraft/channels/sync'){await wait('sync');if(denied)throw Error('channel_denied');return{kind:'snapshot',messages:${JSON.stringify(messages)},hasEarlier:false,cursor:'fixture'}};
if(method==='opencraft/channels/attachments/read'){window.recordFixture.reads++;if(window.recordFixture.fail)throw Error('fixture failure');const raw=atob('${document.toString('base64')}'),offset=p.offset;return{name:'record.json',type:'application/vnd.opencraft.chat-record+json',size:raw.length,base64:btoa(raw.slice(offset,offset+65536)),nextOffset:Math.min(raw.length,offset+65536)}};
if(method==='opencraft/channels/records/resource/read'){if(window.recordFixture.deny)throw Error('channel_denied');const raw=p.path==='1.2'?atob('${png.toString('base64')}'):'排查资料';const data=new TextEncoder().encode(raw);return{name:p.path==='1.2'?'告警截图.png':'排查信息.txt',type:p.path==='1.2'?'image/png':'text/plain',size:p.path==='1.2'?${png.length}:data.length,revision:'immutable',base64:p.path==='1.2'?'${png.toString('base64')}':btoa(String.fromCharCode(...data)),nextOffset:p.path==='1.2'?${png.length}:data.length}};
`;
source = source
  .replace(
    'request:async(method,p,signal)=>{',
    'request:async(method,p,signal)=>{' + inject,
  )
  .replace(
    'supportsRead:true,connect:',
    'supportsRead:true,supportsAttachments:true,supportsAttachmentChunks:true,connect:',
  )
  .replace(
    "title:'Navigation group '+i",
    "title:i===0?'转发记录测试':'Navigation group '+i",
  )
  .replace(
    "createIntlTestRoot(target,undefined,'en-US')",
    "createIntlTestRoot(target,undefined,'zh-CN')",
  );
// The original fixture relies on its default English locale; explicitly select Chinese here.
source = source.replace(
  'createIntlTestRoot(target).render(',
  "createIntlTestRoot(target,undefined,'zh-CN').render(",
);
const server = await createServer({
  root,
  configFile: false,
  cacheDir: out + 'vite',
  publicDir: root + '/apps/workbench-web/public',
  logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom', 'react-intl'] },
  esbuild: { jsx: 'automatic', target: 'esnext' },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: {
    include: [
      '@deepseek-ai/cordis',
      '@mermaid-js/layout-elk',
      '@radix-ui/react-context-menu',
      '@radix-ui/react-slot',
      '@radix-ui/react-tooltip',
      '@shikijs/core',
      '@shikijs/engine-javascript',
      '@shikijs/langs/bash',
      '@shikijs/langs/cpp',
      '@shikijs/langs/css',
      '@shikijs/langs/diff',
      '@shikijs/langs/go',
      '@shikijs/langs/html',
      '@shikijs/langs/java',
      '@shikijs/langs/javascript',
      '@shikijs/langs/json',
      '@shikijs/langs/jsx',
      '@shikijs/langs/markdown',
      '@shikijs/langs/python',
      '@shikijs/langs/rust',
      '@shikijs/langs/sql',
      '@shikijs/langs/swift',
      '@shikijs/langs/tsx',
      '@shikijs/langs/typescript',
      '@shikijs/langs/yaml',
      'katex',
      'marked',
      'mermaid',
      'react-router',
      'react-use-event-hook',
      'react/jsx-dev-runtime',
      'sonner',
      'prosemirror-state',
      'prosemirror-view',
      'prosemirror-model',
      'prosemirror-transform',
      'prosemirror-commands',
      'prosemirror-history',
      'prosemirror-keymap',
      'prosemirror-inputrules',
      'prosemirror-schema-list',
      '@dnd-kit/core',
      '@dnd-kit/sortable',
      '@dnd-kit/utilities',
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'motion/react',
      '@tanstack/react-query',
      'react-intl',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-alert-dialog',
      'tslib',
    ],
  },
  plugins: [
    {
      name: 'forwarded-route-fixture',
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url === '/favicon.ico') {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.url?.startsWith('/record-probe.tsx')) {
            res.setHeader('content-type', 'application/javascript');
            void s
              .transformRequest('/@fs' + root + '/record-probe.tsx')
              .then((r) => res.end(r?.code));
          } else if (req.url?.startsWith('/record-fixture')) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/record-probe.tsx"></script>',
            );
          } else next();
        });
      },
      resolveId(id) {
        if (id === root + '/record-probe.tsx') return id;
      },
      load(id) {
        if (id === root + '/record-probe.tsx') return source;
      },
    },
  ],
});
let browser, activePage;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    executablePath:
      process.env.CHROMIUM_PATH ??
      '/data/build/cache/playwright/chromium-1248/chrome-linux64/chrome',
  });
  for (const touch of [true, false])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
          viewport: { width: touch ? 390 : 1200, height: 844 },
          hasTouch: touch,
          isMobile: touch,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
        }),
        page = await context.newPage(),
        errors = [],
        requests = [];
      activePage = page;
      page.setDefaultTimeout(60000);
      page.on('console', (m) => {
        if (m.type() === 'error') console.error('CONSOLE', m.text());
      });
      page.on('response', (r) => {
        if (r.status() >= 400) console.error('HTTP', r.status(), r.url());
      });
      page.on('pageerror', (e) => {
        errors.push(e.message);
        console.error('PAGE', e.message);
      });
      page.on('requestfailed', (r) =>
        console.error('REQUEST', r.url(), r.failure()?.errorText),
      );
      page.on('request', (r) => requests.push(r.url()));
      await page.goto(
        'http://127.0.0.1:' +
          server.httpServer.address().port +
          '/record-fixture?theme=' +
          theme,
        { waitUntil: 'domcontentloaded', timeout: 180000 },
      );
      await page
        .getByRole('button', { name: 'Open Inbox', exact: true })
        .click();
      await page.evaluate(() => window.control.release());
      await page
        .getByRole('button', { name: '转发记录测试', exact: true })
        .click();
      const activate = (locator) => (touch ? locator.tap() : locator.click());
      const live = page.locator('.page-stack__live'),
        editor = live.locator('[contenteditable=true]').first();
      await editor.waitFor();

      const card = live.getByRole('button', {
        name: '群聊的聊天记录',
        exact: true,
      });
      await card.waitFor();
      await live.locator('[data-history-presentation=none]').waitFor();
      await editor.click();
      await page.keyboard.insertText('草稿保持不变');
      await page.waitForTimeout(100);

      assert.ok((await editor.innerText()).includes('草稿保持不变'));
      assert.ok((await card.boundingBox()).height < 210);
      const titleBox = await card
          .locator('.im-record-card__title')
          .boundingBox(),
        previewBox = await card
          .locator('.im-record-card__preview')
          .boundingBox(),
        footerBox = await card.locator('.im-record-card__footer').boundingBox();
      assert.ok(
        titleBox.width > 200 &&
          titleBox.y < previewBox.y &&
          previewBox.y < footerBox.y,
        'card must stack title, preview and footer vertically',
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.equal(
        await page.evaluate(() => window.recordFixture?.reads ?? 0),
        0,
      );
      await page.screenshot({
        path: out + `${touch ? 'touch' : 'desktop'}-${theme}-card.png`,
      });
      await activate(card);
      const dialog = page.getByRole('dialog').last();
      await dialog
        .getByText('57 条消息 · 3 位参与者', { exact: true })
        .waitFor();
      await dialog.getByText('昨天到今天一直告警', { exact: true }).waitFor();
      await page.screenshot({
        path: out + `${touch ? 'touch' : 'desktop'}-${theme}-detail.png`,
      });
      const imageButton = dialog.getByRole('button', {
        name: '查看图片',
        exact: true,
      });
      await imageButton.waitFor();
      await activate(imageButton);
      await page.locator('dialog.opencraft-image-preview[open]').waitFor();
      await page.keyboard.press('Escape');
      await page
        .locator('dialog.opencraft-image-preview')
        .waitFor({ state: 'detached' });
      await page
        .getByRole('dialog')
        .getByText('昨天到今天一直告警', { exact: true })
        .waitFor();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: '下载文件', exact: true }).click(),
      ]);
      assert.equal(download.suggestedFilename(), '排查信息.txt');
      assert.equal(fs.readFileSync(await download.path(), 'utf8'), '排查资料');
      assert.equal(await dialog.locator('h1').count(), 0);
      assert.equal(
        await page.evaluate(() => window.recordInjected ?? false),
        false,
      );
      assert.ok(!requests.some((u) => u.includes('never-fetch.invalid')));
      const rows = dialog.locator('.im-record__entry');
      assert.equal(await rows.count(), 50);
      const body = dialog.locator('[data-record-body]');
      assert.ok(await body.evaluate((e) => e.scrollHeight > e.clientHeight));
      await dialog.getByRole('button', { name: '继续显示更多消息' }).click();
      assert.equal(await rows.count(), 57);
      await dialog
        .getByRole('button', { name: '关闭', exact: true })
        .first()
        .click();
      await card.waitFor();
      assert.ok((await editor.innerText()).includes('草稿保持不变'));
      await live
        .getByRole('button', { name: '较早的聊天记录', exact: true })
        .click();
      const old = page.getByRole('dialog').last();
      await old
        .getByText('文本存档 · 原始消息结构不可恢复', { exact: true })
        .waitFor();
      assert.equal(await old.locator('.im-record__entry').count(), 0);
      await old.getByRole('button', { name: '关闭', exact: true }).click();
      const acceptedReads = await page.evaluate(
        () => window.recordFixture.reads,
      );
      await activate(card);
      await page
        .getByRole('dialog')
        .getByText('昨天到今天一直告警', { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => window.recordFixture.reads),
        acceptedReads,
        'repeat open reuses the immutable document within the current authority',
      );
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        window.control.blockSync();
        window.control.disconnect();
      });
      await page.waitForFunction(
        () => document.querySelector('.im-record-card')?.disabled === true,
      );
      await page.evaluate(() => {
        window.recordFixture.fail = true;
        window.control.release();
      });
      await page.waitForFunction(
        () => document.querySelector('.im-record-card')?.disabled === false,
      );
      await activate(card);
      const failed = page.getByRole('dialog').last();
      await failed
        .getByRole('button', { name: '聊天记录加载失败，点击重试' })
        .waitFor();
      await page.evaluate(() => (window.recordFixture.fail = false));
      await failed
        .getByRole('button', { name: '聊天记录加载失败，点击重试' })
        .click();
      await failed.getByText('昨天到今天一直告警', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await card.waitFor();
      await activate(card);
      await page
        .getByRole('dialog')
        .getByText('昨天到今天一直告警', { exact: true })
        .waitFor();
      await page.evaluate(() => {
        window.control.blockSync();
        window.control.disconnect();
      });
      await page.waitForFunction(
        () => document.querySelectorAll('[role=dialog]').length === 0,
      );
      assert.equal(await card.isDisabled(), true);
      await page.evaluate(() => {
        window.control.deny();
        window.control.release();
        window.control.changed();
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.im-record__entry').length === 0,
      );
      assert.deepEqual(errors, []);
      results.push({
        touch,
        theme,
        compact: true,
        detail: true,
        legacy: true,
        retry: true,
        noInjectedMarkup: true,
        draftPreserved: true,
        paged: true,
        imageViewer: true,
        fileDownload: true,
        revocationClosesDialog: true,
        cachedReopen: true,
      });
      await context.close();
    }
  fs.writeFileSync(out + 'results.json', JSON.stringify(results, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: out + 'failure.png' });
    fs.writeFileSync(
      out + 'failure.txt',
      await activePage.locator('body').innerText(),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
