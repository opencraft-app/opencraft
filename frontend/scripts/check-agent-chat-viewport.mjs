// Run after a frontend build. Playwright/Chromium are supplied by the test host:
// PLAYWRIGHT_MODULE=playwright-core CHROMIUM_EXECUTABLE=/path/to/chromium
// node scripts/check-agent-chat-viewport.mjs [export-directory]
// Only visualViewport shrinks: changing Playwright's viewport height alone
// changes 100dvh too and cannot reproduce the iOS keyboard constraint conflict.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(frontend, process.argv[2] ?? "out");
const html = await readFile(resolve(output, "agents/chat/index.html"), "utf8");
const links = [...html.matchAll(/<link\b[^>]*>/g)]
  .map(([tag]) => /rel="stylesheet"/.test(tag) ? tag.match(/href="([^"]+)"/)?.[1] : null)
  .filter(Boolean);
assert.ok(links.length, "The exported chat must include real compiled stylesheets");
const css = (await Promise.all(links.map(href => readFile(
  resolve(output, new URL(href, "https://fixture.invalid").pathname.slice(1)), "utf8",
)))).join("\n");
const helper = ts.transpileModule(await readFile(resolve(
  frontend, "src/pages/marketing/agent-chat-visual-viewport.ts",
), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  ...(process.env.CHROMIUM_NO_SANDBOX === "1" ? { args: ["--no-sandbox"] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // The composer is a geometry fixture, not a simulated Host or model session.
  await page.setContent(`<style>${css}</style><div id="chat" class="flex flex-col bg-white lv-agent-chat-page lv-agent-embedded-chat-page">
    <main style="flex:1;min-height:0;overflow:auto"><div style="height:1200px">History</div></main>
    <form id="composer" style="height:100px;flex-shrink:0"><textarea aria-label="Draft"></textarea><button type="button">Send</button></form>
  </div>`);
  await page.evaluate(async code => {
    const helpers = await import(`data:text/javascript;base64,${btoa(code)}`);
    const viewport = Object.assign(new EventTarget(), { height: 844, pageTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    const chat = document.getElementById("chat");
    chat.classList.add(helpers.agentChatPageMinHeightClass(true));
    window.viewportFixture = { viewport, helpers, stop: helpers.bindChatVisualViewportHeight(chat) };
  }, helper);
  await page.locator("textarea").fill("Preserved draft");
  await page.locator("textarea").focus();
  const measure = () => page.evaluate(() => {
    const bounds = id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const { viewport } = window.viewportFixture;
    return {
      layoutHeight: innerHeight, visualTop: viewport.pageTop, visualBottom: viewport.pageTop + viewport.height,
      chat: bounds("chat"), composer: bounds("composer"),
      minHeight: getComputedStyle(document.getElementById("chat")).minHeight,
      rootPosition: getComputedStyle(document.documentElement).position,
      bodyPosition: getComputedStyle(document.body).position,
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
      focused: document.activeElement === document.querySelector("textarea"),
      draft: document.querySelector("textarea").value,
    };
  });
  const results = { initial: await measure() };
  assert.equal(results.initial.rootPosition, "fixed");
  assert.equal(results.initial.bodyPosition, "fixed");
  assert.equal(results.initial.rootOverflow, "hidden");
  await page.evaluate(() => {
    window.viewportFixture.viewport.height = 460;
    window.viewportFixture.viewport.dispatchEvent(new Event("resize"));
  });
  results.keyboard = await measure();
  assert.equal(results.keyboard.layoutHeight, 844);
  assert.equal(results.keyboard.chat.height, 460);
  assert.equal(results.keyboard.minHeight, "0px");
  assert.ok(results.keyboard.composer.bottom <= results.keyboard.visualBottom);
  assert.ok(results.keyboard.composer.top >= results.keyboard.visualTop);
  assert.ok(results.keyboard.focused);
  assert.equal(results.keyboard.draft, "Preserved draft");
  await page.evaluate(() => {
    const chat = document.getElementById("chat");
    chat.classList.replace("min-h-0", "min-h-dvh");
  });
  results.negativeControl = await measure();
  assert.equal(results.negativeControl.chat.height, 844);
  assert.ok(results.negativeControl.composer.bottom > results.negativeControl.visualBottom);
  await page.evaluate(() => {
    document.getElementById("chat").classList.replace("min-h-dvh", "min-h-0");
    window.viewportFixture.viewport.pageTop = 40;
    window.viewportFixture.viewport.dispatchEvent(new Event("scroll"));
  });
  results.panned = await measure();
  assert.equal(results.panned.chat.height, 500);
  assert.ok(results.panned.composer.bottom <= results.panned.visualBottom);
  await page.evaluate(() => {
    // Explicit reverse-order model: the keyboard closes before pageTop clears.
    // This is not a claim that this ordering occurred on a native iPhone.
    window.viewportFixture.viewport.height = 844;
    window.viewportFixture.viewport.dispatchEvent(new Event("resize"));
  });
  results.closeWithStaleOffset = await measure();
  assert.equal(results.closeWithStaleOffset.chat.height, 844);
  await page.evaluate(() => {
    window.viewportFixture.viewport.pageTop = 0;
    window.viewportFixture.viewport.dispatchEvent(new Event("scroll"));
  });
  results.restored = await measure();
  assert.equal(results.restored.chat.height, 844);
  assert.ok(results.restored.focused);
  assert.equal(results.restored.draft, "Preserved draft");
  await page.evaluate(() => {
    window.viewportFixture.stop();
    const chat = document.getElementById("chat");
    chat.classList.remove("lv-agent-chat-page", "lv-agent-embedded-chat-page", "min-h-0");
    chat.classList.add(window.viewportFixture.helpers.agentChatPageMinHeightClass(false));
    chat.innerHTML = "Ordinary page";
    chat.style.height = "460px";
  });
  assert.equal(await page.locator("#chat").evaluate(el => el.getBoundingClientRect().height), 844);
  assert.equal(await page.locator("#chat").evaluate(el => el.style.getPropertyValue("--lv-agent-chat-viewport-height")), "");
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).position), "static");
  // Declarative chat scope must not revoke a separate, still-present modal lock.
  await page.evaluate(() => {
    const modal = document.createElement("div");
    modal.id = "modal-lock-fixture";
    modal.className = "lv-persona-modal-scroll-lock";
    document.body.append(modal);
  });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), "hidden");
  await page.evaluate(() => document.getElementById("modal-lock-fixture").remove());
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.evaluate(() => {
    const chat = document.getElementById("chat");
    chat.classList.replace("min-h-dvh", "min-h-0");
    chat.classList.add("lv-agent-chat-page", "lv-agent-embedded-chat-page");
    chat.style.removeProperty("height");
    chat.style.setProperty("--lv-agent-chat-viewport-height", "460px");
  });
  assert.equal(await page.locator("#chat").evaluate(el => el.getBoundingClientRect().height), 844);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).position), "static");
  console.log(JSON.stringify({ passed: true, stylesheetCount: links.length, results }, null, 2));
} finally {
  await browser.close();
}
