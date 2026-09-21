import assert from "node:assert/strict";
import test from "node:test";

import { TransparentRuntimeAccessService } from
  "../src/services/transparent-runtime-access.ts";

function filesystem(name, overrides = {}) {
  return {
    name,
    physicalRoot: `/run/${name}`,
    normalize: (path) => path,
    owns: () => true,
    toPhysical: (path) => `/physical/${name}${path}`,
    toVirtual: (path) => path.replace(`/physical/${name}`, ""),
    ensureWorkingDirectory: (path) => path,
    spawnAppServer: () => {},
    spawnThreadRuntime: () => {},
    send: () => {},
    drain: () => ({}),
    kill: () => {},
    terminateThreadRuntime: () => {},
    ...overrides,
  };
}

function harness() {
  const rawLocal = filesystem("local", { enabled: false, mount: "/localhost" });
  const workspace = filesystem("workspace", { enabled: true, mount: "/workspace" });
  const mapperCalls = [];
  const located = { processId: "process-1" };
  const service = Object.create(TransparentRuntimeAccessService.prototype);
  service.initializedFilesystem = null;
  service.ctx = {
    runtimeWorkspace: {
      isWorkspaceFilesystem: (candidate) => candidate === workspace,
      defaultFilesystem: () => workspace,
      filesystemForCwd: (cwd, local) => cwd?.startsWith("/workspace") ? workspace : local,
      filesystemForRealm: (realm, local) => realm === "workspace" ? workspace : local,
    },
    transparentProtocolMapper: {
      toInner: (message, state, selected) => {
        mapperCalls.push(["inner", state, selected]);
        return { ...message, mapped: "inner" };
      },
      toOuter: (message, state, selected) => {
        mapperCalls.push(["outer", state, selected]);
        return { ...message, mapped: "outer" };
      },
      toPhysical: (path, state, selected) => {
        mapperCalls.push(["physical", state, selected]);
        return `${selected.name}:${path}`;
      },
      toVirtual: (path, state, selected) => {
        mapperCalls.push(["virtual", state, selected]);
        return `${selected.name}:${path}`;
      },
    },
    transparentRuntimeLocator: {
      stateForOuter: (threadId, local) => {
        assert.equal(threadId, "thread-1");
        assert.equal(local, service.localFilesystem);
        return located;
      },
    },
  };
  service.initialize(rawLocal);
  return { service, rawLocal, workspace, mapperCalls, located };
}

test("runtime access owns the public Codex-home alias and realm selection", () => {
  const { service, workspace } = harness();

  assert.equal(
    service.localFilesystem.toPhysical("/workspace/.codex/auth.json"),
    "/physical/local/localhost/.codex/auth.json",
  );
  assert.equal(service.defaultFilesystem(), workspace);
  assert.equal(service.filesystemForCwd("/workspace/projects/repo"), workspace);
  assert.equal(service.filesystemForRealm("localhost"), service.localFilesystem);
  assert.equal(service.backendKey("alice", workspace, "fork-7"), "alice\0workspace\0fork-7");
  assert.equal(
    service.threadBackendKey("alice", workspace, "fork-7", "thread-1", {
      fingerprint: "profile-1",
    }),
    "alice\0workspace\0fork-7\0outer:thread-1\0profile:profile-1",
  );
});

test("runtime access maps protocol paths through the selected runtime filesystem", () => {
  const { service, workspace, mapperCalls, located } = harness();
  const state = { filesystem: workspace };

  assert.deepEqual(service.toInner({ id: 1, method: "thread/read" }, state), {
    id: 1,
    method: "thread/read",
    mapped: "inner",
  });
  assert.equal(service.toPhysical("/workspace/project", state), "workspace:/workspace/project");
  assert.equal(service.toVirtual("/physical/project", state), "workspace:/physical/project");
  assert.equal(service.stateForOuter("thread-1"), located);
  assert.deepEqual(mapperCalls.map(([kind, , selected]) => [kind, selected]), [
    ["inner", workspace],
    ["physical", workspace],
    ["virtual", workspace],
  ]);
});
