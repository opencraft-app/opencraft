import assert from "node:assert/strict";
import test from "node:test";
import { createShellNavigationState, projectShellNavigation, reduceShellNavigation, resolveShellNavigationWidth, shellNavigationMetrics } from "../packages/workbench-runtime/src/shell-navigation";

const project = (state = createShellNavigationState(), viewportWidth = 1400, previouslyAvailable?: boolean) =>
  projectShellNavigation({ state, viewportWidth, contextWidth: 275, contextAvailable: true, sidecarOpen: true, previouslyAvailable });

test("unified sidebar ignores former application rail pins and detents without changing preferences", () => {
  for (const railDetent of ["expanded", "compact", "hidden"] as const) for (const sidecarOpen of [true, false]) {
    const state = createShellNavigationState({ applications: true, account: true, railDetent });
    const before = structuredClone(state);
    const result = projectShellNavigation({ unified: true, state, viewportWidth: 1400,
      contextWidth: 275, contextAvailable: true, sidecarOpen });
    assert.equal(result.railWidth, 0, "no second column consumes the window budget");
    assert.equal(result.dockOpen, false);
    assert.equal(result.footerVisible, sidecarOpen, "footer follows the whole sidebar");
    assert.equal(result.contextOpen, sidecarOpen);
    assert.deepEqual(state, before, "migration presents one column without overwriting durable preferences");
  }
  const account = reduceShellNavigation(createShellNavigationState(), { type: "toggle", surface: "account", dockAvailable: false });
  assert.equal(projectShellNavigation({ unified: true, state: account, viewportWidth: 390,
    contextWidth: 275, contextAvailable: true, sidecarOpen: false }).peek, "account");
});

test("application width preferences are bounded and invalid storage falls back safely", () => {
  assert.equal(shellNavigationMetrics.compactActionSize, 36, "compact rail uses the shared 36px control rather than the 34px text row");
  assert.deepEqual({
    compact: shellNavigationMetrics.compactWidth,
    expanded: shellNavigationMetrics.columnWidth,
    expandedMinimum: shellNavigationMetrics.expandedMinimumWidth,
    footerMinimum: shellNavigationMetrics.footerMinimumWidth,
  }, { compact: 52, expanded: 137, expandedMinimum: 126, footerMinimum: 260 });
  for (const value of [undefined, null, "300", NaN, Infinity]) assert.equal(resolveShellNavigationWidth(value), 137);
  assert.equal(resolveShellNavigationWidth(100), 126);
  assert.equal(resolveShellNavigationWidth(137), 137);
  assert.equal(shellNavigationMetrics.expandedMaximumWidth, 137);
  assert.equal(resolveShellNavigationWidth(132), 132, "valid custom widths remain intact");
  for (const width of [182.828125, 340, 520, 900]) {
    assert.equal(resolveShellNavigationWidth(width), 137, "legacy oversize preferences respect the content cap");
  }
  const input = { state: createShellNavigationState({ applications: true }), viewportWidth: 1100, contextWidth: 275, contextAvailable: true, sidecarOpen: true };
  assert.equal(projectShellNavigation({ ...input, navigationWidth: 340 }).dockOpen, true);
  assert.equal(projectShellNavigation({ ...input, navigationWidth: 520 }).railWidth, 137);
  assert.equal(projectShellNavigation({ ...input, viewportWidth: 800, navigationWidth: 520 }).dockOpen, false);
  assert.equal(project().footer.right, project().footer.left, "symmetric insets let the platform fill the first rail");
});

test("application pane detent is independent from pin preferences and expanded width", () => {
  const compact = createShellNavigationState({ applications: true, account: false, railDetent: "compact" });
  assert.equal(compact.railDetent, "compact");
  assert.equal(projectShellNavigation({
    state: compact,
    viewportWidth: 800,
    contextWidth: 275,
    contextAvailable: true,
    sidecarOpen: true,
    navigationWidth: 520,
  }).railWidth, 52, "compact projection does not overwrite the remembered expanded width");
  const expanded = reduceShellNavigation(compact, { type: "set-rail-detent", detent: "expanded" });
  assert.equal(expanded.railDetent, "expanded");
  const hidden = reduceShellNavigation(compact, { type: "set-rail-detent", detent: "hidden" });
  assert.deepEqual(hidden.pinned, compact.pinned, "physical hiding never rewrites content preferences");
  assert.equal(hidden.railDetent, "hidden");
  assert.equal(hidden.lastVisibleRailDetent, "compact");
  const reopened = reduceShellNavigation(hidden, { type: "toggle", surface: "applications", dockAvailable: true });
  assert.equal(reopened.railDetent, "compact", "the entrance restores the last visible shelf");
  assert.equal(reopened.pinned.applications, true);
});

test("applications default unpinned and account remains an independent preference", () => {
  assert.deepEqual(createShellNavigationState().pinned, { applications: false, account: false });
  assert.deepEqual(createShellNavigationState({ applications: false, account: true }).pinned, { applications: false, account: true });
  for (const invalid of [null, false, 1, "bad", { applications: "true", account: [] }]) {
    assert.deepEqual(createShellNavigationState(invalid), createShellNavigationState());
  }
});

