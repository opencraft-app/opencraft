import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createWorkbenchStaticServer } from "./serve-workbench-static.mjs";

const server = await createWorkbenchStaticServer({ root: resolve("apps/workbench-web/dist-electron") });
try {
  const address = await server.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  for (const route of ["/", "/views/vela.bot-management.view", "/settings/models"]) {
    const pageUrl = `${origin}${route}`;
    const page = await fetch(pageUrl, { headers: { accept: "text/html" } });
    assert.equal(page.status, 200);
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu)].map(match => new URL(match[1], pageUrl));
    assert.ok(assets.some(url => url.pathname.endsWith(".js")), "HTML must reference its real entrypoint");
    for (const url of assets) {
      const response = await fetch(url);
      assert.equal(response.status, 200, `${route} must resolve ${url.pathname}`);
      assert.ok(!response.headers.get("content-type")?.includes("text/html"), "Assets cannot be SPA fallback HTML");
    }
  }
  console.log("PASS built Electron assets resolve through actual static server from root, Bot View and Settings deep routes");
} finally { await server.close(); }
