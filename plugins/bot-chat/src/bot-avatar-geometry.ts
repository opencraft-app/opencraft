import type { BotAvatarShapeName } from "./bot-avatar-shapes";

export const BOT_AVATAR_RING_SAMPLES = 48;

export type BotAvatarPoint = readonly [number, number];
export type BotAvatarRing = readonly BotAvatarPoint[];

const CENTER = 20;

function signedPower(value: number, exponent: number): number {
  return Math.sign(value) * Math.abs(value) ** exponent;
}

function parametricRing(
  point: (angle: number) => BotAvatarPoint,
): BotAvatarRing {
  return Object.freeze(
    Array.from({ length: BOT_AVATAR_RING_SAMPLES }, (_, index) =>
      Object.freeze(
        point(-Math.PI / 2 + (index / BOT_AVATAR_RING_SAMPLES) * Math.PI * 2),
      ),
    ),
  );
}

function superellipse(
  radiusX: number,
  radiusY: number,
  power: number,
  transform?: (point: BotAvatarPoint, angle: number) => BotAvatarPoint,
): BotAvatarRing {
  return parametricRing((angle) => {
    const point: BotAvatarPoint = [
      CENTER + radiusX * signedPower(Math.cos(angle), 2 / power),
      CENTER + radiusY * signedPower(Math.sin(angle), 2 / power),
    ];
    return transform?.(point, angle) ?? point;
  });
}

function polygonRing(vertices: readonly BotAvatarPoint[]): BotAvatarRing {
  const lengths = vertices.map((point, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    return Math.hypot(next[0] - point[0], next[1] - point[1]);
  });
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  return Object.freeze(
    Array.from({ length: BOT_AVATAR_RING_SAMPLES }, (_, sampleIndex) => {
      let distance = (sampleIndex / BOT_AVATAR_RING_SAMPLES) * perimeter;
      let edge = 0;
      while (distance > lengths[edge]! && edge < vertices.length - 1) {
        distance -= lengths[edge]!;
        edge += 1;
      }
      const start = vertices[edge]!;
      const end = vertices[(edge + 1) % vertices.length]!;
      const amount = distance / Math.max(lengths[edge]!, 0.001);
      return Object.freeze([
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ] as const);
    }),
  );
}

const SHAPE_RINGS: Readonly<Record<BotAvatarShapeName, BotAvatarRing>> =
  Object.freeze({
    blob: parametricRing((angle) => {
      const radius =
        17.1 * (1 + 0.035 * Math.sin(3 * angle) + 0.025 * Math.cos(5 * angle));
      return [
        CENTER + Math.cos(angle) * radius,
        CENTER + Math.sin(angle) * radius * 1.02,
      ];
    }),
    pebble: parametricRing((angle) => {
      const radius = 16.8 * (1 + 0.035 * Math.sin(2 * angle + 0.6));
      return [
        CENTER + Math.cos(angle) * radius * 1.04,
        CENTER + Math.sin(angle) * radius,
      ];
    }),
    bean: parametricRing((angle) => {
      const pinch = 1 - 0.13 * Math.max(0, Math.cos(angle + 0.55));
      return [
        CENTER + Math.cos(angle) * 17 * pinch + 1.5 * Math.sin(angle),
        CENTER + Math.sin(angle) * 17.4,
      ];
    }),
    egg: parametricRing((angle) => {
      const width = 13.6 + 3.4 * ((Math.sin(angle) + 1) / 2);
      return [CENTER + Math.cos(angle) * width, CENTER + Math.sin(angle) * 18];
    }),
    squircle: superellipse(17.5, 17.5, 4.2),
    tablet: superellipse(18.5, 14.6, 4.8),
    capsule: superellipse(12.8, 18.1, 4.6),
    cylinder: superellipse(12.5, 18.2, 7.5),
    wedge: polygonRing([
      [20, 2],
      [38, 36.5],
      [2, 36.5],
    ]),
    hex: polygonRing([
      [20, 2],
      [35.6, 10.8],
      [35.6, 29.2],
      [20, 38],
      [4.4, 29.2],
      [4.4, 10.8],
    ]),
    gem: polygonRing([
      [20, 1.8],
      [35.8, 10.2],
      [31.5, 37.5],
      [8.5, 37.5],
      [4.2, 10.2],
    ]),
    crystal: polygonRing([
      [20, 1.2],
      [34.5, 7],
      [38, 24],
      [28, 38],
      [12, 38],
      [2, 24],
      [5.5, 7],
    ]),
    shield: polygonRing([
      [20, 1.8],
      [35.5, 7.2],
      [34.5, 25.2],
      [27.8, 34.3],
      [20, 38.4],
      [12.2, 34.3],
      [5.5, 25.2],
      [4.5, 7.2],
    ]),
    dome: parametricRing((angle) => {
      const y = CENTER + Math.sin(angle) * 17.5;
      const lower = Math.sin(angle) > 0.45 ? Math.min(y, 36.8) : y;
      return [CENTER + Math.cos(angle) * 17.2, lower];
    }),
    arch: superellipse(14, 18, 3.6, ([x, y], angle) => [
      x,
      Math.sin(angle) > 0.55 ? Math.min(y, 37) : y,
    ]),
    cloud: parametricRing((angle) => {
      const lobes =
        1 + 0.08 * Math.cos(5 * angle) + 0.035 * Math.sin(3 * angle);
      return [
        CENTER + Math.cos(angle) * 18 * lobes,
        21 + Math.sin(angle) * 15.4 * lobes,
      ];
    }),
    teardrop: parametricRing((angle) => {
      const width = 13 + 4.2 * ((Math.sin(angle) + 1) / 2);
      return [
        CENTER + Math.cos(angle) * width,
        CENTER + Math.sin(angle) * 18.4,
      ];
    }),
    leaf: parametricRing((angle) => {
      const point = Math.abs(Math.sin(angle));
      const width = 17.5 * (0.72 + 0.28 * point);
      return [
        CENTER + Math.cos(angle) * width,
        CENTER + Math.sin(angle) * 18 + Math.cos(angle) * 2.2,
      ];
    }),
  });

