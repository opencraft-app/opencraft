import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const FRAGMENT_FILE_PATTERN = /^index-fragment(?:\..+)?\.html$/;

export async function initializeInternationalHomeFragmentAccessibility(homeRoot) {
  const resolvedHomeRoot = path.resolve(homeRoot);
  const fragmentNames = (await readdir(resolvedHomeRoot))
    .filter((name) => FRAGMENT_FILE_PATTERN.test(name))
    .sort();
  let buttons = 0;

  for (const fragmentName of fragmentNames) {
    const fragmentPath = path.join(resolvedHomeRoot, fragmentName);
    const html = await readFile(fragmentPath, "utf8");
    const dom = new JSDOM(html);
    let rewrittenHtml = html;

    for (const button of dom.window.document.querySelectorAll(".scene__sub")) {
      const originalMarkup = button.outerHTML;
      button.setAttribute("aria-pressed", button.classList.contains("on") ? "true" : "false");
      rewrittenHtml = rewrittenHtml.replaceAll(originalMarkup, button.outerHTML);
      buttons += 1;
    }

    if (rewrittenHtml !== html) await writeFile(fragmentPath, rewrittenHtml);
  }

  return { buttons, fragments: fragmentNames.length };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  const homeRoot = process.argv[2];
  if (!homeRoot) {
    throw new Error(
      "Usage: node scripts/international-home-fragment-accessibility.mjs <international-home-root>",
    );
  }
  const summary = await initializeInternationalHomeFragmentAccessibility(homeRoot);
  console.log(
    `[international-home-fragment-accessibility] initialized ${summary.buttons} scene button(s) across ${summary.fragments} fragment(s)`,
  );
}
