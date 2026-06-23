import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outRoot = join(process.cwd(), "out");

function walkHtml(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkHtml(path));
    } else if (entry.isFile() && path.endsWith(".html")) {
      files.push(path);
    }
  }
  return files;
}

function formatHead(head) {
  const compact = head.trim().replace(/\n\s*/g, "");
  if (!compact) return head;
  const formatted = compact
    .replaceAll("><", ">\n    <")
    .replace(/<script([^>]*)>\n\s*<\/script>/g, "<script$1></script>")
    .replace(/^/, "    ");
  return `\n${formatted}\n  `;
}

function formatHtml(html) {
  const headMatch = html.match(/<head>([\s\S]*?)<\/head>/i);
  if (!headMatch) return html;

  const formattedHead = `<head>${formatHead(headMatch[1])}</head>`;
  return html
    .replace("<!DOCTYPE html><html", "<!DOCTYPE html>\n<html")
    .replace(/(<html\b[^>]*>)<head>/i, "$1\n  <head>")
    .replace(headMatch[0], formattedHead)
    .replace("</head><body", "</head>\n  <body")
    .replace("</body></html>", "</body>\n</html>\n");
}

if (!existsSync(outRoot) || !statSync(outRoot).isDirectory()) {
  throw new Error(`missing Next static output directory: ${outRoot}`);
}

let changed = 0;
for (const file of walkHtml(outRoot)) {
  const html = readFileSync(file, "utf8");
  const next = formatHtml(html);
  if (next !== html) {
    writeFileSync(file, next);
    changed += 1;
  }
}

console.log(`[format-next-static-html] formatted ${changed} HTML files`);