export function botAvatarShapeRing(shape: BotAvatarShapeName): BotAvatarRing {
  return SHAPE_RINGS[shape];
}

export function interpolateBotAvatarRings(
  from: BotAvatarRing,
  to: BotAvatarRing,
  amount: number,
): BotAvatarRing {
  if (from.length !== to.length)
    throw new Error("Bot avatar rings must share one topology");
  const clamped = Math.min(1, Math.max(0, amount));
  return from.map(([x, y], index) => {
    const target = to[index]!;
    return [
      x + (target[0] - x) * clamped,
      y + (target[1] - y) * clamped,
    ] as const;
  });
}

export function botAvatarRingPath(ring: BotAvatarRing): string {
  const point = (index: number) => ring[(index + ring.length) % ring.length]!;
  const round = (value: number) => Math.round(value * 100) / 100;
  let path = `M${round(ring[0]![0])} ${round(ring[0]![1])}`;
  for (let index = 0; index < ring.length; index += 1) {
    const previous = point(index - 1);
    const current = point(index);
    const next = point(index + 1);
    const after = point(index + 2);
    path += `C${round(current[0] + (next[0] - previous[0]) / 6)} ${round(current[1] + (next[1] - previous[1]) / 6)} ${round(next[0] - (after[0] - current[0]) / 6)} ${round(next[1] - (after[1] - current[1]) / 6)} ${round(next[0])} ${round(next[1])}`;
  }
  return `${path}Z`;
}

export function botAvatarSpanAtY(
  ring: BotAvatarRing,
  y: number,
): readonly [number, number] {
  const intersections: number[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index]!;
    const end = ring[(index + 1) % ring.length]!;
    if (start[1] <= y === end[1] <= y) continue;
    intersections.push(
      start[0] + ((end[0] - start[0]) * (y - start[1])) / (end[1] - start[1]),
    );
  }
  if (intersections.length < 2) return [CENTER, CENTER];
  return [Math.min(...intersections), Math.max(...intersections)];
}

export function fitBotAvatarEyeCenter(
  ring: BotAvatarRing,
  desiredCenterX: number,
  centerY: number,
  width: number,
  padding: number,
  height = 0,
): number {
  const spans = [
    botAvatarSpanAtY(ring, centerY),
    botAvatarSpanAtY(ring, centerY - height / 2),
    botAvatarSpanAtY(ring, centerY + height / 2),
  ];
  const left = Math.max(...spans.map((span) => span[0]));
  const right = Math.min(...spans.map((span) => span[1]));
  const minimum = left + width / 2 + padding;
  const maximum = right - width / 2 - padding;
  if (minimum > maximum) return (left + right) / 2;
  return Math.min(maximum, Math.max(minimum, desiredCenterX));
}
