import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// HeroUI Native 1.0.10 waits for a second onLayout with a new y coordinate.
// RN Web uses ResizeObserver, which does not report a position-only change.
// Once dimensions are known, Menu's own positioning primitive computes the
// position in that render. Readiness must depend on dimensions, not the old
// off-screen probe coordinate (and y=0 is a legitimate native position).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "apps/workbench-expo/package.json"));
const packageJsonPath = require.resolve("heroui-native/package.json");
const packageRoot = dirname(packageJsonPath);
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (version !== "1.0.10") throw new Error("Review the HeroUI Menu measurement patch for this library version.");

const before = "const isReady = Boolean(contentLayout?.y && contentLayout.y < screenHeight);";
const after = "const isReady = Boolean(contentLayout && contentLayout.width > 0 && contentLayout.height > 0);";
const edits = ["src/components/menu/menu.tsx", "lib/module/components/menu/menu.js"].map(relative => {
  const path = resolve(packageRoot, relative);
  const source = readFileSync(path, "utf8");
  if (source.includes(after) && !source.includes(before)) return { path, source, changed: false };
  if (source.split(before).length !== 2) throw new Error(`Unexpected HeroUI Menu measurement source: ${relative}`);
  return { path, source: source.replace(before, after), changed: true };
});
for (const edit of edits) if (edit.changed) writeFileSync(edit.path, edit.source);
console.log("HeroUI Native Menu measurement compatibility patch ready.");
