import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const component = (name) => new URL(`../../apps/workbench-web/src/components/${name}`, import.meta.url);

test("website update navigation leaves settings form and upgrade controls in a deferred module", async () => {
  const shell = await readFile(component("web-updates-settings.tsx"), "utf8");
  const content = await readFile(component("web-updates-settings-content.tsx"), "utf8");
  assert.match(
    shell,
    /createDeferredView\(async \(\) => \(await import\("\.\/web-updates-settings-content"\)\)\.WebUpdatesSettings\)/,
  );
  assert.doesNotMatch(shell, /from ['"]\.\/full-upgrade-settings['"]/);
  assert.match(shell, /export function useManagedWebUpdateNotice\(/);
  assert.match(content, /from ['"]\.\/full-upgrade-settings['"]/);
  assert.match(content, /export function WebUpdatesSettings\(/);
  assert.match(content, /useUpdates\(\)/);
});
