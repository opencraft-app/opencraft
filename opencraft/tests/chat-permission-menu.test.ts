import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../packages/codex-composer/src/codex-composer.tsx", import.meta.url), "utf8");
const menu = source.slice(source.indexOf('aria-label="Permissions"'), source.indexOf('<div ref={footerLayout.endRef}'));

test("permissions use only declared options within the existing accessible menu", () => {
  assert.match(menu, /catalogPermissions\.map/);
  assert.match(menu, /disabled=\{permission\.disabled\}/);
  assert.match(menu, /selectPermission\(permission\.value\)/);
  assert.doesNotMatch(menu, /DropdownMenu\.Label|AppServer default|selectPermission\(null\)/);
  assert.match(menu, /Loading permission profiles/);
  assert.match(menu, /Current permissions remain unchanged/);
});

test("inherited permission presentation reads the effective value without inventing a default", () => {
  const selection = source.slice(source.indexOf("  const selectedPermissionValue ="), source.indexOf("  const catalogQueryKind ="));
  assert.match(selection, /draft\.selections\.permissionProfile\s*\?\?\s*effectiveSelections\?\.permissionProfile\s*\?\? null/);
  assert.doesNotMatch(selection, /catalogPermissions\[0\]|dispatch|useEffect|isDefault/);
  assert.doesNotMatch(source, /"Default permissions"/);
});
