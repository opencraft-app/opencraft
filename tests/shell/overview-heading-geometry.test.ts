import assert from "node:assert/strict";
import test from "node:test";
import {
  projectOverviewHeading,
  type OverviewHeadingMetrics,
} from "../../apps/workbench-web/src/components/overview-heading-geometry";

const metrics: OverviewHeadingMetrics = {
  rect: { x: 0, y: 0, width: 168, height: 64 },
  inkTop: 22,
  inkBottom: 42,
  bandHeight: 64,
  frameWidth: 168,
};
const frame = { x: 24, y: 30, width: 168, height: 240 };
const at = (progress: number, heading = metrics) =>
  projectOverviewHeading(
    { ...frame, width: heading.frameWidth },
    { ...frame, y: frame.y + heading.bandHeight * progress },
    heading,
    progress,
  );

test("scene endpoint has no heading; card endpoint exactly matches normal heading layout", () => {
  assert.equal(at(0).opacity, 0);
  assert.deepEqual(at(1), { rect: { ...metrics.rect, x: frame.x, y: frame.y }, opacity: 1 });
  const inset = { ...metrics, rect: { ...metrics.rect, x: 8, y: 4 }, bandHeight: 72, frameWidth: 184 };
  assert.deepEqual(at(1, inset), { rect: { ...inset.rect, x: frame.x + 8, y: frame.y + 4 }, opacity: 1 });
});

test("the title row and trailing action follow the current frame width without scaling typography", () => {
  const heading = { ...metrics, rect: { ...metrics.rect, x: 8 }, frameWidth: 184 };
  const current = { ...frame, width: 300 };
  const title = projectOverviewHeading(current, { ...current, y: current.y + 32 }, heading, 0.5);
  assert.equal(title.rect.x, frame.x + 4);
  assert.equal(title.rect.width, 292);
  assert.equal(title.rect.x + title.rect.width, current.x + current.width - 4);
  assert.equal(title.rect.height, heading.rect.height);
});

test("title uses available ink space during the morph, rather than waiting for the inert hit box", () => {
  assert.ok(at(0.65).opacity > 0.2, "title should already be readable while the band is forming");
  const values = Array.from({ length: 101 }, (_, i) => at(i / 100).opacity);
  assert.ok(
    values.filter((value) => value > 0.1 && value < 0.9).length > 20,
    "the reveal must occupy a range of geometry, not a near-end threshold",
  );
  assert.ok(values.every((value, i) => i === 0 || value >= values[i - 1]));
});

test("visible text and icons fit their band in either direction across density and asymmetric insets", () => {
  for (const heading of [
    metrics,
    { ...metrics, rect: { ...metrics.rect, height: 88 }, inkTop: 28, inkBottom: 60, bandHeight: 88 },
    { ...metrics, rect: { ...metrics.rect, y: 4 }, bandHeight: 72 },
  ]) {
    for (let i = 0; i <= 100; i++) {
      const p = i / 100,
        forward = at(p, heading),
        reverse = at(1 - (100 - i) / 100, heading);
      assert.ok(Math.abs(forward.opacity - reverse.opacity) < 1e-10);
      if (forward.opacity === 0) continue;
      assert.ok(forward.rect.y + heading.inkTop >= frame.y - 1e-10);
      assert.ok(forward.rect.y + heading.inkBottom <= frame.y + heading.bandHeight * p + 1e-10);
    }
  }
});
