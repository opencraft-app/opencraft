import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractMarkdownElement } from "../../packages/chat-render-web/src/markdown-copy";

function fixture(metadata = false) {
  const document = new JSDOM().window.document;
  const root = document.createElement("div");
  root.innerHTML = '<figure data-markdown-copy="code-block"><figcaption data-markdown-copy="exclude">TypeScript<button>Copy</button></figcaption><pre><code>  const first = "你好🙂";\n\tconst second = 2;\n</code></pre><span class="sr-only">Hidden label</span><span aria-hidden="true">Hidden icon</span></figure>';
  if (metadata) root.firstElementChild!.setAttribute("data-markdown-copy-text", "authoritative full source\n");
  return { document, root };
}

test("code fallback excludes captions and controls while preserving source whitespace", () => {
  const { root } = fixture();
  const result = extractMarkdownElement(root);
  assert.equal(result.htmlText, '<pre><code>  const first = "你好🙂";\n\tconst second = 2;\n</code></pre>');
  assert.equal(result.plainText, 'const first = "你好🙂";\n\tconst second = 2;');
});

test("explicit full code source remains authoritative", () => {
  const { root } = fixture(true);
  assert.equal(extractMarkdownElement(root).htmlText, '<pre><code>authoritative full source\n</code></pre>');
});

test("a cloned partial selection across code surfaces excludes the second caption", () => {
  const { document, root } = fixture(true);
  root.append(document.createElement("p"));
  root.lastElementChild!.textContent = "Middle prose.";
  root.append(fixture(true).root.firstElementChild!);
  const codes = root.querySelectorAll("code");
  const range = document.createRange();
  range.setStart(codes[0]!.firstChild!, 8);
  range.setEnd(codes[1]!.firstChild!, 13);
  const fragment = document.createElement("div");
  fragment.append(range.cloneContents());
  fragment.querySelectorAll("[data-markdown-copy-text]").forEach(element => element.removeAttribute("data-markdown-copy-text"));
  const result = extractMarkdownElement(fragment);
  assert.equal(result.plainText, 'first = "你好🙂";\n\tconst second = 2;\n\nMiddle prose.\n  const first');
  assert.ok(!result.htmlText.includes("TypeScript"));
  assert.ok(!result.htmlText.includes("Hidden"));
});
