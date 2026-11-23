import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT,
  inspectTouchPresentationSource,
  TOUCH_POINT_EXEMPTIONS,
} from "../../scripts/check/check-touch-presentation.mjs";

const inspect = (source, file = "apps/workbench-web/src/fixture.tsx") =>
  inspectTouchPresentationSource(source, file).issues;

test("rejects pointer and hover media queries outside the contract", () => {
  for (const source of [
    'window.matchMedia("(pointer: coarse)").matches',
    'view?.dom.ownerDocument.defaultView?.matchMedia("(pointer: coarse)").matches',
    'matchMedia("(any-pointer: coarse), (hover: none)")',
    'const query = "(hover: hover) and (pointer: fine)"; matchMedia(query)',
    "const media = (q) => view.matchMedia(q).matches; media(`(any-hover: none)`)",
    'window.matchMedia("screen and (pointer:coarse)")',
  ])
    assert.equal(inspect(source).length, 1, source);
});

test("allows unrelated media queries and CSS text", () => {
  for (const source of [
    'window.matchMedia("(prefers-reduced-motion: reduce)")',
    'const media = (q) => view.matchMedia(q).matches; media("(display-mode: standalone)")',
    'const css = "@media(pointer:coarse){.btn{min-height:44px}}"',
    "const css = `@media(hover:hover) and (pointer:fine){:root:not([data-touch-interaction]) a:hover{color:red}}`",
  ])
    assert.deepEqual(inspect(source), [], source);
});

test("rejects raw reads and writes of the document projection", () => {
  for (const source of [
    'document.documentElement.dataset.uiDensity === "touch"',
    "delete root.dataset.touchInteraction",
    'root.dataset["uiDensity"] = "touch"',
    'document.documentElement.hasAttribute("data-touch-interaction")',
    'observer.observe(root, { attributeFilter: ["data-ui-density"] })',
    'const frame = <div data-ui-density="touch" />',
  ])
    assert.equal(inspect(source).length, 1, source);
});

test("touch-point probes need a stated exemption", () => {
  assert.equal(inspect("navigator.maxTouchPoints > 0").length, 1);
  assert.equal(inspect('"ontouchstart" in window').length, 1);
  const [file] = TOUCH_POINT_EXEMPTIONS.keys();
  const result = inspectTouchPresentationSource("navigator.maxTouchPoints > 1", file);
  assert.deepEqual(result.issues, []);
  assert.equal(result.touchPoints, true);
});

test("host writers address the projection through contract keys", () => {
  assert.deepEqual(inspect('root.dataset[UI_DENSITY_KEY] = "touch"; delete root.dataset[TOUCH_INTERACTION_KEY]'), []);
});

test("the contract owns the capability query and projection", () => {
  const source = 'const q = "(any-pointer: coarse)"; root.dataset.uiDensity = "touch"; "data-ui-density"';
  assert.deepEqual(inspect(source, CONTRACT), []);
});
