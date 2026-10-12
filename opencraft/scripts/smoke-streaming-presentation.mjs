import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {WebChatDocument} from '@opencraft/chat-render-web';
import '/apps/workbench-web/src/styles/app.scss';
const root=createRoot(document.getElementById('root'));
const text='streaming word '.repeat(2500)+'\\n\\n@repo/file.ts';
let documentId='burst';
function render(streaming){root.render(<WebChatDocument documentId={documentId} source={text} streaming={streaming}/>);}
window.finish=()=>render(false);
window.begin=()=>{documentId='completion';render(true);};
render(true);
`;
const server = await createServer({
  root: process.cwd(), configFile: false, logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-streaming-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "streaming-fixture",
    resolveId: id => id === "/probe.tsx" ? id : null,
    load: id => id === "/probe.tsx" ? source : null,
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><meta charset="UTF-8"><div id="root"></div><script type="module" src="/probe.tsx"></script>');
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.locator(".chat-stream-fade-in").first().waitFor({ state: "attached" });
  const maxDelay = await page.locator(".chat-stream-fade-in").evaluateAll(nodes =>
    Math.max(...nodes.map(node => parseFloat(getComputedStyle(node).animationDelay))));
  assert.ok(maxDelay <= 0.096, `animation delay ${maxDelay}s exceeds bound`);
  await page.waitForTimeout(500);
  const hiddenCount = () => page.locator(".opencraft-chat-document").evaluate(node =>
    [...node.querySelectorAll("span")].filter(span => Number(getComputedStyle(span).opacity) < 0.01).length);
  assert.equal(await hiddenCount(), 0);
  const length = await page.locator(".opencraft-chat-document").evaluate(node => node.textContent.length);
  assert.ok(length >= 37_500);
  await page.evaluate(() => window.begin());
  await page.waitForTimeout(20);
  await page.evaluate(() => window.finish());
  await page.waitForTimeout(100);
  assert.equal(await hiddenCount(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ segments: 5_000, maxDelaySeconds: maxDelay,
    hiddenAfter500ms: 0, hiddenAfterCompletion: 0, domTextLength: length }));
} finally {
  await browser?.close();
  await server.close();
}
