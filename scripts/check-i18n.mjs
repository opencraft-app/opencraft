import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

import { scanProject, compareCopy } from "./i18n-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const inventory = await scanProject(root);
const errors = [];
const descriptors = new Map();
const desktopDescriptors = new Map();
for (const { id, ...descriptor } of inventory.messages) {
  // Native Main has its own application runtime/catalog, not Web's languages.
  const catalog = descriptor.source.startsWith("apps/workbench-electron/") ? desktopDescriptors : descriptors;
  const previous = catalog.get(id);
  if (previous && previous.defaultMessage !== descriptor.defaultMessage) errors.push(`Conflicting defaultMessage for ${id}`);
  catalog.set(id, descriptor);
}
const baseline = JSON.parse(await readFile(join(root, "config/i18n-copy-baseline.json"), "utf8"));
if (baseline.version !== 1 || !Array.isArray(baseline.entries)) throw new Error("Unsupported i18n copy baseline");
errors.push(...compareCopy(inventory.copy, baseline));
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
async function checkCatalogs(directory, messages) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".json")) continue;
    const translations = JSON.parse(await readFile(join(directory, file), "utf8"));
    for (const [id, descriptor] of messages) {
      try {
        const expected = parameters(descriptor.defaultMessage);
        if (typeof translations[id] !== "string") errors.push(`${relative(root, directory)}/${file}: missing ${id}`);
        else if (file === "en-US.json" && translations[id] !== descriptor.defaultMessage) errors.push(`${file}: derived English copy differs from source for ${id}`);
        else if (parameters(translations[id]) !== expected) errors.push(`${file}: ICU parameter mismatch for ${id}`);
      } catch (error) { errors.push(`${file}: invalid ICU for ${id}: ${error.message}`); }
    }
  }
}
await checkCatalogs(join(root, "apps/workbench-web/src/i18n/locales"), descriptors);
await checkCatalogs(join(root, "apps/workbench-electron/src/locales"), desktopDescriptors);
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`i18n: ${inventory.files.length} first-party files; ${descriptors.size} Web/shared and ${desktopDescriptors.size} native messages verified. ${inventory.copy.length} legacy literal occurrences remain explicitly recorded (not translated).`);
const reportIndex = process.argv.indexOf("--report");
if (reportIndex >= 0) {
  const output = process.argv[reportIndex + 1];
  if (!output) throw new Error("--report requires an output path");
  await writeFile(output, JSON.stringify({ filesScanned: inventory.files.length, legacyCandidates: inventory.copy, limitations: ["Indirect identifier/object/helper data flow and imperative notifications require owner review.", "Literal candidates include intentional names, units and technical examples; this is not a confirmed-defect count."] }, null, 2) + "\n");
}
// A reviewable translation handoff, not a second runtime English catalog.
const outputIndex = process.argv.indexOf("--extract");
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (!output) throw new Error("--extract requires an output path");
  await writeFile(output, JSON.stringify(Object.fromEntries([...descriptors].sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
}
