import assert from "node:assert/strict";
import test from "node:test";

import { nativeTableColumnWidth } from "../packages/chat-render-native/src/renderers/table-layout";

test("native table column widths fill the viewport until local horizontal overflow is needed", () => {
  assert.equal(nativeTableColumnWidth(375, 2), 187.5);
  assert.equal(nativeTableColumnWidth(375, 4), 132);
  assert.equal(nativeTableColumnWidth(800, 4), 200);
  assert.equal(nativeTableColumnWidth(0, 3), 160);
});
