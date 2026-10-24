import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { transform } from "esbuild";
import * as artwork from "@opencraft/design-system/action-artwork";
import * as sidebar from "@opencraft/design-system/sidebar-toggle-glyphs";
import * as web from "@opencraft/design-system-web/action-icons";

// Execute the production Native adapter, replacing only the platform SVG
// elements. Browser smoke uses react-native-web and the actual SVG web adapter.
const require = createRequire(import.meta.url);
let canvasProps: any;
function Svg({ children, ...props }: any) {
  canvasProps = props;
  return <svg width={props.width} height={props.height} viewBox={props.viewBox}
    fill={props.fill} stroke={props.stroke} color={props.color} strokeWidth={props.strokeWidth}>{children}</svg>;
}
const primitives = Object.fromEntries(["Path", "Rect", "Circle", "Ellipse", "Line", "Polyline", "Polygon"].map(name =>
  [name, (props: any) => React.createElement(name.toLowerCase(), props)]));
const seams: Record<string, unknown> = {
  "react": React, "react/jsx-runtime": require("react/jsx-runtime"),
  "react-native-svg": { __esModule: true, default: Svg, ...primitives },
  "@opencraft/design-system/action-artwork": artwork,
  "@opencraft/design-system/sidebar-toggle-glyphs": sidebar,
};
const { code } = await transform(readFileSync(new URL("../../packages/design-system-native/src/action-icons.tsx", import.meta.url), "utf8"), {
  loader: "tsx", jsx: "automatic", format: "cjs", target: "es2022",
});
const module = { exports: {} as Record<string, React.ComponentType<any>> };
new Function("require", "module", "exports", code)((name: string) => {
  assert.ok(Object.hasOwn(seams, name), `Unexpected platform seam ${name}`); return seams[name];
}, module, module.exports);
const native = module.exports;
function paint(markup: string) {
  const dom = new JSDOM(markup); const svg = dom.window.document.querySelector("svg")!;
  const shapes = [...svg.children].map(node => [node.tagName, [...node.attributes].map(a => [a.name, a.value]).sort()]);
  dom.window.close(); return shapes;
}
for (const name of Object.keys(artwork.actionArtwork)) test(`${name} paints the same shared contours on both platforms`, () => {
  const Icon = native[name], WebIcon = (web as any)[name]; assert.ok(Icon && WebIcon);
  for (const size of [14, 16, 20, 24]) {
    const markup = renderToStaticMarkup(<Icon size={size} color="#326abc" strokeWidth={1.9} />);
    assert.deepEqual(paint(markup), paint(renderToStaticMarkup(<WebIcon size={size} strokeWidth={1.9} />)));
    assert.equal(canvasProps.width, size); assert.equal(canvasProps.height, size);
    assert.equal(canvasProps.stroke, "#326abc"); assert.equal(canvasProps.strokeWidth, 1.9);
    assert.equal(canvasProps.accessible, false); assert.equal(canvasProps.accessibilityElementsHidden, true);
  }
});
test("standalone labels and explicit accessibility/paint overrides reach native SVG", () => {
  const Icon = native.SquareIcon;
  renderToStaticMarkup(<Icon accessibilityLabel="Status" fill="#333" stroke="#123" testID="status" />);
  assert.equal(canvasProps.accessible, true); assert.equal(canvasProps.accessibilityElementsHidden, false);
  assert.equal(canvasProps.importantForAccessibility, "yes"); assert.equal(canvasProps.accessibilityLabel, "Status");
  assert.equal(canvasProps.fill, "#333"); assert.equal(canvasProps.stroke, "#123"); assert.equal(canvasProps.testID, "status");
  renderToStaticMarkup(<Icon accessibilityLabel="Status" accessible={false} accessibilityElementsHidden={false} importantForAccessibility="no-hide-descendants" />);
  assert.equal(canvasProps.accessible, false); assert.equal(canvasProps.accessibilityElementsHidden, false);
  assert.equal(canvasProps.importantForAccessibility, "no-hide-descendants");
});
test("native sidebar states use existing desktop contours and their 20-unit canvas", () => {
  for (const [name, state] of [["SidebarHiddenIcon", "hidden"], ["SidebarVisibleIcon", "visible"]] as const) {
    const Icon = native[name]; const markup = renderToStaticMarkup(<Icon size={16} color="#326abc" />);
    assert.equal(canvasProps.viewBox, sidebar.sidebarToggleGlyphs.viewBox);
    assert.deepEqual(paint(markup), [["path", [["d", sidebar.sidebarToggleGlyphs[state]], ["fill", "#326abc"], ["stroke", "none"]]]]);
  }
});
test("both native consumers resolve only the shared icon owner after a clean install", () => {
  for (const workspace of ["apps/workbench-expo", "packages/chat-render-native"]) {
    const req = createRequire(new URL(`../../${workspace}/package.json`, import.meta.url));
    assert.ok(req.resolve("@opencraft/design-system-native/action-icons"));
    assert.throws(() => req.resolve("lucide-react-native"), /Cannot find module/);
  }
});
