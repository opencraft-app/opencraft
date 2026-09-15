import assert from "node:assert/strict";
import test from "node:test";
import { computeDragResizeDimensions } from "../apps/workbench-web/src/browser/codex/viewport-resize.js";
import { computeBrowserViewportLayout } from "@opencraft/browser-core";
import { readFileSync } from "node:fs";

test("source viewport handles map pointer movement to actual dimensions at fit scale",()=>{
  const layout=computeBrowserViewportLayout({x:0,y:0,width:600,height:800},{type:"fit",width:1440,height:900});
  const result=computeDragResizeDimensions({drag:{edge:"bottom-right",startWidth:1440,startHeight:900,startPointerX:0,startPointerY:0},
    pointerX:-20,pointerY:-10,scale:layout.scale,fitWidth:560,fitHeight:780});
  assert.ok(result.width<1440);assert.ok(result.height<900);
  const left=computeDragResizeDimensions({drag:{edge:"left",startWidth:1440,startHeight:900,startPointerX:0,startPointerY:0},
    pointerX:20,pointerY:0,scale:layout.scale,fitWidth:560,fitHeight:780});
  assert.equal(left.width,result.width);assert.equal(left.height,900);
});
test("device UI uses the source compact row and edge handles, not the rejected form",()=>{
  const view=readFileSync(new URL("../apps/workbench-web/src/browser/browser-device-toolbar.tsx",import.meta.url),"utf8");
  const panel=readFileSync(new URL("../apps/workbench-web/src/browser/browser-panel-plugin.tsx",import.meta.url),"utf8");
  assert.ok(view.includes("×"));assert.ok(view.includes("Close device toolbar"));
  assert.ok(view.includes('"bottom-left","bottom-right"'));
  assert.doesNotMatch(panel,/拖动调整尺寸|browser-device-controls|宽 <input|高 <input/);
});
