import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { CONNECTOR_CATALOG } from "@opencraft/connector-core";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("service catalog owns one specific guide and has a local brand asset per entry", () => {
  for (const entry of CONNECTOR_CATALOG) {
    assert.equal(entry.steps.length, 1);
    assert.ok(!entry.steps[0].includes("在此填写并保存配置"));
    const root = `../apps/workbench-web/src/assets/connector-brands/${entry.id}`;
    assert.ok(["png", "svg"].some(extension => existsSync(new URL(`${root}.${extension}`, import.meta.url))), entry.id);
  }
});

test("replaced presentation has no settings-list catalog or test-only alternate manager", () => {
  const library = read("apps/workbench-web/src/components/connectors/connector-library.tsx");
  const chooser = read("apps/workbench-web/src/components/connectors/connector-panel.tsx");
  const css = read("apps/workbench-web/src/components/connectors/connector-library.scss");
  assert.ok(!library.includes("SettingsListItem"));
  assert.ok(!chooser.includes("setCatalog"));
  assert.ok(!chooser.includes("发现 Host 服务"));
  assert.ok(!chooser.includes('label: "连接器", size: "wide"'), "conversation selection is no longer a wide Modal");
  assert.match(chooser, /ConnectorAddMenuItem/u);
  assert.match(chooser, /ConnectorStatusChip/u);
  assert.match(chooser, /cancelOwner\(operationOwner\)/u);
  assert.doesNotMatch(chooser, /onDismiss:[\s\S]{0,120}cancelOwner/u, "closing a Popover does not own connection cancellation");
  assert.ok(!css.includes(".connector-library__setup"));
  assert.match(library, /presentation:\s*"inspector"/);
  assert.ok(!css.includes("font-size:"), "presentation consumes semantic typography roles");
});
