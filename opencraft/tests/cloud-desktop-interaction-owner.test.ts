import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindDesktopInteractionOwner } from "../plugins/cloud-desktop/src/interaction-owner";

test("unknown mobile focusout is not an outside interaction; keyboard handoff retains scope", async () => {
  const dom = new JSDOM('<section><canvas tabindex="0"></canvas><button>Keyboard</button><textarea></textarea></section><button id="outside">Chat</button>');
  const document = dom.window.document, owner = document.querySelector("section")!;
  let leaves = 0;
  const dispose = bindDesktopInteractionOwner(owner, () => leaves++);
  const canvas = owner.querySelector("canvas")!, keyboard = owner.querySelector("button")!, input = owner.querySelector("textarea")!;
  canvas.focus(); canvas.blur(); await Promise.resolve();
  assert.equal(leaves, 0, "null target/body is missing focus information, not cancellation");
  keyboard.focus(); input.focus(); canvas.focus(); await Promise.resolve();
  assert.equal(leaves, 0, "toolbar/editable/media share one interaction scope");
  document.body.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(leaves, 1, "outside blank space retires control even without a focusable target");
  document.getElementById("outside")!.focus();
  assert.ok(leaves > 1, "known outside focus retires control");
  const before = leaves; dom.window.dispatchEvent(new dom.window.Event("blur"));
  assert.equal(leaves, before + 1, "window loss is independently authoritative");
  canvas.focus(); canvas.blur(); dispose(); await Promise.resolve();
  const after = leaves; dom.window.dispatchEvent(new dom.window.Event("blur"));
  assert.equal(leaves, after, "disposed scope cannot run delayed reconciliation or listeners");
  dom.window.close();
});
