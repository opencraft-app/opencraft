// Local settings-page audit. Not wired into CI or release.
// Usage: node scripts/audit-settings-pages.mjs --url http://127.0.0.1:10000 --out /tmp/settings-audit-before.json
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const url = args.url ?? "http://127.0.0.1:10000";
const out = args.out ?? "/tmp/settings-audit.json";
const executable = process.env.OPENCRAFT_CHROMIUM_EXECUTABLE;
const axePath = args.axe ?? process.env.AXE_CORE;
const widths = [1440, 834, 390];
const schemes = ["light", "dark"];

const browser = await chromium.launch({ headless: true, executablePath: executable });
const report = { url, pages: [] };
try {
  for (const scheme of schemes) for (const width of widths) {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: width === 390 ? 844 : 1100 }, colorScheme: scheme, hasTouch: width < 900, isMobile: width < 500 });
    const page = await context.newPage();
    page.on("pageerror", error => console.log("pageerror", error.message.slice(0, 160)));
    await page.goto(url.endsWith("/") ? url : url + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    if (axePath) await page.addScriptTag({ path: axePath });
    const openSettings = async () => {
      const settingsButton = page.locator('button[aria-label="设置"]').first();
      const reveal = page.locator('button[aria-label="显示侧边栏"]').first();
      await page.locator('button[aria-label="设置"], button[aria-label="显示侧边栏"]').first().waitFor({ state: "attached", timeout: 60000 });
      if (!(await settingsButton.count()) && await reveal.count()) await reveal.evaluate(element => element.click());
      await settingsButton.waitFor({ state: "attached", timeout: 20000 });
      await settingsButton.evaluate(element => element.click());
    };
    await openSettings();
    await page.locator(".settings-page__navigation").waitFor({ timeout: 20000 });
    const names = await page.locator(".settings-page__navigation .ui-navigation-item").evaluateAll(nodes => nodes.map(node => (node.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean));
    for (const name of names) {
      let item = page.locator(".settings-page__navigation .ui-navigation-item", { hasText: name }).first();
      if (!(await item.count())) { await openSettings(); item = page.locator(".settings-page__navigation .ui-navigation-item", { hasText: name }).first(); }
      if (!(await item.count())) continue;
      await item.evaluate(element => element.click());
      await page.waitForTimeout(400);
      const measured = await page.evaluate(async ({ width, axeReady }) => {
        const content = document.querySelector(".settings-page__content") ?? document.querySelector(".settings-page__viewport");
        const box = element => element.getBoundingClientRect();
        const shown = element => {
          const rect = box(element);
          const style = getComputedStyle(element);
          return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
        };
        const edges = selector => [...content.querySelectorAll(selector)].filter(shown).map(element => Math.round(box(element).left));
        const header = edges(".settings-control-page-header h2, .settings-panel__header h2, .model-services .settings-control-page-header h2");
        const reference = header[0] ?? Math.round(box(content).left);
        const samples = [
          ["header", header],
          ["section", edges(".settings-control-section__copy h3")],
          ["card", edges(".settings-control-group")],
          ["list", edges(".settings-control-list-item")],
          ["search", edges("input[placeholder*=搜索], input[aria-label*=搜索]")],
        ];
        const alignment = samples.flatMap(([kind, values]) => values.filter(value => Math.abs(value - reference) > 1).map(value => ({ kind, left: value, reference })));
        const spacing = new Map();
        const fonts = new Map();
        const spacingUnit = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--spacing")) || 4;
        const allowedSize = new Set([...document.styleSheets].flatMap(sheet => {
          try { return [...sheet.cssRules]; } catch { return []; }
        }).flatMap(() => []));
        for (const name of [...document.documentElement.computedStyleMap?.().keys?.() ?? []]) {
          if (String(name).endsWith("-size")) allowedSize.add(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
        }
        for (const property of ["font-size"]) {
          const style = getComputedStyle(document.documentElement);
          for (let index = 0; index < style.length; index += 1) {
            const key = style[index];
            if (key.includes("typography") && key.endsWith("-size")) allowedSize.add(style.getPropertyValue(key).trim());
          }
        }
        const overflow = [];
        const english = [];
        for (const element of content.querySelectorAll("*")) {
          if (!shown(element)) continue;
          const style = getComputedStyle(element);
          for (const key of ["margin-top", "margin-bottom", "padding-top", "padding-bottom", "gap", "row-gap"]) {
            const value = parseFloat(style[key]);
            if (!Number.isFinite(value) || value === 0) continue;
            const rounded = Math.round(value * 2) / 2;
            spacing.set(rounded, (spacing.get(rounded) ?? 0) + 1);
          }
          if (element.childNodes.length && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) {
            fonts.set(`${style.fontSize}/${style.fontWeight}`, (fonts.get(`${style.fontSize}/${style.fontWeight}`) ?? 0) + 1);
            const text = element.innerText?.trim() ?? "";
            if (text.length > 18 && (text.match(/[A-Za-z]/g) ?? []).length > text.length * 0.7 && text.includes(" ")) english.push(text.slice(0, 120));
          }
          const clamped = style.webkitLineClamp && style.webkitLineClamp !== "none";
          const clipped = element.scrollWidth > element.clientWidth + 1 && style.overflowX !== "visible" && style.textOverflow === "ellipsis";
          if (clamped || clipped) overflow.push({ text: (element.innerText || "").trim().slice(0, 80), reason: clamped ? "line-clamp" : "ellipsis" });
        }
        const unnamed = [...content.querySelectorAll("input, select, textarea")].filter(shown).filter(field => {
          const name = field.getAttribute("aria-label") || field.id && content.querySelector(`label[for="${CSS.escape(field.id)}"]`);
          return !name && !field.getAttribute("aria-labelledby");
        }).map(field => field.outerHTML.slice(0, 140));
        const smallTargets = width > 500 ? [] : [...content.querySelectorAll("button, a, input, select")].filter(shown).filter(element => {
          const rect = box(element);
          return rect.width < 44 || rect.height < 44;
        }).map(element => ({ text: (element.innerText || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 40), width: Math.round(box(element).width), height: Math.round(box(element).height) }));
        let axe = null;
        if (axeReady && globalThis.axe) {
          const result = await globalThis.axe.run(content, { resultTypes: ["violations"], runOnly: { type: "rule", values: ["label", "color-contrast", "target-size"] } });
          axe = result.violations.map(violation => ({ id: violation.id, count: violation.nodes.length, help: violation.help }));
        }
        const oddSpacing = [...spacing.keys()].filter(value => Math.abs(value / spacingUnit - Math.round(value / spacingUnit)) > 0.05);
        const oddFonts = [...fonts.keys()].filter(token => !allowedSize.has(token.split("/")[0]));
        return { alignment, spacing: Object.fromEntries([...spacing].sort((a, b) => a[0] - b[0])), oddSpacing, fonts: Object.fromEntries(fonts), oddFonts, overflow: overflow.slice(0, 20), english: [...new Set(english)].slice(0, 20), unnamed, smallTargets: smallTargets.slice(0, 20), axe };
      }, { width, axeReady: Boolean(axePath) });
      report.pages.push({ scheme, width, name, url: page.url(), ...measured });
    }
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(out, JSON.stringify(report, null, 2));
const problems = report.pages.reduce((sum, page) => sum + page.alignment.length + page.oddSpacing.length + page.overflow.length + page.english.length + page.unnamed.length + (page.axe?.length ?? 0), 0);
console.log(`wrote ${out} pages=${report.pages.length} findings=${problems}`);
