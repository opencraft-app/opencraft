import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("a Linux filesystem root can contain and navigate remote project folders", () => {
  assert.equal(isWorkspacePathWithinRoot("/var/lib/opencraft/workspaces", "/"), true);
  assert.equal(resolveWorkspacePickerInitialPath("/var/lib/opencraft/workspaces", "/"), "/var/lib/opencraft/workspaces");
  assert.equal(workspaceParentPath("/var/lib", "/"), "/var");
  assert.equal(workspaceParentPath("/var", "/"), "/");
  assert.equal(workspaceParentPath("/", "/"), "/");
});

test("folder picker delegates modal and action states to shared themed controls", () => {
  const component = readFileSync(new URL("../apps/workbench-web/src/components/workspace-directory-picker.tsx", import.meta.url), "utf8");
  const componentStyle = readFileSync(new URL("../apps/workbench-web/src/components/workspace-directory-picker.scss", import.meta.url), "utf8");
  const appStyle = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  assert.match(component, /appearance="utility"/u);
  assert.match(component, /<Button\s+variant="primary"/u);
  assert.match(component, /<Button variant="outline"/u);
  assert.match(component, /disabled=\{phase !== "idle" \|\| error !== null \|\| !canChooseCurrentFolder\}/u);
  assert.doesNotMatch(componentStyle, /--color-background-primary\b/u);
  assert.doesNotMatch(componentStyle, /\.workspace-picker-primary\b/u);
  assert.doesNotMatch(appStyle, /\.workspace-picker-primary\b/u);
});
