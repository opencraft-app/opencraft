import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { WebConversationViewportOwner } from "@opencraft/timeline-host-web";
import { observeBorderBoxHeight } from "../../packages/timeline-host-web/src/measurement";

function observerFixture(t: { after: (cleanup: () => void) => void }) {
  const original = globalThis.ResizeObserver;
  const observed = new Set<Element>();
  let callback: ResizeObserverCallback;
  let constructions = 0;
  globalThis.ResizeObserver = class {
    constructor(value: ResizeObserverCallback) { callback = value; constructions++; }
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  } as typeof ResizeObserver;
  t.after(() => { globalThis.ResizeObserver = original; });
  return { observed, constructions: () => constructions,
    emit: (...values: [Element, number][]) => callback!(values.map(([target, height]) => ({
      target, borderBoxSize: [{ blockSize: height }],
    })) as unknown as ResizeObserverEntry[], {} as ResizeObserver),
  };
}

test("composer occlusion excludes floating file summaries, includes visible attached paint and ignores empty rails", t => {
  const f = observerFixture(t), dom = new JSDOM(`<div id="scroll"></div><div id="footer">
    <div id="floating">Files changed</div>
    <div id="rail" data-composer-occlusion-surface="attached-rail"></div>
    <div id="editor" data-composer-occlusion-surface="editor"></div>
  </div>`);
  const node = (id: string) => dom.window.document.getElementById(id)!;
  const scroll = node("scroll"), footer = node("footer"), rail = node("rail"), editor = node("editor");
  Object.defineProperties(scroll, { clientHeight: { value: 900 }, clientWidth: { value: 800 }, offsetWidth: { value: 832 }, clientLeft: { value: 16 } });
  let footerHeight = 180, railTop = 0, railHeight = 0, editorVisible = true;
  const rect = (top: number, height: number, width = 800) => ({ top, bottom: top + height, height, width }) as DOMRect;
  scroll.getBoundingClientRect = () => rect(0, 900);
  editor.style.borderBottomLeftRadius = "16px";
  editor.style.borderBottomRightRadius = "16px";
  footer.getBoundingClientRect = () => rect(900 - footerHeight, footerHeight);
  rail.getBoundingClientRect = () => rect(railTop, railHeight, railHeight ? 800 : 0);
  editor.getBoundingClientRect = () => editorVisible ? rect(720, 164) : rect(0, 0, 0);
  const owner = new WebConversationViewportOwner(0);
  owner.scrollElementRef.current = scroll as HTMLDivElement;
  owner.setFooterResizeViewportPreserveDisabled(true);
  t.after(() => { owner.dispose(); dom.window.close(); });
  owner.attachFooterElement(footer);
  const occlusion = () => Number.parseFloat(scroll.style.getPropertyValue("--thread-composer-occlusion-height"));
  assert.equal(occlusion(), 180);
  const bottomInset = () => Number.parseFloat(scroll.style.getPropertyValue("--thread-reading-bottom-inset"));
  assert.equal(bottomInset(), 32, "16px dock gap plus the actual 16px lower arc");
  assert.equal(scroll.style.getPropertyValue("--thread-reading-clip-left"), "16px");
  assert.equal(scroll.style.getPropertyValue("--thread-reading-clip-right"), "16px", "both native gutter strips stay outside the content clip");
  assert.equal(f.constructions(), 1, "reuse a single footer observer");
  assert.deepEqual(f.observed, new Set([footer, rail, editor]));
  footerHeight += 36; f.emit([footer, footerHeight]);
  assert.equal(occlusion(), 180, "floating content adds reservation, not a white band");
  assert.equal(owner.getFooterHeight(), 216);
  assert.equal(bottomInset(), 32, "floating files do not move the bottom reading cutoff");
  // The total footer can stay unchanged while its painted child moves. A
  // child receipt invalidates only occlusion, not the footer reservation.
  railTop = 684; railHeight = 52; f.emit([rail, railHeight]);
  assert.equal(occlusion(), 216);
  assert.equal(owner.getFooterHeight(), 216, "child height must never replace footer height");
  assert.equal(bottomInset(), 32, "an attached queue also leaves the bottom cutoff stable");
  editor.style.borderBottomLeftRadius = "28px";
  editor.style.borderBottomRightRadius = "28px";
  f.emit([editor, 164]);
  assert.equal(bottomInset(), 44, "density uses actual editor radius without changing footer height");
  scroll.dataset.retainedPreviewScale = "0.5";
  scroll.getBoundingClientRect = () => rect(0, 450);
  editor.getBoundingClientRect = () => rect(360, 82);
  f.emit([editor, 164]);
  assert.equal(bottomInset(), 44, "retained preview transforms do not scale the CSS cutoff twice");
  delete scroll.dataset.retainedPreviewScale;
  scroll.getBoundingClientRect = () => rect(0, 900);
  editor.getBoundingClientRect = () => editorVisible ? rect(720, 164) : rect(0, 0, 0);
  railHeight = 0; f.emit([rail, 0]);
  assert.equal(occlusion(), 180, "an empty rail's zero rect is not a viewport-wide mask");
  editorVisible = false; f.emit([editor, 0]);
  assert.equal(occlusion(), 0, "floating-only content has no editing occlusion");
  assert.equal(bottomInset(), 0, "no invisible editor may clip a reading-only view");
  rail.removeAttribute("data-composer-occlusion-surface"); editor.removeAttribute("data-composer-occlusion-surface");
  f.emit([footer, footerHeight]);
  assert.equal(occlusion(), footerHeight, "legacy footers retain their full reservation fallback");
  assert.deepEqual(f.observed, new Set([footer]));
  owner.attachFooterElement(null);
  assert.equal(f.observed.size, 0);
  assert.equal(scroll.style.getPropertyValue("--thread-composer-occlusion-height"), "");
  for(const name of ["--thread-reading-bottom-inset","--thread-reading-clip-left","--thread-reading-clip-right"])assert.equal(scroll.style.getPropertyValue(name), "");
});

test("height observation retains the root measurement, refreshes painted dependencies and fences disposal", t => {
  const f = observerFixture(t), dom = new JSDOM(`<div id="root"></div><div id="first"></div><div id="second"></div>`);
  const root = dom.window.document.getElementById("root")!, first = dom.window.document.getElementById("first")!, second = dom.window.document.getElementById("second")!;
  root.getBoundingClientRect = () => ({ height: 200 }) as DOMRect;
  let dependencies = [first], targetReads = 0;
  const heights: number[] = [];
  const stop = observeBorderBoxHeight(root, value => heights.push(value), () => { targetReads++; return dependencies; });
  t.after(() => { stop(); dom.window.close(); });
  assert.deepEqual(heights, [200]);
  f.emit([first, 40]); assert.deepEqual(heights, [200, 200]);
  f.emit([root, 260], [first, 60]); assert.equal(heights.at(-1), 260);
  dependencies = [second]; f.emit([root, 260]);
  assert.deepEqual(f.observed, new Set([root, second]));
  f.emit([second, 70]); assert.equal(heights.at(-1), 260);
  const count = heights.length, reads = targetReads;
  f.emit([first, 40]); assert.equal(heights.length, count, "retired surfaces cannot invalidate layout");
  stop(); f.emit([root, 400], [second, 120]);
  assert.equal(heights.length, count); assert.equal(targetReads, reads); assert.equal(f.observed.size, 0);
});
