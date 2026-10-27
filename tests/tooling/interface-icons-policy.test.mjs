import assert from "node:assert/strict";
import test from "node:test";
import { inspectInterfaceIcons, inspectInterfaceIconStyles } from "../../scripts/check-interface-icons.mjs";

test("dependency defaults and browser arrows require explicit shared artwork", () => {
  const imports = 'import { ChevronDownIcon as Arrow } from "@opencraft/design-system-web/action-icons";';
  for (const source of [
    'import { Toaster as Notices } from "sonner"; const x = <Notices/>;',
    'const x = <label>Provider<select><option>A</option></select></label>;',
    'const x = <details><summary>Details</summary></details>;',
  ]) assert.ok(inspectInterfaceIcons(source, "fixture.tsx").length > 0);
  for (const source of [
    'import { Toaster as Notices } from "sonner"; const x = <Notices icons={sharedIcons}/>;',
    imports + 'const x = <span><select/><Arrow/></span>;',
    imports + 'const x = <span><select>{options}</select>{multiple ? null : <Arrow/>}</span>;',
    'const x = <details><summary className="ui-native-disclosure">Details</summary></details>;',
    imports + 'const x = <summary><span>Details<Arrow/></span></summary>;',
  ]) assert.deepEqual(inspectInterfaceIcons(source, "fixture.tsx"), []);
});

test("stock artwork is rejected through aliases, registries and re-exports", () => {
  for (const source of [
    'import { House as H } from "lucide-react"; const registry = { home: H };',
    'export { Bot } from "lucide-react";',
    'import * as Stock from "lucide-react";',
    'import { Check as Mark } from "lucide-react-native";',
    'export { Copy } from "lucide-react-native";',
  ]) assert.equal(inspectInterfaceIcons(source, "plugins/example/src/view.tsx").length, 1);
});

test("generated controls cannot escape ownership through font characters", () => {
  for (const source of [
    'const button = <button><span aria-hidden>↵</span></button>;',
    'const add = <button>＋</button>;',
    'const empty = <AvatarImage fallback={assigned ? initials : "○"} />;',
    'const priority = <span>{high ? "↑" : "↓"}</span>;',
    'const preview = <li>{checked ? "☑ " : "☐ "}</li>;',
    'const back = <button>‹ Channels</button>;',
    'const next = <button>Customize →</button>;',
  ]) assert.ok(inspectInterfaceIcons(source, "plugins/example/src/view.tsx").length > 0);
  for (const source of [
    'const shortcut = <button>Continue<kbd>↵</kbd></button>;',
    'const dimensions = <span>800 × 600</span>;',
    'const history = <p>{`${from} → ${to}`}</p>;',
    'const deletions = <i>−{change.deletions}</i>;',
    'const content = <p>{userContent}</p>;',
    'const title = <span title="↑">Priority</span>;',
  ]) assert.deepEqual(inspectInterfaceIcons(source, "plugins/example/src/view.tsx"), []);
});

test("CSS spinners and pseudo-element copy/check drawings cannot bypass ownership", () => {
  for (const source of [
    '.busy { border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 1s infinite; }',
    '.status { &.is-running { border: 1.5px solid gray; border-top-color: black; animation: spin 1s infinite; } }',
    '.chat-code-action__copy::before { content: ""; border: 1px solid; }',
    '.chat-code-action__check::before { content: ""; border: solid; transform: rotate(45deg); }',
  ]) assert.equal(inspectInterfaceIconStyles(source, "fixture.scss").length, 1);
  assert.deepEqual(inspectInterfaceIconStyles('.button { border: 1px solid currentColor; } .glyph { animation: spin 1s infinite; } .frame::before { content: ""; border: 1px solid; }', "fixture.scss"), []);
});
test("inline controls and former layout-library exemptions are rejected; shared artwork and avatars are accepted", () => {
  assert.equal(inspectInterfaceIcons("const icon = <svg><path d='M1 1'/></svg>", "packages/chat-render-web/src/control.tsx").length, 1);
  assert.deepEqual(inspectInterfaceIcons("const icon = <svg/>", "packages/design-system-web/src/interface-icons.tsx"), []);
  assert.deepEqual(inspectInterfaceIcons("const avatar = <svg/>", "plugins/bot-chat/src/bot-avatar.tsx"), []);
  const retained = "packages/design-system-web/src/retained-layout-icons.tsx";
  assert.equal(inspectInterfaceIcons('export { PanelLeft as SidebarLayoutIcon, PanelLeftClose as SidebarCollapseLayoutIcon } from "lucide-react";', retained).length, 1);
  assert.equal(inspectInterfaceIcons('export { House } from "lucide-react";', retained).length, 1);
});


test("native glyph imports and font substitutes follow shared ownership", () => {
  for (const file of ["packages/chat-render-native/src/example.tsx", "apps/mobile/src/example.tsx"]) {
    assert.equal(inspectInterfaceIcons('const x = <Text>↵</Text>;', file).length, 1);
    assert.equal(inspectInterfaceIcons('import { Check } from "lucide-react-native";', file).length, 1);
    assert.deepEqual(inspectInterfaceIcons('import { CheckIcon } from "@opencraft/design-system-native/action-icons"; const x = <CheckIcon/>;', file), []);
  }
});
