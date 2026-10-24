import { parse } from "acorn";
import path from "node:path";

/** Close Vite's emitted worker/asset graph; never substitute remote code. */
export function packageResourceGraph(code, assets) {
  const byUrl = new Map();
  for (const asset of assets) {
    for (const name of [asset.fileName, `/${asset.fileName}`, `./${asset.fileName}`, `./${path.basename(asset.fileName)}`, path.basename(asset.fileName)]) {
      if (byUrl.has(name) && byUrl.get(name) !== asset) throw new Error(`Ambiguous packaged asset: ${name}`);
      byUrl.set(name, asset);
    }
  }
  const used = new Set();
  const visiting = new Set();
  const memo = new Map();
  function replacement(asset) {
    used.add(asset.fileName);
    if (memo.has(asset.fileName)) return memo.get(asset.fileName);
    if (visiting.has(asset.fileName)) throw new Error(`Cyclic packaged resource: ${asset.fileName}`);
    visiting.add(asset.fileName);
    const source = typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString();
    const extension = path.extname(asset.fileName);
    let result;
    if ([".js", ".mjs"].includes(extension)) {
      const nested = rewrite(source);
      result = `URL.createObjectURL(new Blob([${JSON.stringify(nested)}],{type:"text/javascript"}))`;
    } else {
      const mime = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".wasm": "application/wasm" }[extension];
      if (!mime) throw new Error(`Unsupported packaged resource: ${asset.fileName}`);
      result = JSON.stringify(`data:${mime};base64,${Buffer.from(asset.source).toString("base64")}`);
    }
    visiting.delete(asset.fileName);
    memo.set(asset.fileName, result);
    return result;
  }
  function rewrite(source) {
    const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const edits = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "Literal" && typeof node.value === "string" && byUrl.has(node.value)) {
        edits.push({ start: node.start, end: node.end, value: replacement(byUrl.get(node.value)) });
        return;
      }
      if (node.type === "TemplateLiteral" && node.expressions.length === 0 && byUrl.has(node.quasis[0].value.cooked)) {
        edits.push({ start: node.start, end: node.end, value: replacement(byUrl.get(node.quasis[0].value.cooked)) });
        return;
      }
      if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source) {
        throw new Error("Worker contains an unpackaged module dependency");
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(tree);
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    return source;
  }
  const result = rewrite(code);
  const unused = assets.filter(asset => !used.has(asset.fileName));
  if (unused.length) throw new Error(`Unpackaged mobile resources: ${unused.map(asset => asset.fileName).join(", ")}`);
  return result;
}
