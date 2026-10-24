import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindDesktopInteractionOwner, ownsDesktopFocus } from "../../plugins/cloud-desktop/src/interaction-owner";

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

test("a shadow-hosted panel (embedded workbench) keeps its own interaction scope and focus", async () => {
  const dom = new JSDOM("<div id='host'></div><button id='outside'>Chat</button>", { pretendToBeVisual: true });
  const document = dom.window.document;
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
  const shadow = document.getElementById("host")!.attachShadow({ mode: "open" });
  shadow.innerHTML = "<section><canvas tabindex='0'></canvas><button>Take</button></section><button id='sibling'>x</button>";
  const owner = shadow.querySelector("section")!;
  let leaves = 0;
  const dispose = bindDesktopInteractionOwner(owner, () => leaves++);
  const canvas = owner.querySelector("canvas")!, take = owner.querySelector("button")!;
  // Document listeners see the shadow host as target; that is not an outside interaction.
  take.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
  canvas.focus(); await Promise.resolve();
  assert.equal(leaves, 0, "inside pointerdown/focus across the shadow boundary must not retire control");
  assert.equal(ownsDesktopFocus(owner), true, "focus on the panel inside a shadow root grants interaction focus");
  (shadow.getElementById("sibling") as HTMLElement).focus(); await Promise.resolve();
  assert.equal(ownsDesktopFocus(owner), false, "a sibling in the same shadow root is outside the panel");
  assert.ok(leaves > 0, "known focus outside the panel retires control");
  const before = leaves;
  document.getElementById("outside")!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
  assert.equal(leaves, before + 1, "an outside page pointerdown still retires control");
  dispose();
  dom.window.close();
});