test("a pin preserves the local entrance frame, but a closed Sidecar hides it", () => {
  const expected = project().footer;
  for (const applications of [true, false]) for (const account of [true, false]) {
    const state = createShellNavigationState({ applications, account });
    for (const sidecarOpen of [true, false]) for (const contextWidth of [240, 275, 520]) {
      const projection = projectShellNavigation({ state, viewportWidth: 1400, contextAvailable: true, sidecarOpen, contextWidth });
      assert.deepEqual(projection.footer, expected);
      assert.equal(projection.dockOpen, sidecarOpen && (applications || account));
      assert.equal(projection.footerVisible, sidecarOpen);
    }
  }
});

test("width pressure with a collapsed conversation leaves no orphan footer", () => {
  const state = createShellNavigationState();
  const projection = projectShellNavigation({ state, viewportWidth: 400, contextWidth: 275, contextAvailable: true, sidecarOpen: false });
  assert.equal(projection.footerVisible, false);
  assert.equal(state.pinned.applications, false);
});

test("narrow presentation preserves pins, supports peek, restores with hysteresis", () => {
  const state = createShellNavigationState({ applications: true, account: true });
  assert.equal(project(state, 831).dockOpen, false);
  assert.equal(project(state, 847, false).dockOpen, false);
  assert.equal(project(state, 864, false).dockOpen, true);
  assert.equal(project(state, 847, true).dockOpen, true);
  const peek = reduceShellNavigation(state, { type: "toggle", surface: "applications", dockAvailable: false });
  assert.equal(project(peek, 400).peek, "applications");
  assert.deepEqual(peek.pinned, state.pinned);
  const dismissed = reduceShellNavigation(peek, { type: "dismiss", surface: "applications" });
  assert.deepEqual(dismissed, state);
});

test("transient surfaces are exclusive and do not unpin their peer", () => {
  const state = createShellNavigationState({ applications: false, account: false });
  const apps = reduceShellNavigation(state, { type: "toggle", surface: "applications", dockAvailable: false });
  const account = reduceShellNavigation(apps, { type: "toggle", surface: "account", dockAvailable: true });
  assert.equal(account.peek, "account");
  const pinned = reduceShellNavigation(account, { type: "pin", surface: "account", pinned: true });
  assert.equal(pinned.peek, null);
  assert.deepEqual(pinned.pinned, { applications: false, account: true });
  const toggled = reduceShellNavigation(pinned, { type: "toggle", surface: "account", dockAvailable: true });
  assert.equal(toggled.pinned.account, false);
});

test("applications toggle directly and rapidly without a menu or changing account preference", () => {
  let state = createShellNavigationState({ applications: false, account: true });
  for (let index = 0; index < 20; index++) {
    state = reduceShellNavigation(state, { type: "toggle", surface: "applications", dockAvailable: true });
    assert.equal(state.pinned.applications, index % 2 === 0);
    assert.equal(state.pinned.account, true);
    assert.equal(state.peek, null);
    assert.equal(project(state).docked.applications, state.pinned.applications);
  }
});

test("platform container may suspend docking without erasing user preferences", () => {
  const state = createShellNavigationState();
  const projection = projectShellNavigation({ state, viewportWidth: 1400, contextWidth: 275, contextAvailable: true, sidecarOpen: true, allowDock: false });
  assert.equal(projection.dockOpen, false);
  assert.equal(state.pinned.applications, false);
  assert.deepEqual(projection.footer, project(state).footer);
});

test("restoring durable preferences never preserves a transient peek", () => {
  const transient = reduceShellNavigation(createShellNavigationState(), {
    type: "toggle",
    surface: "applications",
    dockAvailable: false,
  });
  assert.equal(transient.peek, "applications");
  const restored = reduceShellNavigation(transient, {
    type: "restore-preferences",
    preferences: {
      applications: true,
      account: false,
      railDetent: "compact",
      lastVisibleRailDetent: "compact",
    },
  });
  assert.deepEqual(restored, createShellNavigationState({
    applications: true,
    account: false,
    railDetent: "compact",
    lastVisibleRailDetent: "compact",
  }));
});

test("context-free applications use one navigation pane without changing pin preferences", () => {
  const state = createShellNavigationState({ applications: false, account: false });
  for (const viewportWidth of [640, 1400]) {
    const input = { state, viewportWidth, contextWidth: 275, contextAvailable: false, sidecarOpen: true };
    const projection = projectShellNavigation(input);
    assert.equal(projection.contextOpen, false);
    assert.equal(projection.primaryNavigation, true);
    assert.equal(projection.dockOpen, true);
    assert.equal(projectShellNavigation({ ...input, sidecarOpen: false }).footerVisible, false);
    assert.equal(projectShellNavigation({ ...input, contextAvailable: true }).dockOpen, false);
    assert.deepEqual(state.pinned, { applications: false, account: false });
  }
});
