import assert from "node:assert/strict";
import { createWorkbenchWebServer } from "./serve-workbench-web.mjs";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const server = await createWorkbenchWebServer({ appServerTarget: null });
let browser: any;
try {
  const address = await server.listen({ host: "127.0.0.1", port: 0 }) as { port: number };
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, locale: "en-US" });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/settings/appearance`);
  await page.locator("#workbench-language").waitFor({ timeout: 30000 });
  assert.equal(await page.locator("#workbench-language").inputValue(), "");
  await page.selectOption("#workbench-language", "zh-CN");
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.ok((await page.locator("body").textContent())?.includes("显示偏好应用于所有工作台视图"));
  await page.reload();
  await page.locator("#workbench-language").waitFor();
  assert.equal(await page.locator("#workbench-language").inputValue(), "zh-CN");
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  assert.deepEqual(errors, []);
  console.log("PASS full built Workbench: anonymous Settings, locale selection, translated source descriptors and persisted reload; no Agent connection or inference.");
} finally { await browser?.close(); await server.close(); }
