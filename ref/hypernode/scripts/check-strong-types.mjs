import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const root = new URL("../policy/src/", import.meta.url);
const failures = [];

function visitDirectory(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) visitDirectory(child);
    else if (extname(name) === ".ts") visitFile(child);
  }
}

function visitFile(path) {
  const sourceText = readFileSync(path, "utf8");
  if (/@ts-(?:ignore|nocheck|expect-error)\b/.test(sourceText)) {
    failures.push(`${path}: TypeScript suppression directives are forbidden`);
  }
  if (/\bunknown\s+as\b/.test(sourceText)) {
    failures.push(`${path}: double assertions from unknown are forbidden`);
  }
  const explicitAny = /\bany\b/g;
  for (let match = explicitAny.exec(sourceText); match; match = explicitAny.exec(sourceText)) {
    const before = sourceText.slice(0, match.index);
    const line = before.split("\n").length;
    const column = match.index - before.lastIndexOf("\n");
    failures.push(`${path}:${line}:${column}: explicit any is forbidden`);
  }
}

visitDirectory(root.pathname);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("strong TypeScript policy passed");
