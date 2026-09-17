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
  assert.match(app, /@include typography\.role\(navigation-label, primary\)/u);
  assert.match(app, /@include typography\.role\(navigation-action, primary\)/u);
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
