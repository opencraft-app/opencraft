import assert from "node:assert/strict";
import test from "node:test";
import { transformImage, wheelPixels, type ImageTransform } from "../../packages/chat-render-web/src/image-transform";

const geometry = { width: 1000, height: 800, viewportWidth: 500, viewportHeight: 400 };
const fitted: ImageTransform = { x: 0, y: 0, scale: 1, rotation: 0 };
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test("pinch keeps the point under the cursor stationary", () => {
  const next = transformImage(fitted, { x: 100, y: 50 }, { x: 100, y: 50 }, 2, 0, geometry);
  near(next.x, -100);
  near(next.y, -50);
  near(next.x + 100 * next.scale, 100);
  near(next.y + 50 * next.scale, 50);
});

test("pan uses the rotated image bounds", () => {
  const rotated = transformImage(fitted, { x: 0, y: 0 }, { x: 1000, y: 1000 }, 1, Math.PI / 2, geometry);
  near(rotated.x, 150);
  near(rotated.y, 300);
  const panned = transformImage(rotated, { x: 0, y: 0 }, { x: -2000, y: -2000 }, 1, 0, geometry);
  near(panned.x, -150);
  near(panned.y, -300);
});

test("rotation and scale share the same anchor calculation", () => {
  const next = transformImage(fitted, { x: 50, y: 0 }, { x: 50, y: 0 }, 2, Math.PI / 2, geometry);
  near(next.x, 50);
  near(next.y, -100);
  near(next.rotation, Math.PI / 2);
});

test("all devices keep the existing scale limits and reject invalid input", () => {
  assert.equal(transformImage(fitted, fitted, fitted, 100, 0, geometry).scale, 5);
  const small = transformImage(fitted, fitted, { x: 500, y: 500 }, 0.01, 0, geometry);
  assert.equal(small.scale, 0.2);
  near(small.x, 0);
  near(small.y, 0);
  assert.equal(transformImage(fitted, fitted, fitted, NaN, 0, geometry), fitted);
  assert.equal(transformImage(fitted, fitted, fitted, 1, Infinity, geometry), fitted);
});

test("wheel normalization supports pixel, line and page deltas", () => {
  assert.equal(wheelPixels(2, 0, 400), 2);
  assert.equal(wheelPixels(2, 1, 400), 32);
  assert.equal(wheelPixels(2, 2, 400), 800);
});
