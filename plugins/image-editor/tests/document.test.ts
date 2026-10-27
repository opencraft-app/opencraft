import assert from "node:assert/strict";
import test from "node:test";
import { commitEdit, emptyHistory, paintEdit, selectionRect, stepHistory, type ImageEdit } from "../src/document";

test("each gesture or transform is one undo step; a branch retires redo without changing older history", () => {
  const pen: ImageEdit = { type: "pen", points: [{ x: 20, y: 10 }, { x: 30, y: 15 }], width: 4, color: "red" };
  const drawn = commitEdit(emptyHistory, pen), rotated = commitEdit(drawn, { type: "rotate" });
  const undone = stepHistory(rotated, -1);
  assert.equal(undone.cursor, 1); assert.equal(stepHistory(undone, 1).cursor, 2);
  const branch = commitEdit(undone, { type: "text", point: { x: 8, y: 9 }, text: "hello", size: 20, color: "white" });
  assert.equal(branch.edits.length, 2); assert.equal(branch.edits[1]?.type, "text");
  assert.equal(stepHistory(branch, 1).cursor, 2); assert.equal(rotated.edits[1]?.type, "rotate");
  assert.equal(stepHistory(emptyHistory, -1).cursor, 0);
});

test("crop works for any drag direction and stays expressed in image pixels", () => {
  assert.deepEqual(selectionRect({ x: 800, y: 600 }, { x: 200, y: 100 }), { x: 200, y: 100, width: 600, height: 500 });
});

test("multiline annotations retain native input typography in document coordinates", () => {
  const painted: unknown[] = [];
  const ctx = { font: "", strokeText() {}, fillText(text: string, x: number, y: number) { painted.push({ text, x, y, font: this.font }); } };
  const target = { getContext: () => ctx } as unknown as HTMLCanvasElement;
  paintEdit(target, { type: "text", point: { x: 100, y: 100 }, size: 20, color: "red", text: "First\nSecond",
    format: { family: '"Example Font", sans-serif', weight: "400", leading: 1.5 } });
  assert.deepEqual(painted, [
    { text: "First", x: 100, y: 85, font: '400 20px "Example Font", sans-serif' },
    { text: "Second", x: 100, y: 115, font: '400 20px "Example Font", sans-serif' },
  ]);
});
