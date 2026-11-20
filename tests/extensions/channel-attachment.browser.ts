import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { navigationLifecycleFixture } from '../fixtures/navigation-lifecycle';

const root = process.cwd(), output = resolve(process.env.OPENCRAFT_IMAGE_MIME_OUTPUT ?? '.local/channel-image-mime');
let source = navigationLifecycleFixture.replace("const rpc={draftScope:", "window.uploads=[];window.rejectFiles=false;const rpc={supportsAttachments:true,supportsAttachmentChunks:true,draftScope:");
source = source.replace("request:async(method,p)=>{", `request:async(method,p)=>{
if(method==='opencraft/channels/attachments/upload'){
 window.uploads.push({name:p.name,type:p.type,id:p.clientMessageId,offset:p.offset,total:p.total,bytes:atob(p.base64).length});
 if(window.rejectFiles)throw Error('channel_files_unavailable');
 const nextOffset=p.offset+atob(p.base64).length;
 return{nextOffset,...(nextOffset===p.total?{receipt:{sequence:window.uploads.length,messageId:'sent-'+p.clientMessageId,author:'Me',text:'Image accepted',at:Date.now(),status:'sending'}}:{})};
}
if(method==='opencraft/channels/delivery/get')return{receipt:null};
`);
source = "import{useAsyncNotices}from'/apps/workbench-web/src/components/async-notices.tsx';\n" + source.replace('function App(){', 'function App(){const notices=useAsyncNotices();').replace('contribution={active} host={host}', 'contribution={active} reportError={notices.error} host={host}');
assert.notEqual(source, navigationLifecycleFixture);
const server = await createServer({
  root, configFile: false, publicDir: root + '/apps/workbench-web/public', logLevel: 'error', cacheDir: output + '/vite-cache',
  resolve: { dedupe: ['react', 'react-dom', 'react-intl'] }, esbuild: { jsx: 'automatic', target: 'esnext' },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { include: ['react', 'react-dom/client', 'react-intl', 'motion/react', '@tanstack/react-query', 'prosemirror-state', 'prosemirror-view', 'prosemirror-model', 'prosemirror-transform', 'prosemirror-commands', 'prosemirror-history', 'prosemirror-keymap', 'prosemirror-schema-list', 'prosemirror-inputrules', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities', 'react-dom', 'react/jsx-runtime', '@radix-ui/react-alert-dialog', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', 'tslib'] },
  plugins: [{ name: 'channel-image-mime-fixture', resolveId: id => id === '/image-mime-fixture.tsx' ? id : null,
    load: id => id === '/image-mime-fixture.tsx' ? source : null,
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (!req.headers.accept?.includes('text/html')) return next();
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/image-mime-fixture.tsx"></script>');
    }); },
  }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: unknown[] = [];
try {
  await mkdir(output, { recursive: true }); await server.listen(); browser = await chromium.launch({ headless: true });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    await page.goto(server.resolvedUrls!.local[0]! + (touch ? '?theme=dark' : ''));
    await page.getByRole('button', { name: 'Open Inbox', exact: true }).click();
    await page.getByRole('button', { name: /Navigation group 0\b/ }).first().click();
    const live = page.locator('.page-stack > .page-stack__live'), editor = live.locator('[contenteditable=true]').first();
    await editor.waitFor(); await page.waitForTimeout(800);
    const images = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
      canvas.getContext('2d')!.fillRect(0, 0, 8, 8);
      return { jpg: canvas.toDataURL('image/jpeg').split(',')[1]!, png: canvas.toDataURL('image/png').split(',')[1]! };
    });
    for (const entry of [
      { via: 'picker', name: 'camera.JPG', type: 'image/jpg', format: 'jpg' },
      { via: 'paste', name: 'pasted.jpeg', type: '', format: 'jpg' },
      { via: 'drop', name: 'dragged.jpg', type: 'application/octet-stream', format: 'jpg' },
      { via: 'paste', name: 'unchanged.png', type: 'image/png', format: 'png' },
    ] as const) {
      console.log(JSON.stringify({touch,stage:entry}));
      const base64 = images[entry.format];
      if (entry.via === 'picker') {
        const choosing = page.waitForEvent('filechooser'); await live.getByRole('button', { name: 'Add', exact: true }).click();
        await (await choosing).setFiles({ name: entry.name, mimeType: entry.type, buffer: Buffer.from(base64, 'base64') });
      } else await editor.evaluate((node, data) => {
        const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data.base64), ch => ch.charCodeAt(0))], data.name, { type: data.type }));
        const rect = node.getBoundingClientRect();
        node.dispatchEvent(data.via === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.x + 8, clientY: rect.y + 8 }));
      }, { ...entry, base64 });
      try { await live.locator('.opencraft-composer-image-attachment[data-state=ready]').waitFor({timeout:15000}); } catch(error) { console.log(await live.innerText()); console.log(await live.locator('.opencraft-composer-attachments').evaluateAll(nodes=>nodes.map(n=>n.outerHTML))); await page.screenshot({path:output+'/failure.png'}); throw error; }
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('.page-stack > .page-stack__live .opencraft-composer-image-attachment img');
        return image?.complete && image.naturalWidth > 0;
      });
      await live.getByRole('button', { name: 'Send attachment', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.page-stack > .page-stack__live .opencraft-composer-attachments'));
      const uploaded = await page.evaluate(() => (window as any).uploads.at(-1));
      assert.equal(uploaded.type, entry.format === 'jpg' ? 'image/jpeg' : 'image/png'); assert.equal(uploaded.name, entry.name);
      results.push({ touch, ...entry, sentAs: uploaded.type });
    }
    // A rejected image and accompanying text stay in this draft; no text send follows failure.
    await editor.fill('Keep this text and image'); await page.evaluate(() => { (window as any).rejectFiles = true; });
    await editor.evaluate((node, base64) => {
      const bytes = new Uint8Array(2 * 1024 * 1024 + 1); bytes.set(Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'large.jpg', { type: 'image/jpg' }));
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, images.jpg);
    await live.locator('.opencraft-composer-image-attachment[data-state=ready]').waitFor();
    await live.getByRole('button', { name: 'Send attachment', exact: true }).click();
    await page.getByText('This external chat accepts images up to 2 MB. Choose a smaller copy; your image is still in the draft.', { exact: true }).waitFor();
    assert.equal(await editor.innerText(), 'Keep this text and image');
    assert.equal(await live.locator('.opencraft-composer-image-attachment').count(), 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: output + (touch ? '/touch-dark.png' : '/desktop-light.png') });
    results.push({ touch, rejectedImageAndTextRetained: true, accurateSizeNotice: true }); await context.close();
  }
  await writeFile(output + '/evidence.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify({ passed: true, results }));
} finally { await browser?.close(); await server.close(); }
