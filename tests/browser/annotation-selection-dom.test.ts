import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

// Real layout/caret/frame APIs; serialized factories are exercised as in frame-agent injection.
test("Annotation V2 DOM runtime: identity, frames/shadow, text, regions and owned preview", async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import { createAnnotationPicker } from './packages/browser-preview-bridge/src/annotation-picker';
    import { createAnnotationSelectionRuntime } from './packages/browser-preview-bridge/src/annotation-selection';
    import { createAnnotationOverlay } from './packages/browser-preview-bridge/src/annotation-overlay';
    globalThis.factorySources = [createAnnotationPicker.toString(), createAnnotationSelectionRuntime.toString(), createAnnotationOverlay.toString()];
  `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    minify: true,
  });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // tsx's test callback names are unrelated to the bundled injectable factories.
    await page.addInitScript("window.__name = value => value");
    await page.route("http://localhost/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<body></body>" }),
    );
    await page.goto("http://localhost/annotation-test");
    await page.setContent(`<style>body{margin:10px;font:20px monospace} p{margin:10px 0} iframe{display:block;width:350px;height:180px} #shadow{display:block}</style>
      <button id="simple">Hello</button><p id="text">你好 world 🌏<b> nested</b> end</p>
      <input id="password" type="password" value="secret"><textarea>private</textarea>
      <div id="shadow"></div><iframe id="outer"></iframe>`);
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(async () => {
      const sources = (globalThis as any).factorySources as string[];
      const makePicker = new Function(`return (${sources[0]})`)();
      const makeSelections = new Function(`return (${sources[1]})`)();
      const makeOverlay = new Function(`return (${sources[2]})`)();
      let granted = true,
        refs = 0;
      const picker = makePicker(window, (element: Element) => element.matches("input[type=password]"));
      const runtime = makeSelections(document, {
        picker,
        ref: () => `e${++refs}`,
        revision: () => 7,
        authorizePreview: () => granted,
      });
      const check = (condition: unknown, message: string) => {
        if (!condition) throw new Error(message);
      };
      check(
        sources.every((source) => !source.includes("__name")),
        "factories have no transpiler naming dependency",
      );
      const error = (fn: () => unknown, code: string) => {
        try {
          fn();
        } catch (e) {
          check((e as any).code === code, `Expected ${code}, got ${(e as any).code}: ${(e as Error).message}`);
          return;
        }
        throw new Error(`Expected ${code}`);
      };
      const point = (x: number, y: number) => ({ x, y, frameWidth: innerWidth, frameHeight: innerHeight });
      const center = (el: Element) => {
        const b = el.getBoundingClientRect();
        return point(b.x + b.width / 2, b.y + b.height / 2);
      };
      const simple = document.querySelector("#simple") as HTMLElement;
      simple.setAttribute("data-oc-annotation-name", "Primary action");
      simple.setAttribute("data-oc-annotation-metadata", '{"component":"CheckoutAction","variant":"primary"}');
      const pick = picker.pick({ point: center(simple) }, { revision: 7, ref: () => "real-ref" });
      check(
        pick.anchor.elementName === "Primary action" && pick.anchor.elementMetadata.component === "CheckoutAction",
        "passive semantic metadata",
      );
      simple.setAttribute("data-oc-annotation-metadata", '{"__proto__":"bad"}');
      check(
        !picker.pick({ point: center(simple) }, { revision: 7, ref: () => "" }).anchor.elementMetadata,
        "reject pollution metadata",
      );
      check(pick.anchor.ref === "real-ref", "real main-document ref");
      check(picker.resolve(pick.anchor) === simple, "identity resolve");
      error(() => picker.resolve({ ...pick.anchor, documentGeneration: "forged" }), "STALE_ELEMENT_REFERENCE");
      check(runtime.readStyles(pick.anchor)["font-size"], "allowlisted style read");
      check(!("position" in runtime.readStyles(pick.anchor)), "nonallowlisted style absent");
      const region = runtime.pickRegion({ start: point(170, 140), end: point(20, 20) });
      check(
        region.anchor.kind === "region" &&
          region.anchor.rect.width === 150 &&
          !region.anchor.ref &&
          !region.anchor.selector,
        "region independent of hit element",
      );
      error(() => runtime.pickRegion({ start: point(0, 0), end: point(0, 0) }), "INVALID_ARGUMENT");
      const textEl = document.querySelector("#text")!;
      const first = textEl.firstChild!,
        last = textEl.lastChild!;
      const at = (node: Node, offset: number) => {
        const r = document.createRange();
        r.setStart(node, offset);
        r.collapse(true);
        const b = r.getBoundingClientRect();
        return point(b.x + 0.1, b.y + b.height / 2);
      };
      const selected = runtime.pickText({ start: at(first, 0), end: at(last, last.textContent!.length) });
      check(selected.anchor.selectedText === textEl.textContent, "exact Unicode nested text");
      check(
        selected.anchor.textLocator.endOffset === last.textContent!.length && selected.anchor.kind === "text",
        "text locator",
      );
      const reversed = runtime.pickText({ start: at(last, last.textContent!.length), end: at(first, 0) });
      check(reversed.anchor.selectedText === selected.anchor.selectedText, "reverse range");
      error(
        () =>
          runtime.pickText({
            start: center(document.querySelector("#password")!),
            end: center(document.querySelector("#password")!),
          }),
        "POLICY_BLOCKED",
      );
      error(
        () => runtime.preview({ changes: [{ anchor: selected.anchor, text: "unsafe overwrite" }] }),
        "INVALID_ARGUMENT",
      );
      const shadow = document.querySelector("#shadow")!.attachShadow({ mode: "open" });
      shadow.innerHTML = '<button id="inside">Shadow button</button>';
      const shadowPick = picker.pick(
        { point: center(shadow.querySelector("button")!) },
        { revision: 7, ref: () => "wrong" },
      );
      check(
        shadowPick.anchor.selector.includes(" >>> ") &&
          shadowPick.anchor.ref === "" &&
          picker.resolve(shadowPick.anchor) === shadow.querySelector("button"),
        "shadow identity and evidence only ref",
      );
      const shadowText = shadow.querySelector("button")!.firstChild!;
      check(
        runtime.pickText({ start: at(shadowText, 0), end: at(shadowText, shadowText.textContent!.length) }).anchor
          .selectedText === "Shadow button",
        "open shadow text caret",
      );
      const outer = document.querySelector("#outer") as HTMLIFrameElement;
      outer.contentDocument!.body.innerHTML = '<iframe id="inner" style="width:250px;height:100px"></iframe>';
      const inner = outer.contentDocument!.querySelector("iframe")!;
      inner.contentDocument!.body.innerHTML = '<button id="nested">Nested</button>';
      const nested = inner.contentDocument!.querySelector("button")!;
      const a = outer.getBoundingClientRect(),
        b = inner.getBoundingClientRect(),
        c = nested.getBoundingClientRect();
      const nestedPoint = point(
        a.x + outer.clientLeft + b.x + inner.clientLeft + c.x + 10,
        a.y + outer.clientTop + b.y + inner.clientTop + c.y + 10,
      );
      const nestedPick = picker.pick({ point: nestedPoint }, { revision: 7, ref: () => "wrong" });
      check(
        nestedPick.anchor.frame === "child" && nestedPick.anchor.framePath.length === 2 && nestedPick.anchor.ref === "",
        "nested frame path",
      );
      check(picker.resolve(nestedPick.anchor) === nested, "nested identity");
      error(() => runtime.pickText({ start: at(first, 0), end: nestedPoint }), "UNSUPPORTED_FRAME");
      const attach = Element.prototype.attachShadow;
      let overlayRoot: ShadowRoot | undefined;
      Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        if (this.id === "opencraft-annotation-host") overlayRoot = root;
        return root;
      };
      const overlay = makeOverlay(window);
      overlay.bind(nestedPick.anchor.bindingKey, picker.resolve(nestedPick.anchor));
      overlay.draw([{ ...nestedPick.anchor.rect, targetKey: nestedPick.anchor.bindingKey, label: "1A" }]);
      Element.prototype.attachShadow = attach;
      const marker = overlayRoot!.querySelector(".box") as HTMLElement;
      check(
        Math.abs(parseFloat(marker.style.left) - nestedPick.anchor.rect.x) < 1 &&
          Math.abs(parseFloat(marker.style.top) - nestedPick.anchor.rect.y) < 1,
        "nested overlay projects into root viewport",
      );
      overlay.bindGeneration("snapshot-current", document);
      overlay.draw([{ ...region.anchor.rect, documentGeneration: "snapshot-current" }]);
      check((overlayRoot!.querySelector(".box") as HTMLElement).style.display !== "none", "registered snapshot shown");
      overlay.draw([{ ...region.anchor.rect, documentGeneration: "unknown-old-page" }]);
      check(
        (overlayRoot!.querySelector(".box") as HTMLElement).style.display === "none",
        "replayed snapshot not adopted",
      );
      overlay.dispose();
      outer.style.transform = "scale(0.9)";
      error(() => picker.resolve(nestedPick.anchor), "UNSUPPORTED_FRAME");
      outer.style.transform = "";
      inner.contentDocument!.open();
      inner.contentDocument!.write("<button>New document same URL</button>");
      inner.contentDocument!.close();
      error(() => picker.resolve(nestedPick.anchor), "STALE_ELEMENT_REFERENCE");
      runtime.preview({
        changes: [
          { anchor: pick.anchor, property: "color", value: "rgb(255, 0, 0)" },
          { anchor: pick.anchor, text: "Preview" },
        ],
      });
      check(
        simple.textContent === "Preview" && getComputedStyle(simple).color === "rgb(255, 0, 0)",
        "preview is visible",
      );
      runtime.preview({ changes: [], original: true });
      check(simple.textContent === "Hello" && getComputedStyle(simple).color !== "rgb(255, 0, 0)", "original view");
      runtime.preview({ changes: [{ anchor: pick.anchor, text: "Preview" }] });
      simple.firstChild!.textContent = "Site update";
      error(() => runtime.preview({ changes: [] }), "PREVIEW_CONFLICT");
      check(simple.textContent === "Site update", "never overwrite intervening page text");
      const fresh = picker.pick({ point: center(simple) }, { revision: 7, ref: () => "real-ref" });
      runtime.preview({ changes: [{ anchor: fresh.anchor, text: "Again" }] });
      granted = false;
      error(() => runtime.preview({ changes: [] }), "POLICY_BLOCKED");
      check(simple.textContent === "Site update", "revocation restores owned text");
      granted = true;
      runtime.preview({ changes: [{ anchor: fresh.anchor, property: "color", value: "rgb(255, 0, 0)" }] });
      simple.style.color = "blue";
      error(() => runtime.preview({ changes: [] }), "PREVIEW_CONFLICT");
      check(
        simple.style.color === "blue" && getComputedStyle(simple).color === "rgb(0, 0, 255)",
        "inline page write survives preview conflict",
      );
      const readonly = makeSelections(document, { picker });
      error(() => readonly.preview({ changes: [] }), "POLICY_BLOCKED");
      const long = document.createElement("p");
      long.style.cssText =
        "position:fixed;left:400px;top:360px;width:350px;font:1px/2px monospace;overflow-wrap:anywhere";
      long.textContent = "a".repeat(2100);
      document.body.append(long);
      error(
        () => runtime.pickText({ start: at(long.firstChild!, 0), end: at(long.firstChild!, 2100) }),
        "INVALID_ARGUMENT",
      );
      long.remove();
      const restricted = document.createElement("iframe");
      restricted.sandbox.add("allow-scripts");
      restricted.style.cssText = "position:fixed;left:500px;top:0;width:200px;height:100px";
      restricted.srcdoc = "<button>Restricted</button>";
      await new Promise<void>((resolve) => {
        restricted.onload = () => resolve();
        document.body.append(restricted);
      });
      error(() => picker.pick({ point: point(530, 30) }, { revision: 7, ref: () => "" }), "UNSUPPORTED_FRAME");
      restricted.remove();
      const oldGeneration = fresh.anchor.documentGeneration;
      simple.replaceWith(simple.cloneNode(true));
      error(() => picker.resolve(fresh.anchor), "STALE_ELEMENT_REFERENCE");
      runtime.dispose();
      readonly.dispose();
      check(
        ![...document.querySelectorAll("*")].some((el) =>
          [...el.attributes].some((attr) => attr.name.startsWith("data-oc-preview-")),
        ),
        "cleanup owns all temporary attributes",
      );
      document.open();
      document.write("<body>Replaced</body>");
      document.close();
      error(() => picker.pick({ point: point(10, 10) }, { revision: 7, ref: () => "" }), "STALE_ELEMENT_REFERENCE");
      picker.dispose();
      return { oldGeneration, checks: 25 };
    });
    assert.equal(result.checks, 25);
    assert.ok(result.oldGeneration);
  } finally {
    await browser.close();
  }
});

test("PreviewBridge V2 methods execute against the cooperating document", async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import { PreviewBridgeAdapter, installPreviewBridgeRuntime } from './packages/browser-preview-bridge/src/index';
    globalThis.bridgeTesting = { PreviewBridgeAdapter, installPreviewBridgeRuntime };
  `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    minify: true,
  });
  const source = bundle.outputFiles[0]!.text;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript("window.__name = value => value");
    await page.route("http://localhost/**", (route) =>
      route.fulfill({ contentType: "text/html", body: '<iframe style="width:500px;height:300px"></iframe>' }),
    );
    await page.goto("http://localhost/bridge-test");
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(async (source) => {
      const frame = document.querySelector("iframe")!.contentWindow! as any;
      frame.document.body.innerHTML = '<button id="target">Bridge text</button>';
      frame.eval(source);
      const stop = frame.bridgeTesting.installPreviewBridgeRuntime({
        window: frame,
        parentOrigin: location.origin,
        authorizeAnnotationPreview: () => true,
      });
      const adapter = new (globalThis as any).bridgeTesting.PreviewBridgeAdapter({
        hostWindow: window,
        frameWindow: frame,
        targetOrigin: location.origin,
        previewId: "v2",
        generation: 2,
      });
      try {
        const element = frame.document.querySelector("button");
        const r = element.getBoundingClientRect();
        const point = (x: number, y: number) => ({
          x,
          y,
          frameWidth: frame.innerWidth,
          frameHeight: frame.innerHeight,
        });
        const pick = await adapter.annotatePick({ point: point(r.x + 5, r.y + 5) });
        const styles = await adapter.annotateStyles(pick.anchor);
        const region = await adapter.annotateRegion({ start: point(1, 1), end: point(100, 50) });
        const textNode = element.firstChild;
        const range = frame.document.createRange();
        range.selectNodeContents(textNode);
        const textRect = range.getBoundingClientRect();
        const text = await adapter.annotateText({
          start: point(textRect.x + 0.1, textRect.y + textRect.height / 2),
          end: point(textRect.right - 0.1, textRect.y + textRect.height / 2),
        });
        await adapter.annotatePreview({ changes: [{ anchor: pick.anchor, text: "Preview via RPC" }] });
        const previewed = element.textContent;
        await adapter.annotateClearPreview();
        return {
          ref: pick.anchor.ref,
          styles,
          region: region.anchor.kind,
          text: text.anchor.selectedText,
          previewed,
          restored: element.textContent,
        };
      } finally {
        adapter.dispose();
        stop();
      }
    }, source);
    assert.match(result.ref, /^e\d+$/);
    assert.ok(result.styles["font-size"]);
    assert.equal(result.region, "region");
    assert.equal(result.text, "Bridge text");
    assert.equal(result.previewed, "Preview via RPC");
    assert.equal(result.restored, "Bridge text");
  } finally {
    await browser.close();
  }
});
