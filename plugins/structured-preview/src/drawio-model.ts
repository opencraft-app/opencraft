import { Inflate } from "fflate";

const MAX_XML = 16 * 1024 * 1024;
function parseXml(source: string): XMLDocument {
  if (source.length > MAX_XML || /<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error("Unsupported diagram XML");
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid diagram XML");
  return doc;
}

/** Expand draw.io's base64/raw-DEFLATE URI-encoded pages with a bounded output. */
export function normalizeDrawio(source: string): string {
  const doc = parseXml(source);
  const root = doc.documentElement;
  if (root.tagName !== "mxfile" && root.tagName !== "mxGraphModel") throw new Error("Not a Draw.io document");
  if (root.tagName === "mxfile") {
    const pages = Array.from(root.children);
    if (pages.length === 0 || pages.length > 100 || pages.some(page => page.tagName !== "diagram")) throw new Error("Unsupported diagram pages");
    let total = 0;
    for (const page of pages) {
      if (!page.firstElementChild) {
        const content = (page.textContent ?? "").trim();
        if (content.startsWith("<")) page.replaceChildren(doc.importNode(parseXml(content).documentElement, true));
        else {
          const binary = atob(content), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
          const decoder = new TextDecoder("utf-8", { fatal: true }); let expanded = "", size = 0;
          const inflate = new Inflate((chunk, final) => {
            size += chunk.length;
            if (size > MAX_XML) throw new Error("Diagram page exceeds preview limits");
            expanded += decoder.decode(chunk, { stream: !final });
          });
          for (let offset = 0; offset < bytes.length; offset += 16384) inflate.push(bytes.subarray(offset, offset + 16384), offset + 16384 >= bytes.length);
          page.replaceChildren(doc.importNode(parseXml(decodeURIComponent(expanded)).documentElement, true));
        }
      }
      if (page.children.length !== 1 || page.firstElementChild?.tagName !== "mxGraphModel") throw new Error("Invalid diagram page");
      total += new XMLSerializer().serializeToString(page).length;
      if (total > MAX_XML) throw new Error("Diagram exceeds preview limits");
    }
    root.setAttribute("compressed", "false");
  }
  if (doc.getElementsByTagName("mxCell").length > 50_000) throw new Error("Diagram exceeds preview limits");
  return new XMLSerializer().serializeToString(doc);
}
