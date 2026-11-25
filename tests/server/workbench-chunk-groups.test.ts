import assert from "node:assert/strict";
import test from "node:test";
import {
  coreStartupCompositionModules,
  createWorkbenchChunkGroups,
  type WorkbenchChunkGroup,
} from "../../apps/workbench-web/code-splitting-groups.vite";

const startupId = (name: string) => `/repo/apps/workbench-web/src/runtime/${name}.ts`;

function startupGroup(groups: WorkbenchChunkGroup[]) {
  const matches = groups.filter((group) => group.name === "startup-composition");
  assert.equal(matches.length, 1);
  return matches[0];
}

/** Function tests are fresh closures per call; compare their source instead. */
function shape(groups: WorkbenchChunkGroup[]) {
  return groups.map((group) => ({
    ...group,
    test: typeof group.test === "function" ? String(group.test) : group.test,
  }));
}

function matches(group: WorkbenchChunkGroup, id: string): boolean {
  const { test: pattern } = group;
  assert.ok(pattern instanceof RegExp);
  return pattern.test(id);
}

test("core chunk groups are unchanged without product options", () => {
  const groups = createWorkbenchChunkGroups();
  assert.deepEqual(shape(groups), shape(createWorkbenchChunkGroups({})));
  assert.deepEqual(shape(groups), shape(createWorkbenchChunkGroups({ startupModules: [], productChunkGroups: [] })));
  assert.equal(startupGroup(groups).test, coreStartupCompositionModules);
  assert.equal(groups[0]?.name, "startup-presentation-leaves");
  assert.equal(groups.at(-1)?.name, "platform");
  for (const name of ["web-workbench-supervisor", "web-workbench-application", "token-usage-builtin"]) {
    assert.ok(matches(startupGroup(groups), startupId(name)), name);
  }
});

test("release startup groups isolate AppHost before the general coalescer", () => {
  const coalescer = { name: "fixture-coalescer", test: /runtime/u };
  const groups = createWorkbenchChunkGroups({}, coalescer);
  assert.equal(groups[0]?.name, "deployment-app-host-startup");
  assert.ok(matches(groups[0]!, startupId("deployment-app-host-startup")));
  assert.ok(matches(groups[0]!, startupId("websocket-app-host")));
  assert.equal(groups[1], coalescer);
  assert.deepEqual(shape(groups.slice(2)), shape(createWorkbenchChunkGroups()));
});

test("product startup modules join core's startup group without replacing it", () => {
  const baseline = createWorkbenchChunkGroups();
  const groups = createWorkbenchChunkGroups({
    startupModules: [/\/products\/example\/web\.ts$/, /\/components\/example-facade\.tsx$/],
  });
  assert.deepEqual(
    groups.map((group) => group.name),
    baseline.map((group) => group.name),
  );
  const startup = startupGroup(groups);
  for (const name of ["web-workbench-supervisor", "web-workbench-application", "token-usage-builtin"]) {
    assert.ok(matches(startup, startupId(name)), name);
  }
  assert.ok(matches(startup, "/repo/products/example/web.ts"));
  assert.ok(matches(startup, "/repo/apps/workbench-web/src/components/example-facade.tsx"));
  assert.equal(matches(startup, "/repo/products/example/other.ts"), false);
  assert.equal(startup.includeDependenciesRecursively, false);
  // Every other core group is preserved as-is.
  const others = (list: WorkbenchChunkGroup[]) => list.filter((group) => group.name !== "startup-composition");
  assert.deepEqual(shape(others(groups)), shape(others(baseline)));
});

test("startup modules must be flag-free patterns", () => {
  assert.throws(() => createWorkbenchChunkGroups({ startupModules: [/x/g] }), /without flags/);
  assert.throws(() => createWorkbenchChunkGroups({ startupModules: ["x" as unknown as RegExp] }), /without flags/);
});

test("product chunk groups precede every core group in their given order", () => {
  const baseline = createWorkbenchChunkGroups();
  const first = {
    name: "example-motion",
    test: /\/node_modules\/example-motion\//,
    includeDependenciesRecursively: false,
  };
  const second = { name: "example-preview", test: /\/example-preview\.tsx$/, includeDependenciesRecursively: false };
  const groups = createWorkbenchChunkGroups({ productChunkGroups: [first, second] });
  assert.equal(groups[0], first);
  assert.equal(groups[1], second);
  assert.deepEqual(shape(groups.slice(2)), shape(baseline));
});

test("product chunk groups cannot shadow core names or reorder by priority", () => {
  assert.throws(
    () => createWorkbenchChunkGroups({ productChunkGroups: [{ name: "startup-composition", test: /x/ }] }),
    /unique name/,
  );
  assert.throws(() => createWorkbenchChunkGroups({ productChunkGroups: [{ name: "", test: /x/ }] }), /unique name/);
  assert.throws(
    () => createWorkbenchChunkGroups({ productChunkGroups: [{ name: "example", test: /x/, priority: 10 }] }),
    /priority/,
  );
});
