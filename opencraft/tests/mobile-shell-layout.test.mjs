import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMobileShellLayout, resolveMobileSurfaceExitDistance } from '../apps/workbench-expo/src/runtime/mobile-shell-layout.ts';

const metrics = {
  sidebarWidth: 320, minimumContentWidth: 480,
  drawerWidthFraction: 0.52, drawerMaximumWidth: 250,
  panelMinimumWidth: 560, panelMaximumWidth: 680, panelInset: 24,
};

test('a tablet in a narrow window keeps drawer navigation; width is container space', () => {
  assert.equal(resolveMobileShellLayout(390, metrics).navigation, 'drawer');
  assert.equal(resolveMobileShellLayout(799, metrics).navigation, 'drawer');
  assert.equal(resolveMobileShellLayout(800, metrics).navigation, 'sidebar');
  assert.equal(resolveMobileShellLayout(1366, metrics).navigationWidth, 320);
});

test('sidebar always leaves the required usable content space across a continuous resize', () => {
  for (let width = 1; width <= 1600; width += 1) {
    const layout = resolveMobileShellLayout(width, metrics);
    assert.ok(layout.navigationWidth <= width);
    assert.ok(layout.accountWidth <= width);
    if (layout.navigation === 'sidebar') assert.ok(width - layout.navigationWidth >= metrics.minimumContentWidth);
    if (layout.account === 'panel') {
      assert.ok(layout.accountWidth >= metrics.panelMinimumWidth);
      assert.ok(width - layout.accountWidth >= metrics.panelInset * 2);
    }
  }
});

test('account panel capacity is independent of sidebar capacity', () => {
  assert.equal(resolveMobileShellLayout(607, metrics).account, 'page');
  const middle = resolveMobileShellLayout(650, metrics);
  assert.equal(middle.account, 'panel');
  assert.equal(middle.navigation, 'drawer');
  assert.equal(middle.accountWidth, 602);
  assert.equal(resolveMobileShellLayout(1366, metrics).accountWidth, 680);
});

test('unmeasured and invalid sizes never produce negative geometry or a wide presentation', () => {
  for (const width of [0, -1, NaN, Infinity]) {
    assert.deepEqual(resolveMobileShellLayout(width, metrics), {
      navigation: 'drawer', navigationWidth: 0, account: 'page', accountWidth: 0,
    });
  }
});

test('dismissal clears the host edge before a centered panel can be released', () => {
  for (const width of [390, 650, 834, 1024, 1366]) {
    const layout = resolveMobileShellLayout(width, metrics);
    const left = (width - layout.accountWidth) / 2;
    const exitDistance = resolveMobileSurfaceExitDistance(width, left);
    assert.equal(left + exitDistance, width, 'the completed surface has no visible portion');
    assert.ok(left + exitDistance * 0.9 < width, 'the surface remains present before completion');
    if (left > 0) {
      assert.ok(left + layout.accountWidth < width, 'moving only the panel width leaves a visible tail');
      assert.ok(exitDistance > layout.accountWidth);
    }
  }
});

test('exit geometry cannot produce a zero divisor during initial measurement', () => {
  for (const width of [0, -1, NaN, Infinity]) {
    assert.equal(resolveMobileSurfaceExitDistance(width, 0), 1);
  }
});
