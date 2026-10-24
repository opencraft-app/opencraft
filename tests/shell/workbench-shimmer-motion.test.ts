import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOpenCraftThemeCssProperties, opencraftNeutralThemePalette, opencraftCanvasThemePalette } from "@opencraft/design-system/theme-engine";
import { opencraftColorTokens, workingShimmerMotion } from "@opencraft/design-system/tokens";

const web = readFileSync(new URL("../../apps/workbench-web/src/components/conversation-renderers/activity/cadenced-shimmer.tsx", import.meta.url), "utf8");
const webStyles = readFileSync(new URL("../../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");

test("working shimmer leaves a half-second rest between one-way sweeps", () => {
  assert.deepEqual(workingShimmerMotion, {
    firstSweepDelayMs: 600,
    sweepDurationMs: 1_000,
    cycleMs: 1_500,
  });
  assert.equal(workingShimmerMotion.cycleMs - workingShimmerMotion.sweepDurationMs, 500);
});

test("Web loops a one-way sweep with the shared first-sweep delay", () => {
  assert.match(web, /"--working-shimmer-cycle-duration": `\$\{workingShimmerMotion\.cycleMs\}ms`/u);
  assert.match(web, /"--working-shimmer-first-delay": `\$\{workingShimmerMotion\.firstSweepDelayMs\}ms`/u);
  assert.doesNotMatch(web, /setInterval\(sweep/u);
  assert.match(webStyles, /animation-duration:\s*var\(--working-shimmer-cycle-duration, 1\.5s\);[\s\S]*?animation-delay:\s*var\(--working-shimmer-first-delay, 600ms\);[\s\S]*?animation-iteration-count:\s*infinite;/u);
  assert.match(webStyles, /@keyframes workbench-cadenced-shimmer-sweep\s*\{[\s\S]*?66\.6667%,\s*100%\s*\{\s*transform:\s*translateX\(125%\);/u);
});

test("working highlight uses opaque theme ink across Web and Native", () => {
  for (const palette of [opencraftNeutralThemePalette, opencraftCanvasThemePalette]) {
    for (const mode of ["light", "dark"] as const) {
      const css = buildOpenCraftThemeCssProperties(mode, palette[mode]);
      assert.equal(css["--color-text-working-highlight"], palette[mode].ink);
    }
  }
  assert.equal(opencraftColorTokens.light.text.workingHighlight, opencraftNeutralThemePalette.light.ink);
  assert.equal(opencraftColorTokens.dark.text.workingHighlight, opencraftNeutralThemePalette.dark.ink);
  assert.match(webStyles, /\.is-shimmering__highlight\s*\{[^}]*color:\s*var\(--color-text-working-highlight, var\(--color-text\)\)/u);
  assert.doesNotMatch(webStyles, /--shimmer-contrast:\s*color-mix/u);
});
