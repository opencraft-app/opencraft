import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// A touch gesture may lock an axis; a later wheel event has its own deltas.
// Keep Radix's modal isolation while preventing a stale touch axis from
// cancelling valid wheel scrolling on devices with both input methods.
const require = createRequire(import.meta.url);
const packagePath = require.resolve("react-remove-scroll/package.json");
const root = dirname(packagePath);
if (JSON.parse(readFileSync(packagePath, "utf8")).version !== "2.7.2") {
  throw new Error("Review the react-remove-scroll input-axis patch for this version.");
}
const before = "activeAxis.current || currentAxis";
const after = "(('changedTouches' in event) && activeAxis.current) || currentAxis";
const edits = ["es5", "es2015", "es2019"].map((format) => {
  const path = resolve(root, "dist", format, "SideEffect.js");
  const source = readFileSync(path, "utf8");
  if (source.includes(after)) return { path, source, changed: false };
  if (source.split(before).length !== 2) throw new Error(`Unexpected scroll-lock source: ${format}`);
  return { path, source: source.replace(before, after), changed: true };
});
for (const edit of edits) if (edit.changed) writeFileSync(edit.path, edit.source);
console.log("Modal scroll-lock input-axis compatibility patch ready.");
