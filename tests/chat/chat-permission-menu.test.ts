import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { registerHooks } from "node:module";

// This Node suite renders markup; browser styles are exercised by smoke tests.
const styles = registerHooks({
  load(url, context, nextLoad) {
    return /\.(?:css|scss)$/u.test(new URL(url).pathname)
      ? { format: "module", source: "export default {};", shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { hasPermissionProfileChoices } = await import("../../packages/composer-editor/src/composer-editor.js");
styles.deregister();

const source = readFileSync(new URL("../../packages/composer-editor/src/composer-editor.tsx", import.meta.url), "utf8");
const menu = source.slice(source.indexOf('aria-label={permissionsLabel}'), source.indexOf('<div ref={footerLayout.endRef}'));

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
  assert.match(source, /showPermissionPicker \? <DropdownMenu\.Root[\s\S]*aria-label=\{permissionsLabel\}/);
  assert.match(source, /const permissionsLabel = intl\.formatMessage\(\{ id: "composer\.permissions"/);
  assert.match(menu, /catalogPermissions\.map/);
  assert.match(menu, /disabled=\{permission\.disabled\}/);
  assert.match(menu, /selectPermission\(permission\.value\)/);
  assert.doesNotMatch(menu, /DropdownMenu\.Label|AppServer default|selectPermission\(null\)/);
  assert.match(menu, /Loading permission profiles/);
  assert.match(menu, /Current permissions remain unchanged/);
  assert.match(menu, /data-permission-kind=\{permission\.mode == null \? "native" : "standard"\}/);
  assert.match(menu, /Engine profiles/);
});

test("inherited permission presentation reads the effective value without inventing a default", () => {
  const selection = source.slice(source.indexOf("  const requestedPermissionValue ="), source.indexOf("  const catalogQueryKind ="));
  assert.match(selection, /draft\.selections\.permissionProfile\s*\?\? effectivePermissionValue/);
  assert.match(selection, /requestedPermissionValue === null \? null/);
  assert.match(selection, /permission\.nativeProfileId === requestedPermissionValue/);
  assert.doesNotMatch(selection, /catalogPermissions\[0\]|dispatch|useEffect|isDefault/);
  assert.doesNotMatch(source, /"Default permissions"/);
  assert.match(source, /permissionChangePending[\s\S]*composer.permissions.nextTurn/);
});


async function renderPermission(mode: string | null, requested: string | null = null, localeId = "zh-CN", native = false) {
  const React = (await import("react")).default;
  globalThis.React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LocaleRuntime } = await import("@opencraft/i18n");
  const { IntlRuntimeProvider } = await import("@opencraft/i18n/react");
  const { createComposerController } = await import("@opencraft/composer-core");
  const { OpenCraftComposer } = await import("@opencraft/composer-editor");
  const { default: zh } = await import("../../apps/workbench-web/src/i18n/locales/zh-CN.json");
  const locale = new LocaleRuntime([{ locale: "zh-CN", label: "中文", load: async () => zh }]);
  await locale.update({ localeOverride: localeId });
  const controller = createComposerController({ type: "existing-thread", key: { hostId: "fixture", threadId: "one" } }, { now: Date.now, createId: () => "one" });
  if (requested) controller.dispatch({ type: "set-selections", patch: { permissionProfile: requested } });
  return renderToStaticMarkup(React.createElement(IntlRuntimeProvider, { runtime: locale },
    React.createElement(OpenCraftComposer, { controller, effectiveSelections: { permissionProfile: mode },
      selectionCatalog: { models: [], permissionProfiles: ["read-only", "accept-edits", "auto", "full"].map(value => ({
        id: value, value, label: native ? "Custom Policy" : value, mode: native ? null : value,
        description: null, disabled: false,
      })) }, onSubmit: () => false, onCancel: () => {} })));
}

test("real Composer renders Chinese permission names and pending change hints", async () => {
  assert.match(await renderPermission(null), />权限</u);
  for (const [mode, label] of [["read-only", "只读"], ["accept-edits", "允许编辑"], ["auto", "自动审核"], ["full", "完全访问"]]) {
    assert.match(await renderPermission(mode), new RegExp(`>${label}<`, "u"));
  }
  assert.match(await renderPermission("read-only", "full"), /完全访问 · 下一轮生效/u);
  assert.match(await renderPermission("full", null, "en-US"), />Full access</u);
  assert.match(await renderPermission("full", null, "zh-CN", true), />Custom Policy</u);
});
