const allowedAttributes: Readonly<Record<string, readonly string[]>> = {
  A: ["href", "title"],
  BLOCKQUOTE: ["cite"],
  IMG: ["src", "srcset", "sizes", "alt", "title", "width", "height"],
  LI: ["value"],
  OL: ["start"],
  Q: ["cite"],
  TD: ["colspan", "rowspan"],
  TH: ["colspan", "rowspan"],
  TIME: ["datetime"],
};

const blockTags = new Set(["BLOCKQUOTE", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "P", "PRE"]);

export interface MarkdownClipboardContent {
  readonly htmlText: string;
  readonly plainText: string;
}

function closestElement(node: Node, selector: string): Element | null {
  return (node.nodeType === 1 ? node as Element : node.parentElement)?.closest(selector) ?? null;
}

function copyRole(element: Element | null): "exclude" | "inline-code" | "code-block" | "rich-block" | null {
  const value = element?.getAttribute("data-markdown-copy");
  return value === "exclude" || value === "inline-code" || value === "code-block" || value === "rich-block"
    ? value
    : null;
}

function codeElement(document: Document, text: string): HTMLElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  pre.append(code);
  return pre;
}

function excludedFromCopy(element: Element): boolean {
  return copyRole(element) === "exclude"
    || element.classList.contains("sr-only")
    || element.getAttribute("aria-hidden") === "true"
    || (element.tagName === "IMG" && element.getAttribute("alt") === "");
}

/** Raw source whitespace is significant; only the shared copy exclusions apply. */
function codeText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1 || excludedFromCopy(node as Element)) return "";
  return Array.from(node.childNodes).map(codeText).join("");
}

function rebuildNode(document: Document, input: Node): Node | null {
  if (input.nodeType === 3) return document.createTextNode(input.textContent ?? "");
  if (input.nodeType !== 1) return null;
  const element = input as Element;
  const role = copyRole(element);
  if (excludedFromCopy(element)) return null;

  if (role === "code-block") {
    return codeElement(document, element.getAttribute("data-markdown-copy-text") ?? codeText(element));
  }
  if (role === "rich-block") {
    const content = element.querySelector("[data-markdown-copy-content]");
    return content === null ? null : rebuildNode(document, content);
  }

  // KaTeX owns two parallel trees. Preserve its TeX authority, never its
  // accessibility and visual duplicates.
  if (element.matches(".katex-display")) {
    const tex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    return tex === undefined ? document.createTextNode(element.textContent ?? "") : document.createTextNode(`\\[\n${tex}\n\\]`);
  }
  if (element.matches(".katex")) {
    const tex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    return tex === undefined ? document.createTextNode(element.textContent ?? "") : document.createTextNode(`\\(${tex}\\)`);
  }

  const output = document.createElement(role === "inline-code" ? "code" : element.localName);
  for (const attribute of allowedAttributes[element.tagName] ?? []) {
    const value = element.getAttribute(attribute);
    if (value !== null) output.setAttribute(attribute, value);
  }
  for (const child of Array.from(element.childNodes)) {
    const rebuilt = rebuildNode(document, child);
    if (rebuilt !== null) output.append(rebuilt);
  }
  return output;
}

function collectText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1 && node.nodeType !== 11) return "";
  if (node.nodeType === 1) {
    const element = node as Element;
    if (element.tagName === "BR") return "\n";
    if (element.tagName === "TABLE") {
      return Array.from(element.querySelectorAll("tr")).map((row) => (
        Array.from(row.children)
          .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
          .map((cell) => Array.from(cell.childNodes).map(collectText).join("").trim())
          .join("\t")
      )).join("\n");
    }
    const content = Array.from(element.childNodes).map(collectText).join("");
    return blockTags.has(element.tagName) ? `${content}\n` : content;
  }
  return Array.from(node.childNodes).map(collectText).join("");
}

function serializeFragment(document: Document, fragment: DocumentFragment): string {
  const container = document.createElement("div");
  container.append(fragment.cloneNode(true));
  return container.innerHTML;
}

export function extractMarkdownSelection(
  root: HTMLElement,
  selection: Selection | null = root.ownerDocument.getSelection(),
): MarkdownClipboardContent | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startsInside = root.contains(range.startContainer);
  const fullyInside = startsInside && root.contains(range.endContainer);
  if (!startsInside) return null;

  const editableStart = closestElement(range.startContainer, '[contenteditable="true"], [contenteditable="plaintext-only"]');
  const editableEnd = closestElement(range.endContainer, '[contenteditable="true"], [contenteditable="plaintext-only"]');
  if (editableStart !== null && editableStart === editableEnd) return null;

  if (fullyInside) {
    const startRoleElement = closestElement(range.startContainer, "[data-markdown-copy]");
    const endRoleElement = closestElement(range.endContainer, "[data-markdown-copy]");
    if (startRoleElement !== null && startRoleElement === endRoleElement) {
      const role = copyRole(startRoleElement);
      if (role === "exclude") return null;
      if (role === "code-block") {
        const plainText = startRoleElement.getAttribute("data-markdown-copy-text") ?? range.toString();
        const wrapper = codeElement(root.ownerDocument, plainText);
        return { htmlText: wrapper.outerHTML, plainText };
      }
    }
  }

  const cloned = range.cloneContents();
  const output = root.ownerDocument.createDocumentFragment();
  for (const child of Array.from(cloned.childNodes)) {
    const rebuilt = rebuildNode(root.ownerDocument, child);
    if (rebuilt !== null) output.append(rebuilt);
  }
  const plainText = collectText(output).trim();
  if (plainText.length === 0) return null;
  return { htmlText: serializeFragment(root.ownerDocument, output), plainText };
}

/** Copy a rendered message without touching the user's selection. */
export function extractMarkdownElement(root: HTMLElement): MarkdownClipboardContent {
  const fragment = root.ownerDocument.createDocumentFragment();
  for (const child of Array.from(root.childNodes)) {
    const rebuilt = rebuildNode(root.ownerDocument, child);
    if (rebuilt !== null) fragment.append(rebuilt);
  }
  return { htmlText: serializeFragment(root.ownerDocument, fragment), plainText: collectText(fragment).trim() };
}

export function handleMarkdownCopy(event: ClipboardEvent, root: HTMLElement): void {
  if (event.defaultPrevented || event.clipboardData === null) return;
  const content = extractMarkdownSelection(root);
  if (content === null) return;
  event.clipboardData.setData("text/html", content.htmlText);
  event.clipboardData.setData("text/plain", content.plainText);
  event.preventDefault();
}
