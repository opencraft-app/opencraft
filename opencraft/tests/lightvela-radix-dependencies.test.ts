import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const pluginUrl = new URL("../plugins/lightvela-hermes/package.json", import.meta.url);
const plugin = JSON.parse(readFileSync(pluginUrl, "utf8")) as { dependencies: Record<string, string> };
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { version?: string }> };

test("the plugin declares every directly imported Radix primitive instead of relying on the host's transitive packages", () => {
  for (const name of ["alert-dialog", "checkbox", "dropdown-menu", "switch", "tooltip", "popover", "slot"]) {
    const dependency = `@radix-ui/react-${name}`;
    assert.ok(plugin.dependencies[dependency], `missing direct ${dependency}`);
    assert.equal(plugin.dependencies[dependency], lock.packages[`node_modules/${dependency}`]?.version);
  }
});

test("generated and Workbench modal owners resolve the same installed Radix focus and dismissable-layer modules", () => {
  const owners = [createRequire(pluginUrl), createRequire(new URL("../apps/workbench-web/package.json", import.meta.url))];
  const scopes = new Set<string>();
  const layers = new Set<string>();
  for (const owner of owners) {
    for (const primitive of ["dialog", "alert-dialog", "popover", "select", "dropdown-menu", "tooltip"]) {
      const requirePrimitive = createRequire(owner.resolve(`@radix-ui/react-${primitive}`));
      scopes.add(requirePrimitive.resolve("@radix-ui/react-focus-scope"));
      layers.add(requirePrimitive.resolve("@radix-ui/react-dismissable-layer"));
    }
  }
  assert.equal(scopes.size, 1, "nested focus ownership must be shared");
  assert.equal(layers.size, 1, "nested Escape/pointer ownership must be shared");
  assert.equal(lock.packages["node_modules/@radix-ui/react-focus-scope"]?.version, "1.1.16");
  assert.equal(lock.packages["node_modules/@radix-ui/react-dismissable-layer"]?.version, "1.1.19");
});
