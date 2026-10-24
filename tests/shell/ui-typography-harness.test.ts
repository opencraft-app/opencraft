import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { inspectStyle, inspectTypescript, classify, scanRepository } from "../../scripts/check-ui-typography.mjs";
import { typographyRegistry, typographyRole, nativeMonoFontFamily } from "@opencraft/design-system/typography";

const read = (path: string) => readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");

test("source parser catches the historical model-menu override and equivalent shorthand", () => {
  assert.equal(inspectStyle('.model { /* font-size: 99px; */ font-size: 12px; }').length, 1);
  assert.equal(inspectStyle('.model { font: 500 12px/18px Inter; }').length, 1);
  assert.equal(inspectStyle('.model { font-weight: 650; letter-spacing: -.035em; }').length, 2);
  assert.equal(inspectStyle('.x { font: var(--typography-control-compact-font); }').length, 0);
  assert.equal(inspectStyle('.x { font: var(--typography-invented-font); }').length, 1);
  assert.equal(inspectStyle('.x { font-family: var(--font-family-invented); }').length, 1);
  assert.equal(inspectStyle('.x { --typography-local-size:12px; }').length, 1);
});

test("inline, conditional and utility forms cannot bypass the same policy", () => {
  assert.equal(inspectTypescript('const s={fontSize:12,"fontWeight":"600"}').length, 2);
  assert.equal(inspectTypescript('const s={fontWeight: selected ? "600" : "400"}').length, 1);
  assert.equal(inspectTypescript('const s={fontSize:`12px`}').length, 1);
  assert.equal(inspectTypescript('const s={fontSize:typographyRole("body","web").fontSize+3}').length, 1);
  assert.equal(inspectTypescript('const el=<div className="text-[15px] font-[650]"/>').length, 2);
  assert.equal(inspectTypescript('const el=<div className="text-sm font-semibold leading-6"/>').length, 3);
  assert.equal(inspectTypescript('const s={fontSize: typographyRole("body", "web").fontSize}').length, 0);
  assert.equal(inspectTypescript('const el=<div className="ui-text--metadata flex gap-2"/>').length, 0);
  assert.equal(inspectTypescript('const el=<div className="ui-text--invented"/>').length, 1);
  assert.equal(inspectTypescript('const s={"font-size":"12px"}').length, 1);
  assert.equal(inspectTypescript('interface Shape {fontSize:number}; const translated="fontSize:12";').length, 0);
});

test("exceptions are exact specialist declarations, with stale detection and no UI baseline", () => {
  const found = inspectStyle('.pdf {font-size:12px}');
  assert.equal(classify(found, found).errors.length, 0);
  assert.equal(classify(inspectStyle('.other {font-size:12px}'), found).errors.length, 1);
  assert.equal(classify([], found).stale.length, 1);
  const policy = JSON.parse(read("../design/ui/typography-exceptions.json"));
  assert.ok(policy.exceptions.every((e: any) => e.owner && e.reason && e.reviewWhen && !e.file.includes('*')));
  const result = classify(scanRepository(), policy.exceptions);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.stale, []);
});

test("semantic usage contracts prevent valid-token misuse on core paths", () => {
  for (const platform of ["web", "native"] as const) {
    for (const role of ["control", "controlSmall", "controlLarge", "controlCompact", "metadata"] as const) {
      assert.equal(typographyRole(role, platform).fontWeight, "400", `${platform}/${role}`);
    }
    assert.equal(typographyRole("primaryAction", platform).fontWeight, "500");
    assert.equal(typographyRole("proseStrong", platform).fontWeight, "600");
    assert.equal(typographyRole("largeTitle", platform).fontWeight, "600");
  }
  assert.equal(typographyRegistry.tracking.normal, 0);
  assert.equal(nativeMonoFontFamily("ios"), "Menlo");
  assert.equal(nativeMonoFontFamily("android"), "monospace");
  assert.equal(nativeMonoFontFamily("unknown"), "monospace");
  const app = read("../apps/workbench-web/src/styles/app.scss");
  for (const selector of ['.opencraft-composer-mode', '.opencraft-composer-mode__model-label', '.opencraft-composer-mode__effort-label']) {
    const block = app.slice(app.indexOf(`\n${selector} {`)).split('\n}')[0];
    assert.match(block, /typography\.role\(control-compact, secondary\)/u, selector);
  }
  const ssh = read("../apps/workbench-web/src/styles/ssh-connections.scss");
  assert.match(ssh, /p, summary \{ @include typography\.role\(metadata, secondary\)/u);
  assert.doesNotMatch(ssh, /role\(control-small/u);
});

test("Agent instructions progressively route UI and font work without expanding root context", () => {
  const agents = read("../AGENTS.md");
  assert.match(agents, /design\/ui\/README\.md/u);
  const index = read("../design/ui/README.md");
  assert.match(index, /typography\.md/u);
  assert.match(index, /SVG/u);
  const topic = read("../design/ui/typography.md");
  assert.match(topic, /fbf85a839f/u);
  assert.match(topic, /1440a028b6/u);
  const pkg = JSON.parse(read("../package.json"));
  assert.match(pkg.scripts['check:boundaries'], /check:typography/u);
  assert.match(pkg.scripts['check:typography'], /check-ui-typography/u);
  assert.match(pkg.scripts.gate, /test:typography/u);
});
