import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import test from "node:test";
import { compileString } from "sass";
import { fileURLToPath } from "node:url";


import {
  typographyRegistry,
  typographyRole,
} from "@opencraft/design-system/typography";


const read = (path: string) => readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");


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
  assert.equal(typographyRegistry.families.ui.web.startsWith('"Inter Variable", Inter, ui-sans-serif, system-ui'), true);
  assert.deepEqual(typographyRole("panelEmptyTitle", "web"), {
    family: "ui", fontSize: 18, lineHeight: 24, fontWeight: "500",
  });
});


test("generated Web typography is checked in and feature styles consume semantic roles", () => {
  const generated = read("../packages/design-system/src/typography/_generated.web.scss");
  assert.match(generated, /DO NOT EDIT/u);
  assert.match(generated, /--typography-navigation-action-size: 14px/u);
  assert.match(generated, /--typography-thread-title-line-height: 20px/u);
  assert.match(generated, /--typography-thread-list-title-size: 13px/u);

  const controls = read("../packages/design-system/src/controls.web.scss");
  assert.match(controls, /@include typography\.role\(navigation-action, primary\)/u);
  assert.doesNotMatch(controls, /font-weight:\s*400/u);

  const app = read("../apps/workbench-web/src/styles/app.scss");
  assert.match(
    app,
    /\.workbench-tool-navigation__items[\s\S]*?@include controls\.navigation-control/u,
  );
  assert.match(app, /@include typography\.role\(thread-title, primary\)/u);
  assert.doesNotMatch(app, /-webkit-font-smoothing:\s*antialiased/u);
  assert.doesNotMatch(app, /font-weight:\s*(?:520|550)/u);
});


test("OpenCraft contributor policy names the typography authority and topology", () => {
  const agents = read("../AGENTS.md") + read("../design/ui/typography.md");
  assert.match(agents, /Typography 所有权/u);
  assert.match(agents, /typography\.tokens\.json/u);
  assert.match(agents, /TextTone/u);
  assert.match(agents, /不得直接编辑.*_generated\.web\.scss/u);
});


test("iPhone Web keeps editable text legible without focus zoom and locks app viewport scaling", () => {
  const html = read("../apps/workbench-web/index.html");
  const app = read("../apps/workbench-web/src/styles/app.scss");
  assert.match(html, /name="viewport"[^>]*maximum-scale=1[^>]*user-scalable=no/u);
  assert.match(app, /\.opencraft-composer-editor\s*\{[\s\S]*?font: var\(--typography-composer-font\)/u,
    "desktop Composer typography remains unchanged");
  assert.match(app, /@media\s*\(max-width:\s*767px\)\s*and\s*\(any-pointer:\s*coarse\)/u);
  assert.match(app, /\[contenteditable="true"\][\s\S]*?font-size:\s*max\(var\(--typography-mobile-input-size\),\s*1rem\)\s*!important/u);
  assert.match(app, /pre\s*\{\s*font-size:\s*var\(--typography-mobile-input-size\)/u);
});

test("shared filter controls retain their authored dimensions", () => {
  const tokens = read("../packages/design-system/src/tokens.web.scss");
  const sharedTokens = read("../packages/design-system/src/tokens.shared.ts");
  assert.match(tokens, /--height-filter-control: 36px/u);
  assert.match(tokens, /--width-filter-control: 160px/u);
  assert.match(sharedTokens, /filterHeight: 36/u);
  assert.match(sharedTokens, /filterWidth: 160/u);
});


test("local typography mixins emit no global variables but the global adapter provides them", () => {
  const directory = fileURLToPath(new URL("../../packages/design-system/src/", import.meta.url)).replaceAll("\\", "/");
  const local = compileString('@use "typography-mixins.web" as typography; .probe { @include typography.role(count-badge, tertiary); }', { loadPaths: [directory] }).css;
  assert.doesNotMatch(local, /:root|--font-family-ui:/u);
  assert.match(local, /font-family: var\(--typography-count-badge-family\)/u);
  assert.match(local, /color: var\(--color-text-tertiary\)/u);
  const global = compileString('@use "typography.web";', { loadPaths: [directory] }).css;
  assert.match(global, /--font-family-count:/u);
  assert.match(global, /--typography-count-badge-weight: 700/u);
});
