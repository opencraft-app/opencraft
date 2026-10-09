import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

/** Generate Malay from the maintained English structure and a committed translation catalog. */
export async function generateMalayHome(targetRoot) {
  const translations = JSON.parse(await readFile(path.join(targetRoot, 'copy.ms-MY.json'), 'utf8'));
  const markup = await readFile(path.join(targetRoot, 'index-fragment.en-US.html'), 'utf8');
  const dom = new JSDOM(markup);
  const { document, NodeFilter } = dom.window;
  const translate = (value) => {
    const trimmed = value.trim();
    if (!trimmed || !/[A-Za-z]/.test(trimmed)) return value;
    const translated = translations[trimmed];
    if (translated === undefined) throw new Error(`Missing Malay homepage translation: ${trimmed}`);
    return value.replace(trimmed, () => translated);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement?.closest('script,style')) node.nodeValue = translate(node.nodeValue);
  }
  for (const element of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) {
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
      const value = element.getAttribute(attribute);
      if (value) element.setAttribute(attribute, translate(value));
    }
  }
  for (const element of document.querySelectorAll('[data-full-html]')) {
    const fragment = new JSDOM(element.getAttribute('data-full-html'));
    const texts = fragment.window.document.createTreeWalker(fragment.window.document.body, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = texts.nextNode())) text.nodeValue = translate(text.nodeValue);
    element.setAttribute('data-full-html', fragment.window.document.body.innerHTML);
  }
  for (const element of document.querySelectorAll('[data-rotator-words]')) {
    element.setAttribute('data-rotator-words', JSON.stringify(JSON.parse(element.getAttribute('data-rotator-words')).map(translate)));
  }
  for (const element of document.querySelectorAll('[href]')) {
    const href = element.getAttribute('href');
    if (href && /^\/(?:$|[?#]|(?:subscribe|changelog|docs|about|blog|support|privacy-policy|terms-of-service|open-source-licenses|cookie-policy)(?:[/?#]|$))/.test(href)) {
      element.setAttribute('href', `/ms-my${href === '/' ? '/' : href}`);
    }
  }
  for (const element of document.querySelectorAll('[data-locale],[data-source-locale],[data-language],[lang]')) {
    for (const attribute of ['data-locale', 'data-source-locale', 'data-language', 'lang']) {
      if (['en-US', 'en'].includes(element.getAttribute(attribute))) {
        element.setAttribute(attribute, attribute === 'data-language' ? 'ms' : 'ms-MY');
      }
    }
  }
  document.documentElement.lang = 'ms-MY';
  await writeFile(path.join(targetRoot, 'index-fragment.ms-MY.html'), document.body.innerHTML);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await generateMalayHome(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/lightvela-intl-home'));
}
