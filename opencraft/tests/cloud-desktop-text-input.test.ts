import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createDesktopTextInput } from "../plugins/cloud-desktop/src/text-input";

function fixture() {
  const dom = new JSDOM('<div id="surface"></div>');
  const element = dom.window.document.getElementById("surface")!;
  const sent: number[] = []; let allowed = false;
  const keyboard = createDesktopTextInput(element, () => allowed, key => sent.push(key));
  const input = () => element.querySelector("textarea")!;
  return { dom, element, sent, keyboard, input, allow(value: boolean) { allowed = value; },
    changed(text: string, type = "insertText", composing = false, target = input()) {
      target.value = text;
      target.dispatchEvent(new dom.window.InputEvent("input", { inputType: type, data: text, isComposing: composing }));
    },
    composition(type: string, text = "", target = input()) { target.dispatchEvent(new dom.window.CompositionEvent(type, { data: text })); },
    close() { keyboard.reset(); dom.window.close(); } };
}

test("keyboard requires an explicit confirmed grant and focuses a real editable element", () => {
  const f = fixture();
  f.keyboard.focus("Desktop typing"); assert.equal(f.element.children.length, 0);
  f.allow(true); f.keyboard.focus("Desktop typing");
  assert.equal(f.dom.window.document.activeElement, f.input());
  assert.equal(f.input().getAttribute("aria-label"), "Desktop typing");
  f.changed("a中😀"); assert.deepEqual(f.sent, [97, 0x01004e2d, 0x0101f600]);
  assert.equal(f.input().value, ""); f.close();
});

test("composition candidates remain local; final Unicode commits once, no duplicate trailing composition input", () => {
  const f = fixture(); f.allow(true); f.keyboard.focus("Typing");
  f.composition("compositionstart");
  f.changed("zhong", "insertCompositionText", true); f.changed("中", "insertCompositionText", true);
  assert.deepEqual(f.sent, []);
  f.composition("compositionend", "中"); f.changed("中", "insertFromComposition");
  f.composition("compositionend", "中");
  assert.deepEqual(f.sent, [0x01004e2d]);
  f.changed("中"); assert.deepEqual(f.sent, [0x01004e2d, 0x01004e2d], "a new real insertion is not deduped by text"); f.close();
});

test("retirement removes text and the DOM; late IME/input cannot type into a successor grant", () => {
  const f = fixture(); f.allow(true); f.keyboard.focus("Typing"); const old = f.input();
  f.composition("compositionstart"); f.changed("旧", "insertCompositionText", true);
  f.allow(false); f.keyboard.reset(); assert.equal(f.element.children.length, 0); assert.equal(old.value, "");
  f.allow(true); f.keyboard.focus("Typing"); assert.notEqual(old, f.input());
  f.composition("compositionend", "旧", old); f.changed("旧", "insertText", false, old);
  assert.deepEqual(f.sent, []); f.changed("新"); assert.deepEqual(f.sent, [0x010065b0]); f.close();
});

test("mobile deletion and Enter produce key strokes, not textarea mutations; paste/drop stay in clipboard boundary", () => {
  const f = fixture(); f.allow(true); f.keyboard.focus("Typing");
  for (const type of ["deleteContentBackward", "insertLineBreak", "insertFromPaste", "insertFromDrop"]) {
    const event = new f.dom.window.InputEvent("beforeinput", { inputType: type, cancelable: true });
    f.input().dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  }
  assert.deepEqual(f.sent, [0xff08, 0xff0d]);
  f.changed("not pasted", "insertFromPaste"); assert.deepEqual(f.sent, [0xff08, 0xff0d]); f.close();
});

test("hardware printable keys are not duplicated and revoked text never sends", () => {
  const f = fixture(); f.allow(true); f.keyboard.focus("Typing");
  for (const key of ["a", "Enter"]) f.input().dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key, cancelable: true }));
  f.changed("a"); assert.deepEqual(f.sent, [0xff0d, 97]);
  f.allow(false); f.changed("b"); f.composition("compositionstart"); f.composition("compositionend", "错");
  assert.deepEqual(f.sent, [0xff0d, 97]); f.close();
});

test("focus handoff commits the platform-confirmed candidate before changing the remote target", () => {
  const f = fixture(); f.allow(true); f.keyboard.focus("Typing"); const old = f.input();
  f.composition("compositionstart"); f.changed("中", "insertCompositionText", true);
  let target = "A"; const operations: string[] = [];
  old.addEventListener("compositionend", () => operations.push(`commit:${target}:${f.sent.length}`));
  f.keyboard.finish(() => {
    f.composition("compositionend", "中");
    const canvas = f.dom.window.document.createElement("canvas"); canvas.tabIndex = 0;
    f.element.append(canvas); canvas.focus();
  });
  target = "B"; operations.push(`click:${target}`);
  assert.deepEqual(operations, ["commit:A:1", "click:B"]);
  assert.equal(old.isConnected, false);
  f.composition("compositionend", "旧", old); f.changed("旧", "insertText", false, old);
  f.keyboard.focus("Typing"); f.changed("新");
  assert.deepEqual(f.sent, [0x01004e2d, 0x010065b0]); f.close();
});

test("unconfirmed delayed composition and failed focus handoff cannot outlive the text transaction", () => {
  for (const failed of [false, true]) {
    const f = fixture(); f.allow(true); f.keyboard.focus("Typing"); const old = f.input();
    f.composition("compositionstart"); f.changed("候选", "insertCompositionText", true);
    const handoff = () => f.keyboard.finish(() => { if (failed) throw new Error("focus failed"); });
    if (failed) assert.throws(handoff); else handoff();
    f.composition("compositionend", "候选", old); f.changed("候选", "insertText", false, old);
    assert.deepEqual(f.sent, []); assert.equal(old.isConnected, false); f.close();
  }
});
