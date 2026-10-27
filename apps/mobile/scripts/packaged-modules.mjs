import { parse } from "acorn";
import { createHash } from "node:crypto";
import path from "node:path";
import { packageResourceGraph } from "./packaged-resources.mjs";

/** Keep the Web module graph lazy; only static dependencies precede a module. */
export function packageModules(chunks, assets) {
  const names = new Set(chunks.map(chunk => chunk.fileName));
  const modules = {};
  const resources = new Map();
  const used = new Set();
  const entry = chunks.find(chunk => chunk.isEntry);
  if (!entry || chunks.filter(chunk => chunk.isEntry).length !== 1) throw new Error("Expected one mobile entry");
  for (const chunk of chunks) {
    const imports = [];
    const edits = [];
    const resolve = value => {
      const name = path.posix.normalize(path.posix.join(path.posix.dirname(chunk.fileName), value));
      if (!names.has(name)) throw new Error(`Unpackaged module ${value} in ${chunk.fileName}`);
      return name;
    };
    const visit = node => {
      if (!node || typeof node !== "object") return;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
        const child = resolve(node.source.value);
        const token = `opencraft-module:${imports.length}:${child}`;
        imports.push([token, child]);
        edits.push({ start: node.source.start, end: node.source.end, value: JSON.stringify(token) });
        return;
      }
      if (node.type === "ImportExpression") {
        // Plugin loaders can contain computed imports. They still go through
        // the fixed registry, so URLs/blob scripts cannot become executable.
        const literal = node.source.type === "Literal" && typeof node.source.value === "string" ? node.source.value
          : node.source.type === "TemplateLiteral" && node.source.expressions.length === 0 ? node.source.quasis[0].value.cooked : null;
        const argument = literal === null ? chunk.code.slice(node.source.start, node.source.end) : JSON.stringify(resolve(literal));
        edits.push({ start: node.start, end: node.end, value: `globalThis.__opencraftPackagedImport(${argument})` });
        return;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    };
    visit(parse(chunk.code, { ecmaVersion: "latest", sourceType: "module" }));
    let code = chunk.code;
    for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.value + code.slice(edit.end);
    code = packageResourceGraph(code, assets, { used, allowUnused: true, allowModuleImports: true });
    const resourceId = createHash("sha256").update(code).digest("hex");
    resources.set(resourceId, code);
    modules[chunk.fileName] = { resourceId, imports };
  }
  const unused = assets.filter(asset => !used.has(asset.fileName));
  if (unused.length) throw new Error(`Unpackaged mobile resources: ${unused.map(asset => asset.fileName).join(", ")}`);
  // Blob module URLs must be known before linking static imports. Reject a
  // static cycle at build time rather than leaving a device waiting forever.
  const visited = new Set();
  const visiting = new Set();
  const check = id => {
    if (visiting.has(id)) throw new Error(`Static mobile chunk cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const [, child] of modules[id].imports) check(child);
    visiting.delete(id); visited.add(id);
  };
  for (const id of names) check(id);
  return { manifest: { entry: entry.fileName, modules }, resources };
}
