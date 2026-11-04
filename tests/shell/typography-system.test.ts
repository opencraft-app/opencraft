import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import test from "node:test";
import { compileString } from "sass";
import { fileURLToPath } from "node:url";


import {
  hasFullWidthOpeningPunctuation,
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
  const navigationItem = read("../apps/workbench-web/src/components/sidebar-navigation-item.tsx");
  const navigationPrimitive = read("../packages/design-system-web/src/navigation.tsx");
  const buttonStyles = read("../packages/design-system-web/src/button.web.scss");
  assert.match(navigationItem, /<NavigationItem/u);
  assert.match(navigationPrimitive, /size="navigation"/u);
  assert.match(buttonStyles, /\[data-size="navigation"\][\s\S]*?@include typography\.role\(navigation-action, primary\)/u);
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


test("shortcut help and notices consume local typography without duplicating global CSS", () => {
  const directory = fileURLToPath(new URL("../../packages/design-system/src/", import.meta.url));
  const globalTypography = compileString('@use "typography.web";', { loadPaths: [directory] }).css;
  const importer = { findFileUrl(url: string) {
    const prefix = "@opencraft/design-system/";
    return url.startsWith(prefix) ? new URL(`../../packages/design-system/src/${url.slice(prefix.length)}.scss`, import.meta.url) : null;
  } };
  for (const name of ["workbench-shortcut-help", "async-notices", "conversation-rename-dialog", "extensions/extension-library"]) {
    const source = read(`../apps/workbench-web/src/components/${name}.scss`);
    const url = new URL(`../../apps/workbench-web/src/components/${name}.scss`, import.meta.url);
    const actual = compileString(source, { importers: [importer], url }).css;
    const original = compileString(source.replace("typography-mixins.web", "typography.web"), { importers: [importer], url }).css;
    assert.ok(original.startsWith(globalTypography), `${name}: original global prefix is identified exactly`);
    assert.equal(actual, original.slice(globalTypography.length).trimStart(), `${name}: every authored component rule is preserved`);
    assert.doesNotMatch(actual, /:root|\.ui-text--/u);
    assert.ok(Buffer.byteLength(original) - Buffer.byteLength(actual) > 20000, `${name}: actual repeated CSS is removed`);
  }
  assert.match(read("../apps/workbench-web/src/styles/app.scss"), /@use "@opencraft\/design-system\/typography.web"/u,
    "application stylesheet retains global typography ownership");
});

test("optical start only selects fullwidth opening punctuation without rewriting titles", () => {
  for (const title of ["【虾米】建站后端", "（讨论）", "「主题」", "《文档》"]) {
    assert.equal(hasFullWidthOpeningPunctuation(title), true);
  }
  for (const title of ["OB", "hermes 升级", "账户注销", "[tag]", "(topic)", "】结束", " 【保留空格】", ""]) {
    assert.equal(hasFullWidthOpeningPunctuation(title), false);
  }
});
