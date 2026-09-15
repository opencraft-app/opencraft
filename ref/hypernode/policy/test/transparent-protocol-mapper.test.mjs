import assert from "node:assert/strict";
import test from "node:test";
import { TransparentProtocolMapperService } from "../src/services/transparent-protocol-mapper.ts";

function harness() {
  const bindings = new Map([
    ["outer-1", { innerThreadId: "inner-1" }],
    ["outer-2", { innerThreadId: "inner-2" }],
  ]);
  const runtimeHints = new Map([
    ["outer-1", { backendKey: "runtime-1" }],
    ["outer-2", { backendKey: "runtime-2" }],
  ]);
  const threads = new Map([
    ["outer-1", { id: "outer-1", name: "✅ alice · Demo", preview: "Preview" }],
  ]);
  const service = Object.assign(Object.create(TransparentProtocolMapperService.prototype), {
    ctx: {
      transparentThreadBinding: {
        bindings,
        reverseBindings: new Map([
          ["inner-1", "outer-1"],
          ["inner-2", "outer-2"],
        ]),
        runtimeHintFor: (threadId) => runtimeHints.get(threadId) ?? null,
      },
      threadManager: {
        find: (threadId) => threads.get(threadId) ?? null,
        isTransparentCodex: (threadId) => threads.has(threadId),
      },
    },
  });
  const filesystem = {
    owns: (path) => path.startsWith("/workspace/"),
    toPhysical: (path, _user, viewId) => `/physical/${viewId}${path}`,
    toVirtual: (path, _user, viewId) => path.startsWith(`/physical/${viewId}`)
      ? path.slice(`/physical/${viewId}`.length)
      : path,
  };
  return { service, filesystem };
}

test("maps public Thread IDs and virtual paths into one Runtime generation", () => {
  const { service, filesystem } = harness();
  const state = {
    backendKey: "runtime-1",
    opening: new Set(),
    user: { id: "alice" },
    viewId: "main",
  };

  assert.deepEqual(service.toInner({
    params: { threadId: "outer-1", cwd: "/workspace/projects/demo" },
  }, state, filesystem), {
    params: { threadId: "inner-1", cwd: "/physical/main/workspace/projects/demo" },
  });
  assert.deepEqual(service.toInner({ params: { threadId: "outer-2" } }, state, filesystem), {
    params: { threadId: "outer-2" },
  });
});

test("maps only the owning Runtime generation back to the stable public namespace", () => {
  const { service, filesystem } = harness();
  const state = {
    backendKey: "runtime-1",
    opening: new Set(),
    user: null,
    viewId: "main",
  };

  assert.deepEqual(service.toOuter({
    result: {
      thread: {
        id: "inner-1",
        name: "backend-owned-name",
        cwd: "/physical/main/workspace/projects/demo",
      },
    },
  }, state, filesystem), {
    result: {
      thread: {
        id: "outer-1",
        name: "☁️ Demo",
        cwd: "/workspace/projects/demo",
      },
    },
  });
  assert.equal(service.outerThreadId("inner-2", state), null);
  state.opening.add("outer-2");
  assert.equal(service.outerThreadId("inner-2", state), "outer-2");
});
