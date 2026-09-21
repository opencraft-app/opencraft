import assert from "node:assert/strict";
import test from "node:test";

import {
  isWorkspacePathWithinRoot,
  joinWorkspacePath,
  normalizeWorkspacePath,
  resolveWorkspacePickerInitialPath,
  workspaceParentPath,
} from "../apps/workbench-web/src/components/workspace-directory-model";

test("workspace paths normalize separators and traversal before reaching AppServer", () => {
  assert.equal(
    normalizeWorkspacePath("/workspace//projects/mono2/../mono2/src"),
    "/workspace/projects/mono2/src",
  );
  assert.equal(
    joinWorkspacePath("/workspace/projects/mono2", "src/../docs"),
    "/workspace/projects/mono2/docs",
  );
});

test("the browser picker cannot escape its AppServer project root", () => {
  const root = "/workspace/projects";
  assert.equal(isWorkspacePathWithinRoot("/workspace/projects/mono2", root), true);
  assert.equal(isWorkspacePathWithinRoot("/workspace/projects-elsewhere", root), false);
  assert.equal(workspaceParentPath("/workspace/projects", root), root);
  assert.equal(workspaceParentPath("/workspace/projects/mono2", root), root);
  assert.equal(workspaceParentPath("/workspace", root), root);
});

test("an outside or missing initial folder resolves to the authoritative root", () => {
  const root = "/workspace/projects";
  assert.equal(resolveWorkspacePickerInitialPath("/root", root), root);
  assert.equal(resolveWorkspacePickerInitialPath(null, root), root);
  assert.equal(
    resolveWorkspacePickerInitialPath("/workspace/projects/mono2", root),
    "/workspace/projects/mono2",
  );
});
