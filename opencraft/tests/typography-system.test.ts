import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  typographyRegistry,
  typographyRole,
} from "@opencraft/design-system/typography";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("one registry owns Web and Native typography role identities", () => {
  assert.equal(typographyRegistry.version, 1);
  assert.deepEqual(
    Object.keys(typographyRegistry.platforms.web.roles),
    Object.keys(typographyRegistry.platforms.native.roles),
  );
  assert.deepEqual(typographyRole("navigationAction", "web"), {
    family: "ui",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "400",
  });
  assert.equal(typographyRegistry.families.ui.web.startsWith("ui-sans-serif, system-ui"), true);
});

test("generated Web typography is checked in and feature styles consume semantic roles", () => {
  const generated = read("../packages/design-system/src/typography/_generated.web.scss");
  assert.match(generated, /DO NOT EDIT/u);
  assert.match(generated, /--typography-navigation-action-size: 14px/u);
  assert.match(generated, /--typography-thread-title-line-height: 20px/u);

  const controls = read("../packages/design-system/src/controls.web.scss");
  assert.match(controls, /@include typography\.role\(navigation-action, primary\)/u);
  assert.doesNotMatch(controls, /font-weight:\s*400/u);

  const app = read("../apps/workbench-web/src/styles/app.scss");
  assert.match(
    app,
    /\.lightvela-work-navigation__items[\s\S]*?@include controls\.navigation-control/u,
  );
  assert.match(app, /@include typography\.role\(thread-title, primary\)/u);
  assert.doesNotMatch(app, /-webkit-font-smoothing:\s*antialiased/u);
  assert.doesNotMatch(app, /font-weight:\s*(?:520|550)/u);
});

test("OpenCraft contributor policy names the typography authority and topology", () => {
  const agents = read("../AGENTS.md");
  assert.match(agents, /Typography 所有权/u);
  assert.match(agents, /typography\.tokens\.json/u);
  assert.match(agents, /TextTone/u);
  assert.match(agents, /不得直接编辑.*_generated\.web\.scss/u);
});

test("compact filter Selects consume the shared control-token contract", () => {
  const tokens = read("../packages/design-system/src/tokens.web.scss");
  const sharedTokens = read("../packages/design-system/src/tokens.shared.ts");
  const select = read("../plugins/lightvela-hermes/src/upstream/mono2/components/ui/select.tsx");
  const filterStyles = read("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-config/standard-panel.css");
  const skills = read("../plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/skills-demo/SkillsDemoPanel.tsx");

  assert.match(tokens, /--height-filter-control: 36px/u);
  assert.match(tokens, /--width-filter-control: 160px/u);
  assert.match(sharedTokens, /filterHeight: 36/u);
  assert.match(sharedTokens, /filterWidth: 160/u);
  assert.match(select, /type SelectVariant = "default" \| "filter"/u);
  assert.match(select, /variant\?: SelectVariant/u);
  assert.match(select, /lv-select-trigger--filter/u);
  assert.match(select, /lv-select-content--filter/u);
  assert.match(select, /lv-select-item--filter/u);
  assert.match(filterStyles, /\.lv-select-trigger--filter[\s\S]*var\(--height-filter-control/u);
  assert.match(filterStyles, /\.lv-select-content--filter[\s\S]*var\(--radix-select-trigger-width/u);
  assert.match(filterStyles, /\.lv-select-item--filter[\s\S]*var\(--height-menu-item/u);
  assert.match(skills, /<SelectTrigger[\s\S]*?variant="filter"/u);
  assert.match(skills, /<SelectContent[\s\S]*variant="filter"/u);
  assert.doesNotMatch(skills, /INSTALLED_FILTER_(?:TRIGGER|CONTENT|ITEM)/u);
});
