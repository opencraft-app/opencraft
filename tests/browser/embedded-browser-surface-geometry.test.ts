import assert from "node:assert/strict";
import test from "node:test";
import { WebIframeSurfaceHost } from "../../apps/workbench-web/src/browser/web-browser-surface-host";

test("iframe placement subtracts the embedded root offset while retaining viewport dimensions", () => {
  const host = new WebIframeSurfaceHost();
  const root = { getBoundingClientRect: () => ({ left: 320, top: 48 }), prepend() {} };
  host.setRoot(root as unknown as HTMLElement);
  const attributes = new Map<string, string>();
  const iframe = { style: {} as Record<string, string>, dataset: {}, tabIndex: 0,
    setAttribute: (name: string, value: string) => attributes.set(name, value) };
  const container = { style: {} as Record<string, string>, dataset: {} };
  // Supply a physical surface without a browser; the production commit and
  // visibility paths run unchanged against measured window coordinates.
  (host as any).surfaces.set("page", { container, iframe });
  const layout = {
    visualBounds: { x: 1000, y: 140, width: 450, height: 600 },
    stageBounds: { x: 1000, y: 140, width: 450, height: 600 },
    viewportSize: { width: 900, height: 1200 }, scale: 0.5,
  };
  host.commit("page" as any, layout, "visible");
  assert.equal(container.style.left, "680px");
  assert.equal(container.style.top, "92px");
  assert.equal(container.style.width, "450px");
  assert.equal(iframe.style.width, "900px");
  assert.equal(iframe.style.transform, "scale(0.5)");
  host.park("page" as any);
  assert.equal(container.style.pointerEvents, "none");
  assert.equal(attributes.get("aria-hidden"), "true");
  root.getBoundingClientRect = () => ({ left: 0, top: 0 });
  host.commit("page" as any, layout, "visible");
  assert.equal(container.style.left, "1000px", "standalone keeps window coordinates");
  assert.equal(iframe.tabIndex, 0);
});


test("reveal clips pixels without shrinking a fixed-device backing or changing embedded coordinates", () => {
  const host = new WebIframeSurfaceHost();
  host.setRoot({ getBoundingClientRect: () => ({ left: 320, top: 48 }), prepend() {} } as unknown as HTMLElement);
  const iframe = { style: {} as Record<string, string>, dataset: {}, tabIndex: 0, setAttribute() {} };
  const container = { style: {} as Record<string, string>, dataset: {} };
  (host as any).surfaces.set("page", { container, iframe });
  const layout = { visualBounds: { x: 500, y: 100, width: 200, height: 400 },
    stageBounds: { x: 520, y: 130, width: 100, height: 320 }, viewportSize: { width: 400, height: 800 }, scale: 0.5 };
  host.commit("page" as any, layout, "visible");
  assert.equal(container.style.clipPath, "inset(30px 80px 50px 20px)");
  assert.equal(container.style.left, "180px");
  assert.equal(container.style.width, "200px");
  assert.equal(iframe.style.width, "400px");
  host.commit("page" as any, { ...layout, stageBounds: layout.visualBounds }, "visible");
  assert.equal(container.style.clipPath, "inset(0px 0px 0px 0px)", "reveal clears the prior clip");
  host.commit("page" as any, { ...layout, stageBounds: { x: 900, y: 100, width: 0, height: 400 } }, "staged");
  assert.equal(container.style.clipPath, "inset(0px 0px 0px 200px)", "offscreen backing has no painted/hittable width");
  assert.equal(iframe.style.width, "400px");
});
