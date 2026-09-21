import assert from "node:assert/strict";
import test from "node:test";

import {
  MAIN_WORKSPACE_VIEW,
  canonicalWorkspaceCwd,
  projectsRoot,
  logicalPathForView,
  rewriteWorkspaceView,
  runtimeViewId,
  storagePathForView,
  storageViewRoot,
  viewRoot,
	workspacePathBelongsToView,
  workspaceViewState,
  WORKSPACE_VIEW_ACTIVE,
  WORKSPACE_VIEW_DESTROYED,
} from "../src/services/workspace-view.js";
import {
  WorkspaceFilesystemService,
  isWorkspaceControlPath,
  workspacePhysicalPathToVirtual,
  workspaceControlPathForUser,
  workspaceControlPathInContainer,
} from "../src/services/workspace-filesystem.js";

test("new conversations anchor in the stable main projects plane", () => {
  assert.equal(projectsRoot(MAIN_WORKSPACE_VIEW), "/workspace/projects");
  assert.equal(canonicalWorkspaceCwd(), "/workspace/projects");
  assert.equal(canonicalWorkspaceCwd("/workspace/repo"), "/workspace/projects/repo");
  assert.equal(canonicalWorkspaceCwd("/workspace/@main/projects/repo"), "/workspace/projects/repo");
});

test("host Btrfs paths map back into the virtual workspace namespace", () => {
  const mount = "/data/hypernode/.runtime/workspace";
  assert.equal(
    workspacePhysicalPathToVirtual(`${mount}/@main/projects/mono2/.git`, mount),
    "/workspace/@main/projects/mono2/.git",
  );
  assert.equal(workspacePhysicalPathToVirtual(mount, mount), "/workspace");
  assert.equal(workspacePhysicalPathToVirtual("/data/hypernode", mount), "/data/hypernode");
  assert.equal(workspacePhysicalPathToVirtual(`${mount}-escape/repo`, mount), `${mount}-escape/repo`);
});

test("fork keeps one public path while storage retains the owning view", () => {
  const id = "01a03875-5a74-728c-9eed-34506d7c2ac0";
  assert.equal(viewRoot(id), "/workspace");
  assert.equal(storageViewRoot(id), `/workspace/@fork-${id}`);
  assert.equal(
    rewriteWorkspaceView("/workspace/@main/projects/polaris/src", "main", id),
    "/workspace/projects/polaris/src",
  );
  assert.equal(
    storagePathForView("/workspace/projects/polaris/src", id),
    `/workspace/@fork-${id}/projects/polaris/src`,
  );
  assert.equal(
    logicalPathForView(`/workspace/@fork-${id}/projects/polaris/src`, id),
    "/workspace/projects/polaris/src",
  );
  assert.equal(
    logicalPathForView("/workspace/@main/projects/polaris/src", id),
    "/workspace/projects/polaris/src",
  );
  assert.equal(
    storagePathForView("/workspace/@main/projects/polaris/src", id),
    `/workspace/@fork-${id}/projects/polaris/src`,
  );
  assert.equal(
    storagePathForView(`/workspace/@fork-stale/projects/polaris/src`, id),
    `/workspace/@fork-${id}/projects/polaris/src`,
  );
});

test("workspace v2 gives every durable Thread an independent runtime and lease identity", () => {
  assert.equal(runtimeViewId(true, "root-thread", { kind: "main", viewId: "main" }), "root-thread");
  assert.equal(runtimeViewId(true, "ordinary-thread", null), "ordinary-thread");
  assert.equal(runtimeViewId(true, "side-chat", { kind: "shared", viewId: "ordinary-thread" }), "ordinary-thread");
  assert.equal(runtimeViewId(false, "legacy-thread", { kind: "main", viewId: "main" }), "main");
});

test("backend request projection canonicalizes stale Desktop view aliases", () => {
  const filesystem = Object.create(WorkspaceFilesystemService.prototype);
  filesystem.enabled = true;
  assert.equal(
    filesystem.toPhysical("/workspace/@main/projects/mono2", null, "fork-current"),
    "/workspace/projects/mono2",
  );
  assert.equal(
    filesystem.toPhysical("/workspace/@fork-stale/projects/mono2", null, "main"),
    "/workspace/projects/mono2",
  );
});

