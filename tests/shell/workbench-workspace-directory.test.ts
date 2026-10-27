import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isWorkspacePathWithinRoot,
  joinWorkspacePath,
  normalizeWorkspacePath,
  resolveWorkspacePickerInitialPath,
  workspaceParentPath,
} from "../../apps/workbench-web/src/components/workspace-directory-model";

test("workspace paths normalize separators and traversal before reaching AppServer", () => {
  assert.equal(
    normalizeWorkspacePath("/workspace//projects/opencraft/../opencraft/src"),
    "/workspace/projects/opencraft/src",
  );
  assert.equal(
    joinWorkspacePath("/workspace/projects/opencraft", "src/../docs"),
    "/workspace/projects/opencraft/docs",
  );
});

test("the browser picker cannot escape its AppServer project root", () => {
  const root = "/workspace/projects";
  assert.equal(isWorkspacePathWithinRoot("/workspace/projects/opencraft", root), true);
  assert.equal(isWorkspacePathWithinRoot("/workspace/projects-elsewhere", root), false);
  assert.equal(workspaceParentPath("/workspace/projects", root), root);
  assert.equal(workspaceParentPath("/workspace/projects/opencraft", root), root);
  assert.equal(workspaceParentPath("/workspace", root), root);
});

test("an outside or missing initial folder resolves to the authoritative root", () => {
  const root = "/workspace/projects";
  assert.equal(resolveWorkspacePickerInitialPath("/root", root), root);
  assert.equal(resolveWorkspacePickerInitialPath(null, root), root);
  assert.equal(
    resolveWorkspacePickerInitialPath("/workspace/projects/opencraft", root),
    "/workspace/projects/opencraft",
  );
});

test("a Linux filesystem root can contain and navigate remote project folders", () => {
  assert.equal(isWorkspacePathWithinRoot("/var/lib/opencraft/workspaces", "/"), true);
  assert.equal(resolveWorkspacePickerInitialPath("/var/lib/opencraft/workspaces", "/"), "/var/lib/opencraft/workspaces");
  assert.equal(workspaceParentPath("/var/lib", "/"), "/var");
  assert.equal(workspaceParentPath("/var", "/"), "/");
  assert.equal(workspaceParentPath("/", "/"), "/");
});

test("folder picker delegates modal and action states to shared themed controls", () => {
  const component = readFileSync(new URL("../../apps/workbench-web/src/components/workspace-directory-picker.tsx", import.meta.url), "utf8");
  const componentStyle = readFileSync(new URL("../../apps/workbench-web/src/components/workspace-directory-picker.scss", import.meta.url), "utf8");
  const appStyle = readFileSync(new URL("../../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  assert.match(component, /appearance="utility"/u);
  assert.match(component, /<Button\s+variant="primary"/u);
  assert.match(component, /<Button variant="outline"/u);
  assert.match(component, /disabled=\{phase !== "idle" \|\| error !== null \|\| !canChooseCurrentFolder\}/u);
  assert.doesNotMatch(componentStyle, /--color-background-primary\b/u);
  assert.doesNotMatch(componentStyle, /\.workspace-picker-primary\b/u);
  assert.doesNotMatch(appStyle, /\.workspace-picker-primary\b/u);
});

test("an unconfigured server browser can navigate from the filesystem root", () => {
  assert.equal(isWorkspacePathWithinRoot("/projects/sample", "/"), true);
  assert.equal(resolveWorkspacePickerInitialPath("/projects/sample", "/"), "/projects/sample");
  assert.equal(workspaceParentPath("/projects/sample", "/"), "/projects");
  assert.equal(workspaceParentPath("/projects", "/"), "/");
  assert.equal(workspaceParentPath("/", "/"), "/");
});
