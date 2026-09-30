import { afterEach, describe, expect, it } from "vitest";
import { shouldTypeToCompose } from "../../../../../opencraft/apps/workbench-web/src/type-to-compose";

// Exercise the window listener after native Shadow DOM event retargeting.
function dispatch(target: Element, init: KeyboardEventInit = {}) {
  let result: boolean | undefined;
  let observedTarget: EventTarget | null = null;
  const listener = (event: KeyboardEvent) => {
    observedTarget = event.target;
    result = shouldTypeToCompose(event);
  };
  window.addEventListener("keydown", listener);
  try {
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: "n", bubbles: true, composed: true, cancelable: true, ...init,
    }));
  } finally { window.removeEventListener("keydown", listener); }
  return { result, observedTarget };
}

afterEach(() => { document.body.replaceChildren(); });

describe("embedded type-to-compose input ownership", () => {
  it("does not insert the first Pinyin key from the shadow editor before isComposing becomes true", () => {
    const host = document.createElement("opencraft-embedded-workbench");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    editor.append(paragraph);
    shadow.append(editor);
    expect(dispatch(paragraph)).toEqual({ result: false, observedTarget: host });
    expect(dispatch(paragraph, { key: "s" }).result).toBe(false);
  });

  it("leaves shadow inputs, buttons, and menus in control of their keys", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    for (const tag of ["input", "textarea", "button"]) {
      const element = document.createElement(tag);
      shadow.append(element);
      expect(dispatch(element).result).toBe(false);
    }
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    shadow.append(menu);
    expect(dispatch(menu).result).toBe(false);
  });

  it("keeps plain page typing but ignores composition start, active composition, shortcuts and prevented keys", () => {
    expect(dispatch(document.body).result).toBe(true);
    expect(dispatch(document.body, { keyCode: 229 }).result).toBe(false);
    expect(dispatch(document.body, { isComposing: true }).result).toBe(false);
    expect(dispatch(document.body, { ctrlKey: true }).result).toBe(false);
    const input = document.createElement("input");
    document.body.append(input);
    expect(dispatch(input).result).toBe(false);
    input.addEventListener("keydown", (event) => event.preventDefault());
    expect(dispatch(input).result).toBe(false);
  });
});
