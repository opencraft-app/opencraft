import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCodexThemeCssProperties, codexThemePalette, velaThemePalette } from "@opencraft/design-system/theme-engine";
import { codexColorTokens, workingShimmerMotion } from "@opencraft/design-system/tokens";

const web = readFileSync(new URL("../apps/workbench-web/src/components/conversation-renderers/activity/activity-disclosure.tsx", import.meta.url), "utf8");
const native = readFileSync(new URL("../apps/workbench-expo/src/components/workbench-conversation.tsx", import.meta.url), "utf8");
const webStyles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");

test("working shimmer leaves a half-second rest between one-way sweeps", () => {
  assert.deepEqual(workingShimmerMotion, {
    firstSweepDelayMs: 600,
    sweepDurationMs: 1_000,
    cycleMs: 1_500,
  });
  assert.equal(workingShimmerMotion.cycleMs - workingShimmerMotion.sweepDurationMs, 500);
});

test("Web loops a one-way sweep while Native schedules from the first sweep", () => {
  assert.match(web, /"--working-shimmer-cycle-duration": `\$\{workingShimmerMotion\.cycleMs\}ms`/u);
  assert.match(web, /"--working-shimmer-first-delay": `\$\{workingShimmerMotion\.firstSweepDelayMs\}ms`/u);
  assert.doesNotMatch(web, /setInterval\(sweep/u);
  assert.match(webStyles, /animation-duration:\s*var\(--working-shimmer-cycle-duration, 1\.5s\);[\s\S]*?animation-delay:\s*var\(--working-shimmer-first-delay, 600ms\);[\s\S]*?animation-iteration-count:\s*infinite;/u);
  assert.match(webStyles, /@keyframes workbench-cadenced-shimmer-sweep\s*\{[\s\S]*?66\.6667%,\s*100%\s*\{\s*transform:\s*translateX\(125%\);/u);
  assert.match(native, /setTimeout\(\(\) => \{\s*sweep\(\);\s*interval = setInterval\(sweep, workingShimmerMotion\.cycleMs\);\s*\}, workingShimmerMotion\.firstSweepDelayMs\)/u);
  assert.match(native, /duration:\s*workingShimmerMotion\.sweepDurationMs/u);
  assert.doesNotMatch(native, /setInterval\(sweep, 4_000\)/u);
});

test("working highlight uses opaque theme ink across Web and Native", () => {
  for (const palette of [codexThemePalette, velaThemePalette]) {
    for (const mode of ["light", "dark"] as const) {
      const css = buildCodexThemeCssProperties(mode, palette[mode]);
      assert.equal(css["--color-text-working-highlight"], palette[mode].ink);
    }
  }
  assert.equal(codexColorTokens.light.text.workingHighlight, codexThemePalette.light.ink);
  assert.equal(codexColorTokens.dark.text.workingHighlight, codexThemePalette.dark.ink);
  assert.match(webStyles, /\.is-shimmering__highlight\s*\{[^}]*color:\s*var\(--color-text-working-highlight, var\(--color-text\)\)/u);
  assert.doesNotMatch(webStyles, /--shimmer-contrast:\s*color-mix/u);
  assert.match(native, /cadencedTextHighlight:\s*\{\s*color:\s*theme\.color\.text\.workingHighlight\s*\}/u);
});