test("workspace watches share one native inotify source and fan out changes", () => {
  const calls = { watch: [], drain: [], unwatch: [] };
  const previous = globalThis.hostWorkspaces;
  globalThis.hostWorkspaces = {
    enabled: true,
    root: () => ({ threadId: "management-root" }),
    watch: (id, capabilityId, path) => calls.watch.push([id, capabilityId, path]),
    drainWatch: (id) => {
      calls.drain.push(id);
      return calls.drain.length === 1 ? ["/workspace/@main/projects/mono2/file.txt"] : [];
    },
    unwatch: (id) => calls.unwatch.push(id),
  };
  try {
    const filesystem = Object.create(WorkspaceFilesystemService.prototype);
    filesystem.watchSequence = 0;
    filesystem.watchEntries = new Map();
    filesystem.watchConsumers = new Map();
    filesystem.v2 = true;
    filesystem.v2Attachments = new Map();
    filesystem.ctx = {
      workspaceAttachment: {
        attach: () => ({ capabilityId: "root-capability", detach() {} }),
      },
    };
    filesystem.watch("desktop-a", "/workspace/projects/mono2", "main");
    filesystem.watch("desktop-b", "/workspace/@main/projects/mono2", "main");
    assert.equal(calls.watch.length, 1);
    assert.deepEqual(filesystem.drainWatch("desktop-a"), ["/workspace/projects/mono2/file.txt"]);
    assert.deepEqual(filesystem.drainWatch("desktop-b"), ["/workspace/projects/mono2/file.txt"]);
    filesystem.unwatch("desktop-a");
    assert.equal(calls.unwatch.length, 0);
    filesystem.unwatch("desktop-b");
    assert.deepEqual(calls.unwatch, [calls.watch[0][0]]);
  } finally {
    globalThis.hostWorkspaces = previous;
  }
});

test("logical view mapping leaves non-path protocol strings untouched", () => {
  assert.equal(logicalPathForView("process/exited", "fork-a"), "process/exited");
  assert.equal(logicalPathForView("workspace output", "fork-a"), "workspace output");
  assert.equal(logicalPathForView("", "fork-a"), "");
});

test("public write paths reject physical views while the input boundary accepts stale aliases", () => {
  assert.equal(workspacePathBelongsToView("/workspace/projects/repo", "main"), true);
  assert.equal(workspacePathBelongsToView("/workspace/@main/projects/repo", "main"), false);
  assert.equal(workspacePathBelongsToView("/workspace/@fork-other/projects/repo", "main"), false);
  assert.equal(workspacePathBelongsToView("/workspace/@main-escape", "main"), false);
  assert.equal(
    storagePathForView("/workspace/@fork-other/projects/repo", "main"),
    "/workspace/@main/projects/repo",
  );
  assert.throws(() => storagePathForView("/workspace/@main-escape/projects/repo", "main"));
});

test("the advertised Codex home is user state, not a forkable project view", () => {
  const visualization = "/workspace/.codex/visualizations/2026/08/26/thread/chart.html";
  assert.equal(isWorkspaceControlPath(visualization), true);
  assert.equal(
    workspaceControlPathForUser(visualization),
    "/localhost/.codex/visualizations/2026/08/26/thread/chart.html",
  );
  assert.equal(isWorkspaceControlPath("/workspace/projects/.codex/config.toml"), false);
  assert.equal(isWorkspaceControlPath("/data/hypernode/.git"), false);
  assert.equal(
    workspaceControlPathInContainer(visualization, {
      homePath: "/data/hypernode/.runtime/users/alice-2bd806c97f",
    }),
    "/run/hypernode-users/alice-2bd806c97f/.codex/visualizations/2026/08/26/thread/chart.html",
  );
});

test("the advertised Codex home remains a control path without a Docker workspace", () => {
  const filesystem = Object.create(WorkspaceFilesystemService.prototype);
  filesystem.enabled = false;
  assert.equal(filesystem.owns("/workspace/.codex/visualizations/thread/chart.html"), false);
  assert.equal(filesystem.ownsControlPath("/workspace/.codex/visualizations/thread/chart.html"), true);
  assert.equal(filesystem.owns("/workspace/projects/repo"), false);
});

test("workspace view lifecycle migrates deleted records into an explicit destroyed state", () => {
  assert.equal(workspaceViewState(null), WORKSPACE_VIEW_ACTIVE);
  assert.equal(workspaceViewState({ deleted: false }), WORKSPACE_VIEW_ACTIVE);
  assert.equal(workspaceViewState({ deleted: true }), WORKSPACE_VIEW_DESTROYED);
  assert.equal(workspaceViewState({ state: WORKSPACE_VIEW_DESTROYED, deleted: false }), WORKSPACE_VIEW_DESTROYED);
});
