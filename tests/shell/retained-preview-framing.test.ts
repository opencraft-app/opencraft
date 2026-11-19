import test from "node:test";
import assert from "node:assert/strict";
import {
  retainedPreviewFrame,
  setPreviewFlightClip,
  getPreviewFlightClip,
} from "../../apps/workbench-web/src/components/retained-preview-placement";

test("chat framing brings the content tail into a short card without resizing native layout", () => {
  const native = { width: 400, height: 800 },
    card = { width: 160, height: 200 };
  const frame = retainedPreviewFrame(native, card, "end", 700);
  assert.equal(frame.scale, 0.4);
  assert.equal(700 * frame.scale + frame.y, card.height);
  assert.deepEqual(native, { width: 400, height: 800 });
});
test("short conversations stay at the top instead of showing the empty viewport bottom", () => {
  assert.deepEqual(retainedPreviewFrame({ width: 400, height: 800 }, { width: 160, height: 200 }, "end", 100), {
    scale: 0.4,
    y: 0,
  });
});
test("offscreen overscan cannot pan beyond the actual viewport; tools keep start framing", () => {
  assert.equal(retainedPreviewFrame({ width: 400, height: 800 }, { width: 160, height: 200 }, "end", 2000).y, -120);
  assert.equal(retainedPreviewFrame({ width: 400, height: 800 }, { width: 160, height: 200 }, "start").y, 0);
});

// The native-view aperture stays tight; the outer material clips only at the
// scrollport, so its shadow never disappears until cleanup restores card paint.
test("decoration and native content share geometry without sharing their clipping edge", () => {
  const frame = { style: { clipPath: "" } } as HTMLElement;
  const box = { x: 20, y: 100, width: 160, height: 200 };
  const clip = { ...box, radius: 20 };
  setPreviewFlightClip(frame, clip, box, { x: 0, y: 80, width: 390, height: 640 });
  assert.equal(frame.style.clipPath, "inset(-20px -210px -420px -20px)");
  assert.deepEqual(getPreviewFlightClip(frame), clip);
  // A partially scrolled card still clips at the physical scrollport boundary.
  setPreviewFlightClip(frame, { ...clip, y: 130, height: 170 }, box, { x: 0, y: 130, width: 390, height: 590 });
  assert.equal(frame.style.clipPath, "inset(30px -210px -420px -20px)");
  setPreviewFlightClip(frame, clip, box);
  assert.equal(frame.style.clipPath, "inset(0px 0px 0px 0px round 20px)");
  setPreviewFlightClip(frame, { ...clip, radius: 0, bottomRadius: 20 }, box);
  assert.equal(
    frame.style.clipPath,
    "inset(0px 0px 0px 0px round 0px 0px 20px 20px)",
    "full-width scene bodies join the heading and preserve only the card bottom corners",
  );
});

test("flight projection is shared by both placement paths and revoked independently of other cards", async () => {
  const { setPreviewFlightProjection, getPreviewFlightProjection } = await import(
    "../../apps/workbench-web/src/components/retained-preview-placement"
  );
  const frame = {} as HTMLElement,
    other = {} as HTMLElement;
  const target = {
    closest: () => frame,
    getBoundingClientRect() {
      throw new Error("projection must not measure");
    },
  } as unknown as HTMLElement;
  const second = { closest: () => other } as unknown as HTMLElement;
  const projection = {
    frame: { x: 0, y: 0, width: 400, height: 800 },
    content: { x: 0, y: 0, width: 400, height: 800 },
    clip: { x: 0, y: 0, width: 400, height: 800, radius: 0 },
    opacity: 1,
    radius: 0,
    shadow: "none",
  };
  setPreviewFlightProjection(frame, projection);
  setPreviewFlightProjection(other, { ...projection, opacity: 0.5 });
  assert.equal(getPreviewFlightProjection(target), projection);
  setPreviewFlightProjection(frame, null);
  assert.equal(getPreviewFlightProjection(target), undefined);
  assert.equal(getPreviewFlightProjection(second)?.opacity, 0.5);
  setPreviewFlightProjection(other, null);
});
