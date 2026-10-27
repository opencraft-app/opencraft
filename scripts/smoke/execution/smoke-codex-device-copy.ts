import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
import {CodexDeviceLoginContent} from '/plugins/builtin-agents/src/codex-accounts/view.tsx';
const login={sessionId:'test',verificationUrl:'https://example.test/device',userCode:'ABCD-12345',expiresAt:Date.now()+60000};
createRoot(document.getElementById('root')).render(
  <Dialog.Root open><Dialog.Content><CodexDeviceLoginContent login={login} canceling={false} onCancel={()=>{}} /></Dialog.Content></Dialog.Root>
);
`;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "codex-device-copy-fixture",
    resolveId: id => id === "/codex-copy-probe.tsx" ? id : null,
    load: id => id === "/codex-copy-probe.tsx" ? source : null,
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/codex-copy-probe.tsx"></script>');
      });
    },
  }],
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  const headed = process.env.OPENCRAFT_HEADFUL_COPY_SMOKE === "1";
  browser = await chromium.launch({ headless: !headed, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;

  const web = await browser.newPage();
  await web.addInitScript("window.__name=value=>value;");
  await web.goto(url);
  const code = web.locator(".engine-device-login__code strong");
  await code.waitFor();
  await web.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  if (headed) {
    const result = spawnSync("xclip", ["-selection", "clipboard"], {
      input: "prior-clipboard-value", stdio: ["pipe", "ignore", "ignore"], timeout: 1_000,
    });
    assert.equal(result.status, 0);
  }
  await web.getByRole("button", { name: "复制", exact: true }).click();
  await web.getByText("已复制", { exact: true }).waitFor();
  if (headed) {
    const result = spawnSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf8", timeout: 1_000 });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, await code.textContent());
  }
  await web.evaluate(() => {
    document.execCommand = () => false;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (value: string) => { (window as any).copied = value; } }, configurable: true,
    });
  });
  await web.getByRole("button", { name: "复制", exact: true }).click();
  await web.getByText("已复制", { exact: true }).waitFor();
  assert.equal(await web.evaluate(() => (window as any).copied), await code.textContent());
  await web.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await web.getByRole("button", { name: "复制", exact: true }).click();
  await web.getByText("复制失败，请手动选中验证码复制", { exact: true }).waitFor();
  console.log("Codex device copy: Web selection and Clipboard API copy the displayed code; failure is visible");
} finally {
  await browser?.close();
  await vite.close();
}
