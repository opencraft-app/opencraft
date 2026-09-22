import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

const root = fileURLToPath(new URL("../", import.meta.url));
const descriptors = new Map();
const errors = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "locales") await scan(path); continue; }
    if (!/\.tsx?$/.test(path)) continue;
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
    function record(id, defaultMessage, description) {
      if (!id || !defaultMessage) return;
      const previous = descriptors.get(id);
      if (previous && previous.defaultMessage !== defaultMessage) errors.push(`Conflicting defaultMessage for ${id}`);
      descriptors.set(id, { defaultMessage, ...(description ? { description } : {}), source: relative(root, path) });
    }
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const fields = Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(source), literal(p.initializer)]));
        record(fields.id, fields.defaultMessage, fields.description);
      }
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === "FormattedMessage") {
        const fields = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(p => [p.name.getText(source), literal(p.initializer)]));
        record(fields.id, fields.defaultMessage, fields.description);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
// These are the application-owned catalogs. Vendored feature translations have
// their own extraction authority and must not be silently imported here.
await scan(join(root, "apps/workbench-web/src"));
await scan(join(root, "packages/codex-composer/src"));
function parameters(message) {
  const found = new Set();
  function visit(elements) {
    for (const element of elements) {
      if (element.type !== TYPE.literal && element.type !== TYPE.pound) found.add(element.value);
      if (element.options) Object.values(element.options).forEach(option => visit(option.value));
      if (element.children) visit(element.children);
    }
  }
  visit(parse(message));
  return [...found].sort().join(",");
}
const localeDirectory = join(root, "apps/workbench-web/src/i18n/locales");
for (const file of await readdir(localeDirectory)) {
  if (!file.endsWith(".json")) continue;
  const messages = JSON.parse(await readFile(join(localeDirectory, file), "utf8"));
  for (const [id, descriptor] of descriptors) {
    try {
      const expected = parameters(descriptor.defaultMessage);
      if (typeof messages[id] !== "string") errors.push(`${file}: missing ${id}`);
      else if (parameters(messages[id]) !== expected) errors.push(`${file}: ICU parameter mismatch for ${id}`);
    } catch (error) { errors.push(`${file}: invalid ICU for ${id}: ${error.message}`); }
  }
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`i18n: ${descriptors.size} source messages, unique IDs, valid ICU and translation parameters verified.`);
// A reviewable translation handoff, not a second runtime English catalog.
const outputIndex = process.argv.indexOf("--extract");
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (!output) throw new Error("--extract requires an output path");
  await writeFile(output, JSON.stringify(Object.fromEntries([...descriptors].sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
}
