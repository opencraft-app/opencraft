import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasPermissionProfileChoices } from "../packages/codex-composer/src/codex-composer.js";

const source = readFileSync(new URL("../packages/codex-composer/src/codex-composer.tsx", import.meta.url), "utf8");
const menu = source.slice(source.indexOf('aria-label="Permissions"'), source.indexOf('<div ref={footerLayout.endRef}'));

test("permission picker is hidden when the Host declares no permission profiles", () => {
  assert.equal(hasPermissionProfileChoices([]), false);
  assert.equal(hasPermissionProfileChoices([{
    id: ":workspace",
    value: ":workspace",
    label: "Workspace",
    description: null,
    disabled: false,
  }]), true);
});

test("permissions use only declared options within the existing accessible menu", () => {
  assert.match(source, /showPermissionPicker \? <DropdownMenu\.Root[\s\S]*aria-label="Permissions"/);
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
