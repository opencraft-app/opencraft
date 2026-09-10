import assert from "node:assert/strict";
import test from "node:test";

import type { Project } from "@opencraft/appserver-protocol/generated/v2";

import {
  buildDraftWorkspaceOptions,
  resolveProjectCwd,
  searchDraftWorkspaceOptions,
} from "../apps/workbench-web/src/runtime/draft-workspace-model";

const project: Project = {
  id: "project:multi-root",
  name: "Monorepo",
  roots: [{ path: "/repo/client" }, { path: "/repo/server" }],
  metadata: { branch: "feature/draft-session" },
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};

test("every Project root is a selectable cwd without losing the aggregate root set", () => {
  const options = buildDraftWorkspaceOptions([project]);
  assert.deepEqual(options.map((option) => option.cwd), ["/repo/client", "/repo/server"]);
  assert.deepEqual(options[1]?.runtimeWorkspaceRoots, ["/repo/client", "/repo/server"]);
  assert.equal(options[1]?.projectId, project.id);
  assert.equal(options[1]?.branch, "feature/draft-session");
  assert.equal(options[1]?.rootLabel, "server");
});

test("Project search uses deterministic fuzzy ordering across names, roots and paths", () => {
  const options = buildDraftWorkspaceOptions([
    project,
    {
      ...project,
      id: "project:docs",
      name: "Documentation",
      roots: [{ path: "/repo/guides" }],
      position: 1,
    },
  ]);
  assert.deepEqual(
    searchDraftWorkspaceOptions(options, "srv").map((option) => option.cwd),
    ["/repo/server"],
  );
  assert.deepEqual(
    searchDraftWorkspaceOptions(options, "doc").map((option) => option.cwd),
    ["/repo/guides"],
  );
});

test("directory selection preserves a requested secondary Project root", () => {
  assert.equal(resolveProjectCwd(project, "/repo/server"), "/repo/server");
  assert.equal(resolveProjectCwd(project, "/repo/unknown"), "/repo/client");
  assert.throws(() => resolveProjectCwd({ ...project, roots: [] }, "/repo"), /no workspace root/u);
});
